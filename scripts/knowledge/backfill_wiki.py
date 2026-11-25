#!/usr/bin/env python3
"""Backfill the knowledge wiki into workspace.documents.

    python -m knowledge.backfill_wiki --audit-only     # no database, no embedding
    python -m knowledge.backfill_wiki --dry-run        # reads DB, writes nothing
    python -m knowledge.backfill_wiki                  # ingest (excludes sensitive topics)
    python -m knowledge.backfill_wiki --include-sensitive

`--audit-only` is the safe first run: it reads the wiki, resolves domains and
tiers, and writes a CSV audit without contacting Supabase or loading the
embedding model.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import SOURCE_WIKI
from knowledge.connectors import wiki
from knowledge.ingest import upsert


def _write_audit(audits, destination: Path) -> None:
    rows = list(wiki.iter_audit_rows(audits))
    if not rows:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def _report(documents, audits) -> None:
    parents = [doc for doc in documents if doc.parent_external_id is None]
    sections = len(documents) - len(parents)

    print(f"Pages read:      {len(audits)}")
    print(f"Parent rows:     {len(parents)}")
    print(f"Section rows:    {sections}")
    print(f"Total rows:      {len(documents)}")

    print("\nTier distribution (pages):")
    for tier, count in sorted(Counter(a.tier for a in audits).items()):
        print(f"  tier {tier}: {count}")

    print("\nDomain distribution (pages, multi-label):")
    domain_counts = Counter(
        domain for audit in audits for domain in audit.domains
    )
    for domain, count in domain_counts.most_common():
        print(f"  {domain:<18} {count}")

    print("\nResolved by:")
    for matched_by, count in Counter(a.matched_by for a in audits).most_common():
        print(f"  {matched_by:<10} {count}")

    without_summary = sum(1 for a in audits if not a.has_summary)
    print(f"\nPages with no `summary:` frontmatter: {without_summary}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help="Resolve domains and tiers without contacting Supabase or embedding",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read the database and report changes without writing",
    )
    parser.add_argument(
        "--include-sensitive",
        action="store_true",
        help="Also ingest pages labelled with a sensitive topic",
    )
    parser.add_argument(
        "--audit-file",
        type=Path,
        default=Path("outputs/knowledge/wiki-domain-audit.csv"),
        help="Where to write the per-page labelling audit",
    )
    args = parser.parse_args()

    try:
        documents, audits = wiki.collect(include_sensitive=args.include_sensitive)
    except wiki.WikiConnectorError as error:
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
            source=SOURCE_WIKI,
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
