#!/usr/bin/env python3
"""Live contract checks that need a database connection.

    ../.venv/bin/python -m knowledge.verify_ingest

The offline half of the contract lives in `connector_contract_test.py`. This
module covers the two properties that can only be observed against real rows:

1. **Zero writes on an unchanged re-run.**
2. **Tombstone on resync, and revival afterwards.** A document dropped from the
   emitted set is soft-deleted, not removed; re-emitting it clears `deleted_at`.

The tombstone check leaves the store exactly as it found it. It writes nothing to
disk and does not touch the wiki repository.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import SOURCE_WIKI
from knowledge.connectors import wiki
from knowledge.ingest import upsert
from knowledge.supabase_client import get_supabase
from knowledge.kb_schema import db


class VerificationFailure(AssertionError):
    """A live contract property does not hold."""


def _row(sb, external_id: str) -> dict | None:
    resp = (
        db(sb)
        .table("documents")
        .select("external_id, deleted_at, source_hash")
        .eq("source", SOURCE_WIKI)
        .eq("external_id", external_id)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def check_no_writes_on_rerun(sb, documents) -> None:
    result = upsert(documents, source=SOURCE_WIKI, sb=sb, dry_run=True)
    if result.wrote_anything:
        raise VerificationFailure(
            f"Re-run would write: {result.summary()}. Ingest is not idempotent."
        )
    print(f"PASS  idempotent re-run: {result.summary()}")


def check_tombstone_and_revive(sb, documents) -> None:
    """Drop one document, confirm it is tombstoned, then restore it."""
    parents = [doc for doc in documents if doc.parent_external_id is None]
    if not parents:
        raise VerificationFailure("No parent documents to test tombstoning with.")

    victim = parents[-1]
    remaining = [doc for doc in documents if doc.external_id != victim.external_id]

    before = _row(sb, victim.external_id)
    if before is None:
        raise VerificationFailure(
            f"{victim.external_id} is not in the store; run the backfill first."
        )
    if before["deleted_at"] is not None:
        raise VerificationFailure(
            f"{victim.external_id} is already tombstoned; cannot test cleanly."
        )

    try:
        upsert(remaining, source=SOURCE_WIKI, sb=sb, full_sync=True)
        after = _row(sb, victim.external_id)

        if after is None:
            raise VerificationFailure(
                f"{victim.external_id} was HARD DELETED. The contract requires a "
                "tombstone so the index stays auditable."
            )
        if after["deleted_at"] is None:
            raise VerificationFailure(
                f"{victim.external_id} was not tombstoned by a full sync."
            )
        print(f"PASS  tombstoned on resync: {victim.external_id}")
    finally:
        # Always restore, even if an assertion failed above.
        restore = upsert(documents, source=SOURCE_WIKI, sb=sb, full_sync=True)
        revived = _row(sb, victim.external_id)
        if revived is None or revived["deleted_at"] is not None:
            raise VerificationFailure(
                f"{victim.external_id} was NOT revived. Store left dirty. "
                f"Restore run: {restore.summary()}"
            )
        print(f"PASS  revived on re-emit:   {victim.external_id}")


def main() -> int:
    documents, _ = wiki.collect()
    sb = get_supabase()

    checks = (
        ("idempotency", lambda: check_no_writes_on_rerun(sb, documents)),
        ("tombstone", lambda: check_tombstone_and_revive(sb, documents)),
    )

    failures = 0
    for name, check in checks:
        try:
            check()
        except VerificationFailure as error:
            print(f"FAIL  {name}: {error}")
            failures += 1
        except Exception as error:
            print(f"ERROR {name}: {type(error).__name__}: {error}")
            failures += 1

    if failures:
        print(f"\n{failures} live check(s) failed.")
        return 1

    print("\nAll live ingest checks pass.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
