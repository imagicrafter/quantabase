#!/usr/bin/env python3
"""Shared puller pipeline -- the only entry point.

    python -m pullers.runner --source <name>

Same pipeline for every registered source, run entirely under the
`kb_ingest` role (never the service-role key -- see
`knowledge.supabase_client.get_supabase_ingest`):

    1. acquire the per-source connector lock (stand down quietly if held)
    2. read the stored cursor
    3. puller.fetch(cursor, sb=sb)              -- source-specific
    4. bronze.capture() for each built Document, when puller.BRONZE is True
       (bronzed AFTER to_document(), not before -- see the note below)
    5. puller.to_document(raw) for each raw payload; a raw the puller raises
       `SkipPayload` for is dropped and recorded in the receipt so one empty
       payload cannot wedge the cursor (incremental sources only -- see
       `build_documents`)
    6. ingest.upsert(docs, source=..., full_sync=puller.FULL_SYNC, sb=sb)
    7. triage -> distil -> apply, for THIS source's rows only
    8. review_queue.build_batch() -- appends this source's newly-distilled
       rows to the shared queue
    9. write the cursor `fetch()` returned, clear the lock, write a receipt

    Ordering note: `review_apply.apply_pending()` runs before
    `review_queue.build_batch()` (manual Section 14.4) -- decisions from
    earlier batches must land before a new batch draws from the same pool.

**Step 4/5 ordering vs. the puller contract:** `Puller.fetch()` returns raw
payloads and `to_document()` converts them, but bronze capture here runs
AFTER conversion, using the built Document's `body`/`metadata` -- not the
raw payload directly. This matches the precedent already in production
(`workflows/capture_sources.py::_capture_bronze`, which bronzes
`document.body`, not a raw API response) and avoids inventing a second
raw-to-text step per source. A puller with `BRONZE = True` (drive,
fireflies) gets one `bronze.capture()` call per document; `wiki` (git is the
bronze layer) and `gmail` (mail must leave the database when its label is
removed, and raw captures are never deleted) set `BRONZE = False`.

Two optional per-source hooks, both used by gmail:
  * `enabled()` -- a source the Engine config turns off does not run at all.
  * `confirm_absent(documents, sb)` -- ids the source has checked are really
    gone, so a full sync may tombstone them without tripping the guard.

One source's failure must not touch another's. `main()` runs each requested
source in its own try/except and reports; exits non-zero if any failed, so
cron surfaces it, but successful sources are already committed.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from knowledge import bronze, cursors, ingest, issues, review_apply, review_queue  # noqa: E402
from knowledge.contract import Document, embed_hash_for, embed_text_for  # noqa: E402
from knowledge.distill import (  # noqa: E402
    DISTILLER_VERSION,
    DistillationError,
    content_hash,
    parse as parse_distillation,
)
from knowledge.embedder import embed_texts  # noqa: E402
from knowledge.labels import arbitrate  # noqa: E402
from knowledge.model_client import DistillCallError, distil_document, model_label  # noqa: E402
from knowledge.supabase_client import get_supabase_ingest  # noqa: E402
from knowledge import triage as triage_module  # noqa: E402

from pullers.base import SkipPayload  # noqa: E402
from pullers import access_gate  # noqa: E402
from pullers import drive as puller_drive  # noqa: E402
from pullers import fireflies as puller_fireflies  # noqa: E402
from pullers import gmail as puller_gmail  # noqa: E402
from pullers import run_events  # noqa: E402
from pullers import run_issues  # noqa: E402
from pullers import tag_issues  # noqa: E402
from pullers import wiki as puller_wiki  # noqa: E402
from knowledge.kb_schema import db

REGISTRY = {
    "wiki": puller_wiki,
    "drive": puller_drive,
    "fireflies": puller_fireflies,
    "gmail": puller_gmail,
}

LOCK_TTL_SECONDS = 3600
# Matched to the agent host default -- see review_queue.DEFAULT_BATCH_SIZE's own
# comment on why the distil cap and the review batch size must move together.
DEFAULT_DISTIL_CAP = 40
MAX_FABRICATED_RATIO = 0.5
# A few empty Fireflies transcripts are skipped and recorded, but a run that
# skips more than this is hitting something systemic and must fail loudly.
MAX_SKIPPED_PER_RUN = 5


class RunnerError(RuntimeError):
    """A source's run could not complete."""


