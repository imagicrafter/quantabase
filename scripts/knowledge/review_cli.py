#!/usr/bin/env python3
"""Step 10 (simplified) -- terminal review loop.

The operating-loop plan called for a published Claude Artifact; a prior review
cut that to a terminal loop and it was accepted. This is that loop:

    ../.venv/bin/python -m knowledge.review_cli
    ../.venv/bin/python -m knowledge.review_cli --size 40

Resumes an existing undecided batch if one exists (so quitting partway through
never strands items); otherwise builds a fresh batch with `review_queue.
build_batch()`. Every keystroke writes straight to `review_items.decision` /
`decided_at`; `review_apply.apply_pending()` runs once at the end so a batch
that is fully decided is also fully applied before the process exits.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from . import review_apply
from .config import domains as configured_domains
from .review_queue import DEFAULT_BATCH_SIZE, build_batch
from .supabase_client import get_supabase
from .kb_schema import db

KEYSTROKE_HELP = (
    "[a] approve  [r] regenerate  [x] exclude  [l] relabel  [s] skip  [q] quit+apply"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fetch_open_batch_items(sb) -> tuple[str | None, list[dict]]:
    """The oldest batch with undecided items, so nothing built earlier is stranded."""
    resp = (
        db(sb)
        .table("review_items")
        .select("batch_id, item_number, document_id, review_batches(sent_at)")
        .is_("decision", "null")
        .is_("applied_at", "null")
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return None, []

    rows.sort(
        key=lambda r: ((r.get("review_batches") or {}).get("sent_at") or "", r["item_number"])
    )
    batch_id = rows[0]["batch_id"]
    items = [r for r in rows if r["batch_id"] == batch_id]
    items.sort(key=lambda r: r["item_number"])
    return batch_id, items


def _fetch_document_views(sb, document_ids: list[str]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    unique_ids = sorted(set(document_ids))
    for start in range(0, len(unique_ids), 100):
        chunk = unique_ids[start : start + 100]
        resp = (
            db(sb)
            .table("documents")
            .select("id, title, source, tier, domains, distillation")
            .in_("id", chunk)
            .execute()
        )
        for row in resp.data or []:
            found[row["id"]] = row
    return found


def _split_distillation(text: str) -> tuple[str, str, list[str]]:
    lines = [line for line in (text or "").splitlines() if line.strip()]
    what = lines[0] if lines else ""
    why = ""
    terms: list[str] = []
    for line in lines[1:]:
        if line.startswith("Key terms:"):
            terms = [t.strip() for t in line[len("Key terms:") :].split(",") if t.strip()]
        elif not why:
            why = line
    return what, why, terms


def _print_item(item_number: int, doc: dict) -> None:
    what, why, terms = _split_distillation(doc.get("distillation") or "")
    print()
    print("-" * 72)
    print(f"#{item_number}  {doc.get('title', '')}")
    print(f"source={doc.get('source', '')}  tier={doc.get('tier', '')}  domains={doc.get('domains', [])}")
    print(f"WHAT:  {what}")
    print(f"WHY:   {why}")
    print(f"TERMS: {', '.join(terms) if terms else '(none)'}")
    print("-" * 72)


def _prompt_domain() -> str | None:
    print(f"domains: {', '.join(configured_domains())}")
    choice = input("new domain: ").strip()
    if choice not in configured_domains():
        print(f"  not a known domain, skipping relabel: {choice!r}")
        return None
    return choice


def _write_decision(sb, batch_id: str, item_number: int, decision: str, note: str | None) -> None:
    (
        db(sb)
        .table("review_items")
        .update({"decision": decision, "decided_at": _now_iso(), "note": note})
        .eq("batch_id", batch_id)
        .eq("item_number", item_number)
        .execute()
    )


def run(size: int) -> int:
    sb = get_supabase()

    batch_id, open_items = _fetch_open_batch_items(sb)
    if batch_id is None:
        batch = build_batch(size)
        if not batch.items:
            print("Nothing unreviewed to show. Nothing to do.")
            return 0
        batch_id = batch.id
        open_items = [
            {"batch_id": batch.id, "item_number": i.item_number, "document_id": i.document_id}
            for i in batch.items
        ]
        print(f"Built new batch {batch_id}: {len(open_items)} items.")
    else:
        print(f"Resuming batch {batch_id}: {len(open_items)} undecided items.")

    documents = _fetch_document_views(sb, [row["document_id"] for row in open_items])

    reviewer = input("Your name/handle (recorded as reviewer): ").strip() or "unknown"
    (
        db(sb)
        .table("review_batches")
        .update({"recipient": reviewer})
        .eq("id", batch_id)
        .execute()
    )

    print(KEYSTROKE_HELP)
    quit_requested = False
    for row in open_items:
        doc = documents.get(row["document_id"])
        if doc is None:
            _write_decision(sb, batch_id, row["item_number"], "exclude", "document missing")
            continue

        _print_item(row["item_number"], doc)
        while True:
            key = input(f"decision {KEYSTROKE_HELP}: ").strip().lower()[:1]
            if key == "a":
                _write_decision(sb, batch_id, row["item_number"], "approve", None)
                break
            if key == "r":
                _write_decision(sb, batch_id, row["item_number"], "regenerate", None)
                break
            if key == "x":
                _write_decision(sb, batch_id, row["item_number"], "exclude", None)
                break
            if key == "l":
                domain = _prompt_domain()
                if domain is None:
                    continue
                _write_decision(
                    sb, batch_id, row["item_number"], "relabel", json.dumps({"domain": domain})
                )
                break
            if key == "s":
                break
            if key == "q":
                quit_requested = True
                break
            print("unrecognised key, try again")
        if quit_requested:
            break

    print("\nApplying decisions...")
    result = review_apply.apply_pending()
    print(f"applied: {len(result.applied)} {result.counts()}")
    print(f"re-embedded: {result.re_embedded}")
    if result.skipped:
        print(f"skipped: {len(result.skipped)}")
        for item in result.skipped:
            print(f"  {item.batch_id}#{item.item_number} ({item.decision}): {item.reason}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", type=int, default=DEFAULT_BATCH_SIZE)
    args = parser.parse_args()
    try:
        return run(args.size)
    except (EOFError, KeyboardInterrupt):
        print("\ninterrupted; undecided items remain queued for next run.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
