#!/usr/bin/env python3
"""One-time rebuild of every meeting wiki page + Fireflies notes in Supabase.

    python -m pullers.backfill_meeting_pages --dry-run --limit 5 --preview-dir /tmp/x
    python -m pullers.backfill_meeting_pages --limit 25
    python -m pullers.backfill_meeting_pages

For each meeting:

- **Still in Fireflies:** fetch it in full, re-upsert its `workspace.documents`
  row WITH the Fireflies notes block (and bronze it), and render its page.
  The row is matched to the stored one by fireflies_id, else by date + opening
  transcript lines, so a calendar-titled row is updated instead of duplicated.
- **Already deleted from Fireflies:** render from the stored row; an old-template
  page's Overview / Action Items / Keywords are kept. The row is marked
  `fireflies_deleted_at` so retention never retries it.

Pages are pushed in batches (one commit each). Hand-written pages are skipped.
Run from a developer machine, where KNOWLEDGE_WIKI_ROOT / ~/github/knowledge is a real checkout.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from knowledge import ingest  # noqa: E402
from knowledge.supabase_client import get_supabase_ingest  # noqa: E402
from pullers import fireflies, fireflies_tags, knowledge_repo, meeting_writeback  # noqa: E402
from pullers.meeting_links import default_llm  # noqa: E402
from pullers.meeting_page import MeetingInput  # noqa: E402
from pullers.runner import _bronze_capture  # noqa: E402
from knowledge.kb_schema import db

GONE_MARK = "deleted-before-2026-10-15-backfill"
MATCH_MIN_OVERLAP = 0.6


def _stored_rows(sb) -> list[dict]:
    rows: list[dict] = []
    start = 0
    while True:
        page = (
            db(sb).table("documents")
            .select("external_id,title,body,metadata,domains,source_created_at")
            .eq("source", "fireflies").is_("parent_external_id", "null").is_("deleted_at", "null")
            .order("source_created_at").range(start, start + 99).execute().data or []
        )
        rows += page
        if len(page) < 100:
            return rows
        start += 100


def _alive_raws() -> list[dict]:
    stubs = fireflies._list_stubs(datetime(2020, 1, 1, tzinfo=timezone.utc))
    raws: list[dict] = []
    for i, stub in enumerate(stubs, 1):
        for attempt in range(4):
            try:
                full = fireflies._fetch_transcript(stub["id"])
                break
            except Exception as error:  # noqa: BLE001 -- back off on 429 / 5xx
                retryable = any(code in str(error) for code in ("429", "500", "502", "503", "504"))
                if not retryable or attempt == 3:
                    raise
                time.sleep(30 * (attempt + 1))
        if full:
            raws.append(full)
        print(f"  fetched {i}/{len(stubs)}", end="\r")
        time.sleep(fireflies.API_DELAY_SECONDS)
    print()
    return fireflies._disambiguate(raws)


def _words(text: str, limit: int = 400) -> set[str]:
    return set(re.findall(r"[a-z0-9']{4,}", (text or "").lower())[:limit])


def _overlap(raw: dict, row: dict) -> float:
    probe = _words(" ".join(s.get("text") or "" for s in (raw.get("sentences") or [])[:120]))
    if len(probe) < 15:
        return 0.0
    return len(probe & _words(row.get("body") or "", 4000)) / len(probe)


def pair_rows(docs: list, raws: list[dict], rows: list[dict]) -> dict[int, dict]:
    """Index in `docs` -> its stored row. Exact keys first (fireflies_id, then
    external_id -- what upsert keys on anyway), then best same-day word overlap
    among the rows still unclaimed. Fireflies re-segments sentences over time,
    so exact line matching is not reliable. Each row is claimed at most once,
    so a second bot's recording of the same call keeps its own row."""
    by_fid = {(r.get("metadata") or {}).get("fireflies_id"): r for r in rows if (r.get("metadata") or {}).get("fireflies_id")}
    by_id = {r["external_id"]: r for r in rows}
    claimed: set[str] = set()
    pairs: dict[int, dict] = {}

    def _foreign(row: dict, raw: dict) -> bool:
        """The row already belongs to a DIFFERENT recording."""
        fid = (row.get("metadata") or {}).get("fireflies_id")
        return bool(fid) and fid != raw.get("id")

    # Pass 1: fireflies_id for every document, before any name-based claim.
    for i, raw in enumerate(raws):
        row = by_fid.get(raw.get("id"))
        if row and row["external_id"] not in claimed:
            pairs[i] = row
            claimed.add(row["external_id"])

    # Pass 2: same external_id (what upsert keys on anyway).
    for i, (doc, raw) in enumerate(zip(docs, raws)):
        row = by_id.get(doc.external_id)
        if i in pairs or not row or row["external_id"] in claimed or _foreign(row, raw):
            continue
        pairs[i] = row
        claimed.add(row["external_id"])

    # Pass 3: same-day word overlap, never onto another recording's row.
    for i, (doc, raw) in enumerate(zip(docs, raws)):
        if i in pairs:
            continue
        scored = [
            (_overlap(raw, row), row) for row in rows
            if row["external_id"] not in claimed and row["external_id"][:10] == doc.external_id[:10]
            and not _foreign(row, raw)
        ]
        score, row = max(scored, key=lambda t: t[0], default=(0.0, None))
        if row and score >= MATCH_MIN_OVERLAP and doc.external_id not in by_id:
            pairs[i] = row
            claimed.add(row["external_id"])
    return pairs


