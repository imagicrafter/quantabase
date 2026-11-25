#!/usr/bin/env python3
"""Backfill Google Drive artifacts into workspace.documents.

    ../.venv/bin/python -m knowledge.backfill_drive --audit-only   # no DB, no embedding
    ../.venv/bin/python -m knowledge.backfill_drive --dry-run      # reads DB, writes nothing
    ../.venv/bin/python -m knowledge.backfill_drive                # ingest
    ../.venv/bin/python -m knowledge.backfill_drive --include-sensitive

Indexes native Google Workspace documents only. Add other types deliberately with
`--include-mime application/pdf`; see the connector docstring for why PDFs are not
the default.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import SOURCE_DRIVE
from knowledge.connectors import drive
from knowledge.ingest import upsert


def _write_audit(audits, destination: Path) -> None:
    rows = list(drive.iter_audit_rows(audits))
    if not rows:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def _report(documents, audits) -> None:
    print(f"Artifacts:       {len(documents)}")

    print("\nBy type:")
    for mime, count in Counter(a.mime for a in audits).most_common():
        print(f"  {count:4d}  {mime.replace('application/vnd.google-apps.', '')}")

    print("\nDomain distribution (multi-label):")
    for domain, count in Counter(
        domain for audit in audits for domain in audit.domains
    ).most_common():
        print(f"  {domain:<18} {count}")

    print("\nResolved by:")
    for matched_by, count in Counter(a.matched_by for a in audits).most_common():
        print(f"  {matched_by:<10} {count}")

    with_body = sum(1 for a in audits if a.has_body)
    print(f"\nText extracted:  {with_body} of {len(audits)}")

    print("\nTop folders:")
    for folder, count in Counter(
        a.folder_path or "(My Drive)" for a in audits
    ).most_common(12):
        print(f"  {count:4d}  {folder}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-sensitive", action="store_true")
    parser.add_argument(
        "--include-mime",
        action="append",
        dest="include_mimes",
        help="add a MIME type to index (repeatable); replaces the default set",
    )
    parser.add_argument(
        "--no-bodies",
        action="store_true",
        help="skip Google Docs text extraction (much faster, weaker search)",
    )
    parser.add_argument("--limit", type=int, help="cap artifacts, newest first")
    parser.add_argument(
        "--audit-file",
        type=Path,
        default=Path("outputs/knowledge/drive-artifact-audit.csv"),
    )
    args = parser.parse_args()

    try:
        documents, audits = drive.collect(
            include_sensitive=args.include_sensitive,
            include_mimes=args.include_mimes,
            fetch_bodies=not args.no_bodies,
            limit=args.limit,
        )
    except drive.DriveConnectorError as error:
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
            source=SOURCE_DRIVE,
            full_sync=args.limit is None and not args.include_mimes,
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