@dataclass
class SourceReceipt:
    source: str
    ok: bool = False
    stood_down: bool = False
    ingest: dict = field(default_factory=dict)
    distilled: int = 0
    distil_failed: int = 0
    review_queued: int = 0
    hook: dict = field(default_factory=dict)
    skipped: list = field(default_factory=list)
    error: str | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bronze_capture(puller, documents: list[Document], sb) -> None:
    if not getattr(puller, "BRONZE", False):
        return
    for document in documents:
        try:
            bronze.capture(
                source=puller.SOURCE,
                external_id=document.external_id,
                raw_text=document.body,
                raw_metadata=dict(document.metadata or {}),
                sb=sb,
            )
        except Exception:  # noqa: BLE001 -- one row must not end the batch
            traceback.print_exc()


def _triage_and_distil(source: str, sb, max_candidates: int) -> tuple[int, int]:
    """Triage this source's rows, distil the top candidates, apply results.

    Runs entirely against `documents` rows already committed by `ingest`
    above -- re-fetches from the DB rather than trusting anything held in
    memory from step 6, same discipline `apply_distillations.py` already
    uses. Returns (distilled, failed).
    """
    resp = (
        db(sb)
        .table("documents")
        .select(
            "id, source, external_id, title, body, tier, domains, "
            "parent_external_id, metadata, label_source, source_created_at"
        )
        .eq("source", source)
        .is_("deleted_at", "null")
        .execute()
    )
    rows = resp.data or []

    excluded_resp = (
        db(sb)
        .table("distillation_rejections")
        .select("source, external_id, content_hash")
        .eq("source", source)
        .eq("action", "exclude")
        .execute()
    )
    excluded_keys = frozenset(
        (row["source"], row["external_id"], row["content_hash"])
        for row in (excluded_resp.data or [])
    )

    result = triage_module.triage(rows, excluded_keys=excluded_keys)
    candidates = result.candidates[:max_candidates]

    by_id = {row["id"]: row for row in rows}
    distilled = 0
    failed = 0

    for candidate in candidates:
        row = by_id.get(candidate.doc_id)
        if row is None:
            continue
        try:
            entry = distil_document(
                title=candidate.title,
                body=candidate.body,
                source=candidate.source,
                location=candidate.location,
                kind=candidate.kind,
            )
        except DistillCallError as error:
            failed += 1
            print(f"[runner:{source}] distil FAILED {candidate.doc_id}: {error}", file=sys.stderr)
            continue

        source_text = f"{row.get('title') or ''}\n{row.get('body') or ''}"
        try:
            distillation, fabricated = parse_distillation(entry, source_text)
        except DistillationError as error:
            failed += 1
            print(f"[runner:{source}] parse FAILED {candidate.doc_id}: {error}", file=sys.stderr)
            continue

        requested = [t for t in (entry.get("terms") or []) if str(t).strip()]
        if requested and len(fabricated) / len(requested) > MAX_FABRICATED_RATIO:
            failed += 1
            print(
                f"[runner:{source}] REJECTED {candidate.doc_id}: "
                f"{len(fabricated)}/{len(requested)} terms not in source",
                file=sys.stderr,
            )
            continue

        text = distillation.render()
        title = row.get("title") or ""
        rules_domains = tuple(row.get("domains") or ())
        decision = arbitrate(rules_domains, distillation.proposed_label)
        vector = embed_texts([embed_text_for(title, text)])[0]

        metadata = {
            **(row.get("metadata") or {}),
            "_embed_hash": embed_hash_for(title, text),
            "distill": {
                "version": DISTILLER_VERSION,
                "model": model_label(),
                "content_hash": content_hash(title, row.get("body") or ""),
                "label_decision_reason": decision.reason,
            },
        }
        (
            db(sb)
            .table("documents")
            .update(
                {
                    "distillation": text,
                    "embedding": vector,
                    "metadata": metadata,
                    "domains": list(decision.domains),
                    "label_source": decision.label_source,
                }
            )
            .eq("id", row["id"])
            .execute()
        )
        distilled += 1

    if distilled:
        db(sb).rpc("refresh_documents_term_stats", {}).execute()

    return distilled, failed


