#!/usr/bin/env python3
"""Backfill full meeting transcripts into workspace.documents.

    ../.venv/bin/python -m knowledge.backfill_transcripts --audit-only   # no DB, no embedding
    ../.venv/bin/python -m knowledge.backfill_transcripts --dry-run      # reads DB, writes nothing
    ../.venv/bin/python -m knowledge.backfill_transcripts                # ingest

Reads local files only (`memory/transcripts/*.md`) -- no API, no network.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import SOURCE_FIREFLIES
from knowledge.connectors import transcripts
from knowledge.ingest import upsert


def _write_audit(audits, destination: Path) -> None:
    rows = list(transcripts.iter_audit_rows(audits))
    if not rows:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def _report(documents, audits) -> None:
    print(f"Transcripts read: {len(audits)}")

    print("\nDomain distribution (multi-label):")
    for domain, count in Counter(
        domain for audit in audits for domain in audit.domains
    ).most_common():
        print(f"  {domain:<18} {count}")

    print("\nResolved by:")
    for matched_by, count in Counter(a.matched_by for a in audits).most_common():
        print(f"  {matched_by:<10} {count}")

    with_wiki_link = sum(1 for a in audits if a.wiki_page_id)
    print(f"\nLinked to a wiki meeting page: {with_wiki_link} of {len(audits)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-sensitive", action="store_true")
    parser.add_argument(
        "--audit-file",
        type=Path,
        default=Path("outputs/knowledge/transcripts-domain-audit.csv"),
    )
    args = parser.parse_args()

    try:
        documents, audits = transcripts.collect(
            include_sensitive=args.include_sensitive
        )
    except transcripts.TranscriptsConnectorError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    _report(documents, audits)
    _write_audit(audits, args.audit_file)
    print(f"\nAudit written to {args.audit_file}")

    if args.audit_only:
        print("\n--audit-only: no database contact, no embedding.")
        return 0

    try:
        result = upsert(
            documents,
            source=SOURCE_FIREFLIES,
            full_sync=True,
            dry_run=args.dry_run,
        )
    except Exception as error:
        print(f"\nERROR: {error}", file=sys.stderr)
        return 1

    print(f"\n{result.summary()}")
    if args.dry_run:
        print("--dry-run: nothing written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
