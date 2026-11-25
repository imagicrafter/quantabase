"""Distillation model evaluation harness.

Freezes a fixed candidate set, runs it through several model "arms" (DO
open-weight models plus the current agent/Sonnet baseline), and scores every
reply with the SAME production code the live pipeline uses --
`distill.parse()` and `distill.verify_terms()`. It invents no scoring of its
own; see `distill.py`'s module docstring for why fabrication-checking must
stay a single implementation.

Usage:

    # 1. Freeze a reproducible candidate set (writes candidates.json).
    ../.venv/bin/python -m knowledge.model_eval --freeze 25

    # 2. Run all four arms against it (writes results.json, report.md,
    #    blind-samples.md, blind-key.txt under outputs/knowledge/model-eval/).
    ../.venv/bin/python -m knowledge.model_eval --run

    # A specific subset of arms:
    ../.venv/bin/python -m knowledge.model_eval --run --arms gpt-oss-20b,agent_sdk
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any

from .config import domains as configured_domains, WORKSPACE_ROOT
from .distill import (
    MAX_SOURCE_CHARS,
    DistillationError,
    build_prompt,
    parse,
)
from .model_backends import ModelReply, call_model
from .supabase_client import get_supabase
from .triage import triage
from .kb_schema import db

OUTPUT_DIR = WORKSPACE_ROOT / "outputs" / "knowledge" / "model-eval"
RUNS_DIR = WORKSPACE_ROOT / "outputs" / "knowledge" / "runs"
CANDIDATES_PATH = OUTPUT_DIR / "candidates.json"

PAGE_SIZE = 500
DEFAULT_MAX_DOCS = 25
CONFIRM_THRESHOLD = 50
MIN_CAPPED_DOCS = 5

# Measured against the live corpus 2026-08-23 (see the plan). Used only to
# state a full-corpus cost projection alongside the frozen-set actual cost --
# never as a substitute for it.
FULL_CORPUS_DOCS = 1_002

# $ per million tokens. Source: DO inference pricing docs + Anthropic pricing,
# recorded in plans/2026-08-23-distiller-model-eval-harness.md.
ARMS: dict[str, dict[str, Any]] = {
    "gpt-oss-120b": {
        "backend": "do",
        "model": "openai-gpt-oss-120b",
        "in_per_m": 0.10,
        "out_per_m": 0.70,
    },
    "gpt-oss-20b": {
        "backend": "do",
        "model": "openai-gpt-oss-20b",
        "in_per_m": 0.05,
        "out_per_m": 0.45,
    },
    "gemma-4": {
        "backend": "do",
        "model": "gemma-4-31B-it",
        "in_per_m": 0.18,
        "out_per_m": 0.50,
    },
    "haiku-4.5": {
        "backend": "do",
        "model": "anthropic-claude-haiku-4.5",
        "in_per_m": 1.00,
        "out_per_m": 5.00,
    },
    "agent_sdk": {
        "backend": "agent_sdk",
        "model": "sonnet",
        "in_per_m": 2.00,
        "out_per_m": 10.00,
    },
}
DEFAULT_ARMS = ("gpt-oss-120b", "gpt-oss-20b", "gemma-4", "agent_sdk")
BASELINE_ARM = "agent_sdk"

# Step 2 of the plan -- written down before any arm ran. Do not adjust after
# seeing results.
DECISION_RULE = {
    "json_ok_min": 0.96,
    "hard_fail_max": 0,
    "fabrication_rate_max_multiplier": 1.5,
    "terms_kept_min_multiplier": 0.70,
    "bad_label_max_delta_pp": 5.0,
}


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")


# ---------------------------------------------------------------------------
# Freeze


def _fetch_rows(sb) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        resp = (
            db(sb)
            .table("documents")
            .select(
                "id, source, external_id, title, body, metadata, "
                "parent_external_id, source_created_at"
            )
            .is_("deleted_at", "null")
            .range(offset, offset + PAGE_SIZE - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def _candidate_dict(candidate) -> dict:
    return {
        "doc_id": candidate.doc_id,
        "source": candidate.source,
        "external_id": candidate.external_id,
        "title": candidate.title,
        "body": candidate.body,
        "location": candidate.location,
        "kind": candidate.kind,
    }


def freeze(max_docs: int) -> None:
    """Select a fixed, reproducible candidate set and write candidates.json.

    Stratified: at least MIN_CAPPED_DOCS candidates that hit MAX_SOURCE_CHARS,
    so the long-input truncation case is represented rather than accidentally
    excluded by pure priority order.
    """
    sb = get_supabase()
    rows = _fetch_rows(sb)
    result = triage(rows)
    ordered = result.candidates  # already priority-sorted, deterministic

    capped = [c for c in ordered if len(c.body) >= MAX_SOURCE_CHARS]
    reserve_target = min(MIN_CAPPED_DOCS, max_docs)
    reserved = capped[:reserve_target]
    reserved_ids = {c.doc_id for c in reserved}

    remaining_slots = max(0, max_docs - len(reserved))
    filler = [c for c in ordered if c.doc_id not in reserved_ids][:remaining_slots]

    selected = reserved + filler
    if len(reserved) < reserve_target:
        print(
            f"[freeze] WARNING: only {len(reserved)} documents hit the "
            f"{MAX_SOURCE_CHARS}-char cap in the live corpus; wanted "
            f"{reserve_target}",
            file=sys.stderr,
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = [_candidate_dict(c) for c in selected]
    CANDIDATES_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"[freeze] documents scanned: {len(rows)}")
    print(f"[freeze] candidates frozen: {len(selected)} ({len(reserved)} at the char cap)")
    print(f"[freeze] wrote {CANDIDATES_PATH}")


# ---------------------------------------------------------------------------
# Scoring -- reuses distill.parse / distill.verify_terms verbatim


def _extract_json_object(raw: str) -> str:
    """Tolerate fenced or prose-wrapped replies, same as the production path
    in workflows/distil_candidates.py. If nothing extractable is found,
    the original text is returned unchanged so json.loads fails naturally."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[: -len("```")]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return text
    return text[start : end + 1]


def _score_reply(candidate: dict, reply: ModelReply) -> dict[str, Any]:
    """One document's scored result. Never raises -- a bad reply is data."""
    if reply.error:
        return {
            "json_ok": False,
            "hard_fail": False,
            "terms_proposed": 0,
            "terms_kept": 0,
            "terms_rejected": 0,
            "bad_label": False,
            "what": None,
            "why": None,
            "error": reply.error,
        }

    extracted = _extract_json_object(reply.text)
    try:
        payload = json.loads(extracted)
    except json.JSONDecodeError as error:
        return {
            "json_ok": False,
            "hard_fail": False,
            "terms_proposed": 0,
            "terms_kept": 0,
            "terms_rejected": 0,
            "bad_label": False,
            "what": None,
            "why": None,
            "error": f"not valid JSON: {error}",
        }
    if not isinstance(payload, dict):
        return {
            "json_ok": False,
            "hard_fail": False,
            "terms_proposed": 0,
            "terms_kept": 0,
            "terms_rejected": 0,
            "bad_label": False,
            "what": None,
            "why": None,
            "error": f"expected an object, got {type(payload).__name__}",
        }

    raw_label = payload.get("proposed_label")
    raw_label = str(raw_label).strip() if raw_label else None
    bad_label = bool(raw_label) and raw_label not in configured_domains()

    raw_terms = payload.get("terms")
    terms_proposed = len(raw_terms) if isinstance(raw_terms, list) else 0

    try:
        distillation, rejected = parse(payload, candidate["body"])
    except DistillationError as error:
        return {
            "json_ok": True,
            "hard_fail": True,
            "terms_proposed": terms_proposed,
            "terms_kept": 0,
            "terms_rejected": 0,
            "bad_label": bad_label,
            "what": None,
            "why": None,
            "error": str(error),
        }

    return {
        "json_ok": True,
        "hard_fail": False,
        "terms_proposed": terms_proposed,
        "terms_kept": len(distillation.terms),
        "terms_rejected": len(rejected),
        "bad_label": bad_label,
        "what": distillation.what,
        "why": distillation.why,
        "error": None,
    }


def _estimate_cost(reply: ModelReply, arm: dict[str, Any]) -> float:
    input_tokens = reply.input_tokens or 0
    output_tokens = reply.output_tokens or 0
    return (input_tokens / 1_000_000) * arm["in_per_m"] + (
        output_tokens / 1_000_000
    ) * arm["out_per_m"]


# ---------------------------------------------------------------------------
# Run


def run_arms(candidates: list[dict], arm_names: list[str]) -> list[dict[str, Any]]:
    """Every (arm x candidate) record. One retry on unparseable JSON only.

    A backend or scoring failure for one document never aborts the arm --
    the record just carries the error.
    """
    records: list[dict[str, Any]] = []
    for arm_name in arm_names:
        arm = ARMS[arm_name]
        for index, candidate in enumerate(candidates, start=1):
            prompt = build_prompt(
                title=candidate["title"],
                body=candidate["body"],
                source=candidate["source"],
                location=candidate["location"],
                kind=candidate["kind"],
            )
            reply = call_model(prompt, backend=arm["backend"], model=arm["model"])
            score = _score_reply(candidate, reply)
            retried = False
            if not score["json_ok"]:
                reply = call_model(prompt, backend=arm["backend"], model=arm["model"])
                score = _score_reply(candidate, reply)
                retried = True

            records.append(
                {
                    "arm": arm_name,
                    "doc_id": candidate["doc_id"],
                    "source": candidate["source"],
                    "retried": retried,
                    "used_json_mode": reply.used_json_mode,
                    "tokens_estimated": reply.tokens_estimated,
                    "input_tokens": reply.input_tokens,
                    "output_tokens": reply.output_tokens,
                    "latency_ms": reply.latency_ms,
                    "cost_usd": _estimate_cost(reply, arm),
                    **score,
                }
            )
            print(
                f"[run] {arm_name} {index}/{len(candidates)} "
                f"doc={candidate['doc_id'][:8]} json_ok={score['json_ok']} "
                f"hard_fail={score['hard_fail']}"
            )
    return records


# ---------------------------------------------------------------------------
# Aggregation and the decision rule


def _aggregate(records: list[dict[str, Any]], arm_name: str) -> dict[str, Any]:
    arm_records = [r for r in records if r["arm"] == arm_name]
    n = len(arm_records)
    if n == 0:
        raise ValueError(f"no records for arm {arm_name!r}")

    json_ok_rate = sum(1 for r in arm_records if r["json_ok"]) / n
    hard_fails = sum(1 for r in arm_records if r["hard_fail"])
    terms_proposed_total = sum(r["terms_proposed"] for r in arm_records)
    terms_rejected_total = sum(r["terms_rejected"] for r in arm_records)
    fabrication_rate = (
        terms_rejected_total / terms_proposed_total if terms_proposed_total else 0.0
    )
    terms_kept_avg = mean(r["terms_kept"] for r in arm_records)
    bad_label_rate = sum(1 for r in arm_records if r["bad_label"]) / n
    avg_cost_per_doc = mean(r["cost_usd"] for r in arm_records)
    avg_latency_ms = mean(r["latency_ms"] for r in arm_records)
    any_tokens_estimated = any(r["tokens_estimated"] for r in arm_records)

    return {
        "arm": arm_name,
        "n": n,
        "json_ok_rate": json_ok_rate,
        "hard_fails": hard_fails,
        "fabrication_rate": fabrication_rate,
        "terms_kept_avg": terms_kept_avg,
        "bad_label_rate": bad_label_rate,
        "avg_cost_per_doc": avg_cost_per_doc,
        "full_corpus_cost": avg_cost_per_doc * FULL_CORPUS_DOCS,
        "avg_latency_ms": avg_latency_ms,
        "tokens_estimated": any_tokens_estimated,
    }


def _evaluate_rule(candidate_agg: dict[str, Any], baseline_agg: dict[str, Any]) -> dict[str, Any]:
    checks = {
        "json_ok": candidate_agg["json_ok_rate"] >= DECISION_RULE["json_ok_min"],
        "hard_fails": candidate_agg["hard_fails"] <= DECISION_RULE["hard_fail_max"],
        "fabrication_rate": candidate_agg["fabrication_rate"]
        <= baseline_agg["fabrication_rate"] * DECISION_RULE["fabrication_rate_max_multiplier"],
        "terms_kept": candidate_agg["terms_kept_avg"]
        >= baseline_agg["terms_kept_avg"] * DECISION_RULE["terms_kept_min_multiplier"],
        "bad_label": (candidate_agg["bad_label_rate"] - baseline_agg["bad_label_rate"]) * 100
        <= DECISION_RULE["bad_label_max_delta_pp"],
    }
    return {"passed": all(checks.values()), "checks": checks}


# ---------------------------------------------------------------------------
# Report artifacts


def _write_report(
    aggregates: dict[str, dict[str, Any]],
    verdicts: dict[str, dict[str, Any]],
    n_docs: int,
    n_capped: int,
    destination: Path,
) -> None:
    lines = [
        "# Distillation model evaluation",
        "",
        f"Frozen set: {n_docs} documents, {n_capped} at the {MAX_SOURCE_CHARS}-char cap.",
        f"Baseline arm: `{BASELINE_ARM}`.",
        "",
        "| arm | JSON ok | hard fails | fabricated-term rate | terms kept/doc | "
        "bad label rate | $ / corpus | avg latency ms |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for arm_name, agg in aggregates.items():
        est = " (est.)" if agg["tokens_estimated"] else ""
        lines.append(
            f"| {arm_name} | {agg['json_ok_rate']:.1%} | {agg['hard_fails']} | "
            f"{agg['fabrication_rate']:.1%} | {agg['terms_kept_avg']:.2f} | "
            f"{agg['bad_label_rate']:.1%} | ${agg['full_corpus_cost']:.2f}{est} | "
            f"{agg['avg_latency_ms']:.0f} |"
        )

    lines += ["", "## Pass/fail vs the decision rule (written before this run)", ""]
    for arm_name, verdict in verdicts.items():
        status = "PASS" if verdict["passed"] else "FAIL"
        lines.append(f"- **{arm_name}: {status}**")
        for check, ok in verdict["checks"].items():
            lines.append(f"  - {check}: {'ok' if ok else 'FAILED'}")

    passing = [
        name
        for name, v in verdicts.items()
        if v["passed"] and name != BASELINE_ARM
    ]
    lines += ["", "## Recommendation", ""]
    if passing:
        cheapest = min(passing, key=lambda name: aggregates[name]["full_corpus_cost"])
        lines.append(
            f"**{cheapest}** — cheapest model passing the decision rule "
            f"(${aggregates[cheapest]['full_corpus_cost']:.2f} per corpus)."
        )
    else:
        lines.append(
            "No candidate model passed. Fallback per the plan: add a "
            "`haiku-4.5` arm and re-run (`--arms haiku-4.5,agent_sdk`)."
        )

    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_blind_samples(
    records: list[dict[str, Any]],
    candidates: list[dict],
    arm_names: list[str],
    samples_path: Path,
    key_path: Path,
) -> None:
    letters = [chr(ord("A") + i) for i in range(len(arm_names))]
    key = dict(zip(letters, sorted(arm_names)))
    reverse_key = {v: k for k, v in key.items()}

    sample_doc_ids = [c["doc_id"] for c in candidates[:5]]
    by_doc_arm = {(r["doc_id"], r["arm"]): r for r in records}

    lines = ["# Blind distillation samples", "", "Model identities hidden -- see blind-key.txt.", ""]
    for doc_id in sample_doc_ids:
        title = next((c["title"] for c in candidates if c["doc_id"] == doc_id), doc_id)
        lines.append(f"## {title}")
        lines.append("")
        for arm_name in sorted(arm_names):
            record = by_doc_arm.get((doc_id, arm_name))
            letter = reverse_key[arm_name]
            if record is None or not record.get("what"):
                lines.append(f"**{letter}:** (no usable output)")
                continue
            lines.append(f"**{letter}:** {record['what']} {record.get('why') or ''}")
        lines.append("")

    samples_path.write_text("\n".join(lines), encoding="utf-8")
    key_path.write_text(
        "\n".join(f"{letter} = {arm}" for letter, arm in sorted(key.items())) + "\n",
        encoding="utf-8",
    )


def _write_receipt(timestamp: str, aggregates: dict[str, dict[str, Any]], report_path: Path) -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    lines = [f"# model-eval — {timestamp}", ""]
    total_cost = sum(a["avg_cost_per_doc"] * a["n"] for a in aggregates.values())
    lines.append(f"Actual spend this run: ${total_cost:.4f}")
    lines.append(f"Report: {report_path.relative_to(WORKSPACE_ROOT)}")
    (RUNS_DIR / f"{timestamp}-model-eval.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


class SpendCapExceeded(RuntimeError):
    """--max-docs / --confirm refused this run before any model was called."""


def select_for_run(candidates: list[dict], max_docs: int, confirm: bool) -> list[dict]:
    """Apply the hard spend cap. Pure function so the cap logic is testable
    without a network call: `model_eval_test.py` exercises this directly."""
    if len(candidates) > max_docs:
        if len(candidates) > CONFIRM_THRESHOLD and not confirm:
            raise SpendCapExceeded(
                f"{len(candidates)} candidates exceeds the confirm threshold "
                f"({CONFIRM_THRESHOLD}); pass --confirm to proceed"
            )
        return candidates[:max_docs]
    return candidates


def run(arm_names: list[str], max_docs: int, confirm: bool) -> None:
    if not CANDIDATES_PATH.exists():
        print(f"[run] no candidates.json at {CANDIDATES_PATH} -- run --freeze first", file=sys.stderr)
        raise SystemExit(1)

    candidates = json.loads(CANDIDATES_PATH.read_text(encoding="utf-8"))
    try:
        candidates = select_for_run(candidates, max_docs, confirm)
    except SpendCapExceeded as error:
        print(f"[run] {error}", file=sys.stderr)
        raise SystemExit(1) from error

    n_capped = sum(1 for c in candidates if len(c["body"]) >= MAX_SOURCE_CHARS)
    est_input_tokens = sum(len(c["body"]) for c in candidates) // 4
    est_cost = sum(
        (est_input_tokens / len(candidates) / 1_000_000) * ARMS[a]["in_per_m"]
        * len(candidates)
        for a in arm_names
    )
    print(f"[run] {len(candidates)} candidates x {len(arm_names)} arms, est. ${est_cost:.4f}")

    records = run_arms(candidates, arm_names)

    if BASELINE_ARM not in arm_names:
        print(
            f"[run] WARNING: baseline arm {BASELINE_ARM!r} not run -- decision "
            "rule cannot be evaluated, only raw metrics reported",
            file=sys.stderr,
        )
        aggregates = {name: _aggregate(records, name) for name in arm_names}
        verdicts = {}
    else:
        aggregates = {name: _aggregate(records, name) for name in arm_names}
        baseline_agg = aggregates[BASELINE_ARM]
        verdicts = {
            name: _evaluate_rule(agg, baseline_agg)
            for name, agg in aggregates.items()
        }

    timestamp = _utc_timestamp()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results_path = OUTPUT_DIR / f"{timestamp}-results.json"
    report_path = OUTPUT_DIR / f"{timestamp}-report.md"
    samples_path = OUTPUT_DIR / f"{timestamp}-blind-samples.md"
    key_path = OUTPUT_DIR / f"{timestamp}-blind-key.txt"

    results_path.write_text(json.dumps(records, indent=2), encoding="utf-8")
    _write_report(aggregates, verdicts, len(candidates), n_capped, report_path)
    _write_blind_samples(records, candidates, arm_names, samples_path, key_path)
    _write_receipt(timestamp, aggregates, report_path)

    actual_cost = sum(r["cost_usd"] for r in records)
    print(f"[run] wrote {results_path}")
    print(f"[run] wrote {report_path}")
    print(f"[run] actual spend: ${actual_cost:.4f}")


# ---------------------------------------------------------------------------
# CLI


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--freeze", type=int, metavar="N", help="freeze N candidates")
    parser.add_argument("--run", action="store_true", help="run arms against the frozen set")
    parser.add_argument(
        "--arms",
        default=",".join(DEFAULT_ARMS),
        help=f"comma-separated arm names (choose from {sorted(ARMS)})",
    )
    parser.add_argument("--max-docs", type=int, default=DEFAULT_MAX_DOCS)
    parser.add_argument(
        "--confirm", action="store_true", help=f"required to exceed {CONFIRM_THRESHOLD} docs"
    )
    args = parser.parse_args()

    if not args.freeze and not args.run:
        parser.error("pass --freeze N and/or --run")

    if args.freeze:
        freeze(args.freeze)

    if args.run:
        arm_names = [a.strip() for a in args.arms.split(",") if a.strip()]
        unknown = [a for a in arm_names if a not in ARMS]
        if unknown:
            parser.error(f"unknown arm(s) {unknown}; choose from {sorted(ARMS)}")
        run(arm_names, args.max_docs, args.confirm)

    return 0


if __name__ == "__main__":
    sys.exit(main())