def build_documents(puller, raws: list) -> tuple[list, list[Document], list[dict]]:
    """Convert raws to documents, dropping any the puller skips.

    Returns `(kept_raws, documents, skipped)` where `kept_raws[i]` is the raw
    that produced `documents[i]` -- the alignment Fireflies' `before_upsert`
    relies on when it `zip`s them. Only `SkipPayload` is caught; any other
    exception is a bug and propagates to fail the run. A skip in a full-sync
    source raises `RunnerError` (dropping a row would tombstone its stored
    copy), and more than `MAX_SKIPPED_PER_RUN` skips means something
    systemic -- also a `RunnerError`.
    """
    kept_raws: list = []
    documents: list[Document] = []
    skipped: list[dict] = []
    for index, raw in enumerate(raws):
        try:
            documents.append(puller.to_document(raw))
        except SkipPayload as skip:
            if puller.FULL_SYNC:
                raise RunnerError(
                    f"{puller.SOURCE}: SkipPayload in a full-sync source would tombstone "
                    f"a stored row: {skip.reason}"
                ) from skip
            skipped.append({"index": index, "external_id": skip.external_id, "reason": skip.reason})
            continue
        kept_raws.append(raw)
    if len(skipped) > MAX_SKIPPED_PER_RUN:
        reasons = "; ".join(s["reason"] for s in skipped)
        raise RunnerError(
            f"{len(skipped)} payloads skipped, more than {MAX_SKIPPED_PER_RUN}: {reasons}"
        )
    return kept_raws, documents, skipped


def success_warning(hook: dict, skipped: list) -> str | None:
    """The `warning: ...` string for a successful run, or None if nothing to
    warn about. Combines a wiki write-back warning with a skip summary; all
    skip reasons are included (each truncated to 80 chars)."""
    parts: list[str] = []
    if hook.get("wiki_error"):
        parts.append(f"wiki {hook['wiki_error']}")
    if skipped:
        reasons = "; ".join(s["reason"][:80] for s in skipped)
        parts.append(f"skipped {len(skipped)}: {reasons}")
    if not parts:
        return None
    return "warning: " + "; ".join(parts)


def error_text(puller, error: BaseException) -> str:
    """What is stored (and shown on the status page) for a failed run.

    A source whose rows are private to one person sets REDACT_ERRORS: its
    error text is cut to one redacted line, because a database error can
    quote the row it refused.
    """
    if getattr(puller, "REDACT_ERRORS", False):
        return f"{type(error).__name__}: {issues.redact(error)}"
    return f"{type(error).__name__}: {error}"


def confirmed_absent(puller, documents: list[Document], sb) -> frozenset[str]:
    """Ids the puller has checked are really gone at the source (may be none)."""
    confirm = getattr(puller, "confirm_absent", None)
    return frozenset(confirm(documents, sb)) if confirm is not None else frozenset()


def source_is_off(name: str) -> bool:
    """True when the source has an on/off switch in the config and it is off."""
    enabled = getattr(REGISTRY[name], "enabled", None)
    return enabled is not None and not enabled()