def build(sb) -> tuple[list[MeetingInput], list, list[dict]]:
    """(inputs, fresh documents to upsert, stored rows of meetings gone from Fireflies)."""
    rows = _stored_rows(sb)
    print(f"[backfill] {len(rows)} stored fireflies rows")
    # Each meeting's wiki page, where one exists, decides its topics.
    raws = fireflies._with_page_tags(_alive_raws())
    print(f"[backfill] {len(raws)} meetings still in Fireflies")
    return assemble(rows, raws)


def assemble(rows: list[dict], raws: list[dict]) -> tuple[list[MeetingInput], list, list[dict]]:
    usable_raws, docs = [], []
    for raw in raws:
        try:
            docs.append(fireflies.to_document(raw))
            usable_raws.append(raw)
        except ValueError as error:
            print(f"  skip {raw.get('id')}: {error}")

    pairs = pair_rows(docs, usable_raws, rows)
    documents, inputs = [], []
    for i, (doc, raw) in enumerate(zip(docs, usable_raws)):
        if i in pairs:
            stored_id = pairs[i]["external_id"]
            doc = replace(doc, external_id=stored_id, metadata={**doc.metadata, "filename": stored_id})
        documents.append(doc)
        inputs.append(MeetingInput.from_raw(
            raw, external_id=doc.external_id, domain_tags=tuple(doc.domains or ()),
            page_topics=fireflies_tags.writable_topics(doc),
        ))

    ids = [d.external_id for d in documents]
    duplicates = {x for x in ids if ids.count(x) > 1}
    if duplicates:
        raise SystemExit(f"[backfill] refusing: duplicate external_ids {sorted(duplicates)}")

    claimed = {row["external_id"] for row in pairs.values()} | set(ids)
    gone = [r for r in rows if r["external_id"] not in claimed]
    inputs += [MeetingInput.from_row(r) for r in gone]
    print(f"[backfill] {len(documents)} refreshed from Fireflies ({len(pairs)} matched to stored rows), "
          f"{len(gone)} from stored rows only")
    return inputs, documents, gone


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--since", default="", help="only meetings on/after YYYY-MM-DD")
    parser.add_argument("--batch", type=int, default=25)
    parser.add_argument("--no-llm", action="store_true")
    parser.add_argument("--preview-dir", default="", help="dry-run: write rendered pages here")
    args = parser.parse_args()

    sb = get_supabase_ingest()
    root = knowledge_repo.resolve_root()
    inputs, documents, gone = build(sb)

    inputs = sorted((i for i in inputs if i.date_str >= args.since), key=lambda i: i.date_str, reverse=True)
    if args.limit:
        inputs = inputs[: args.limit]
    keep = {i.external_id for i in inputs}
    documents = [d for d in documents if d.external_id in keep]
    gone = [g for g in gone if g["external_id"] in keep]
    print(f"[backfill] processing {len(inputs)} meeting(s){' (dry run)' if args.dry_run else ''}")

    llm = None if args.no_llm else default_llm
    page_ids: dict[str, str] = {}
    for start in range(0, len(inputs), args.batch):
        batch = inputs[start:start + args.batch]
        receipt = meeting_writeback.write_pages(
            batch, root=root, llm=llm, dry_run=args.dry_run,
            message=f"wiki(auto): backfill meeting pages {start + 1}-{start + len(batch)}",
        )
        print(f"[backfill] batch {start // args.batch + 1}: {receipt.summary()}")
        for rel, reason in receipt.skipped:
            print(f"    skipped {rel}: {reason}")
        if receipt.error:
            print(f"[backfill] STOP: {receipt.error}")
            return 1
        page_ids.update(receipt.page_ids)
        if args.preview_dir:
            out = Path(args.preview_dir)
            out.mkdir(parents=True, exist_ok=True)
            for rel, text in receipt.previews.items():
                (out / Path(rel).name).write_text(text, encoding="utf-8")

    if args.dry_run:
        print(f"[backfill] dry run: would upsert {len(documents)} row(s), mark {len(gone)} gone")
        return 0

    stamped = [
        replace(d, metadata={**d.metadata, "wiki_page_id": page_ids[d.external_id]})
        if d.external_id in page_ids else d
        for d in documents
    ]
    stamped = fireflies.keep_stored_page_ids(stamped, sb)
    _bronze_capture(fireflies, stamped, sb)
    result = ingest.upsert(stamped, source=fireflies.SOURCE, sb=sb, full_sync=False)
    print(f"[backfill] supabase: {result.summary()}")

    patched = meeting_writeback.patch_page_ids(sb, {g["external_id"]: page_ids[g["external_id"]] for g in gone if g["external_id"] in page_ids})
    for row in gone:
        fresh = db(sb).table("documents").select("metadata").eq("source", "fireflies").eq("external_id", row["external_id"]).limit(1).execute().data
        metadata = (fresh[0].get("metadata") if fresh else None) or {}
        if not metadata.get("fireflies_deleted_at"):
            db(sb).table("documents").update(
                {"metadata": {**metadata, "fireflies_deleted_at": GONE_MARK}}
            ).eq("source", "fireflies").eq("external_id", row["external_id"]).execute()
    print(f"[backfill] page ids patched on {patched} stored-only row(s); {len(gone)} marked gone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