def run_source(
    name: str,
    *,
    owner: str = "pullers.runner",
    lock_ttl: int = LOCK_TTL_SECONDS,
    max_candidates: int = DEFAULT_DISTIL_CAP,
    dry_run: bool = False,
) -> SourceReceipt:
    if name not in REGISTRY:
        raise RunnerError(f"Unknown source {name!r}; choose from {sorted(REGISTRY)}")

    puller = REGISTRY[name]
    receipt = SourceReceipt(source=name)
    sb = get_supabase_ingest()

    with cursors.with_lock(name, owner, lock_ttl, sb=sb) as acquired:
        if not acquired:
            print(f"[runner:{name}] lock held by another run -- standing down")
            receipt.stood_down = True
            receipt.ok = True
            return receipt

        try:
            # Optional per-source step before anything is read: the wiki
            # puller applies the config from the knowledge repo here. It
            # writes, so a dry run skips it.
            prepare = getattr(puller, "prepare", None)
            if prepare is not None and not dry_run:
                prepare(sb)

            cursor = cursors.get_cursor(name, sb=sb)
            raws, new_cursor = puller.fetch(cursor, sb=sb)

            raws = list(raws)
            raws, documents, skipped = build_documents(puller, raws)
            receipt.skipped = skipped
            for skip in skipped:
                print(f"[runner:{name}] skipped: {skip['reason']}")

            # Optional per-source step between build and write: Fireflies
            # writes the meeting wiki page here and stamps wiki_page_id on the
            # documents. A hook must not raise; its own failure is reported.
            hook = getattr(puller, "before_upsert", None)
            if hook is not None and not dry_run:
                documents, hook_info = hook(raws, documents, sb)
                receipt.hook = hook_info
                if hook_info.get("wiki_error"):
                    print(f"[runner:{name}] WARNING wiki write-back: {hook_info['wiki_error']}")

            _bronze_capture(puller, documents, sb)
            gone = confirmed_absent(puller, documents, sb)

            if dry_run:
                result = ingest.upsert(
                    documents, source=name, sb=sb,
                    full_sync=puller.FULL_SYNC, dry_run=True, confirmed_absent=gone,
                )
                receipt.ingest = {
                    "scanned": result.scanned, "inserted": result.inserted,
                    "updated": result.updated, "unchanged": result.unchanged,
                    "tombstoned": result.tombstoned, "revived": result.revived,
                }
                receipt.ok = True
                return receipt

            result = ingest.upsert(
                documents, source=name, sb=sb, full_sync=puller.FULL_SYNC,
                confirmed_absent=gone,
            )
            receipt.ingest = {
                "scanned": result.scanned, "inserted": result.inserted,
                "updated": result.updated, "unchanged": result.unchanged,
                "tombstoned": result.tombstoned, "revived": result.revived,
                "embedded": result.embedded,
            }

            # Decisions from an earlier batch land BEFORE a new batch is
            # built -- manual Section 14.4, preserved from
            # apply_review_decisions.py's own ordering guarantee.
            review_apply.apply_pending(sb=sb)

            distilled, failed = _triage_and_distil(name, sb, max_candidates)
            receipt.distilled = distilled
            receipt.distil_failed = failed

            batch = review_queue.build_batch(sb=sb)
            receipt.review_queued = len(batch.items)

            cursors.set_cursor(name, new_cursor, sb=sb)
            warning = success_warning(receipt.hook, receipt.skipped)
            cursors.record_run(
                name, success=True, sb=sb,
                **({"error": warning} if warning else {}),
            )
            receipt.ok = True
            run_issues.report_clean(name, receipt.hook, sb=sb)
            tag_issues.report(name, sb=sb)
        except Exception as error:  # noqa: BLE001 -- reported, not swallowed
            receipt.error = error_text(puller, error)
            traceback.print_exc()
            try:
                cursors.record_run(name, success=False, error=receipt.error, sb=sb)
            except Exception:  # noqa: BLE001
                pass
            if not dry_run:
                run_issues.report_failure(name, error, sb=sb)

    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, choices=sorted(REGISTRY))
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_DISTIL_CAP)
    parser.add_argument("--owner", default="pullers.runner")
    parser.add_argument("--lock-ttl", type=int, default=LOCK_TTL_SECONDS)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # A source the config turns off does not run: no lock, no source call.
    if source_is_off(args.source):
        print(f"[runner:{args.source}] this source is off in the Engine config -- not run")
        return 0

    # Nothing is ingested before sign-in is set up (see access_gate.py).
    gate = access_gate.check(get_supabase_ingest())
    if not gate.allowed:
        print(f"[runner:{args.source}] {gate.reason}")
        return 0

    receipt = run_events.observe(
        args.source,
        lambda: run_source(
            args.source,
            owner=args.owner,
            lock_ttl=args.lock_ttl,
            max_candidates=args.max_candidates,
            dry_run=args.dry_run,
        ),
        dry_run=args.dry_run,
    )

    print(json.dumps(receipt.__dict__, indent=2))
    return 0 if receipt.ok else 1


if __name__ == "__main__":
    sys.exit(main())
