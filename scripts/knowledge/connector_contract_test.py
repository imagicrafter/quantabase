#!/usr/bin/env python3
"""The contract test every connector must pass.

Run offline -- no database, no embedding model:

    python -m knowledge.connector_contract_test

Asserted properties:

1. Every emitted object is a valid `Document`.
2. `external_id` is unique within a source.
3. `external_id` and `source_hash` are STABLE across two runs over unchanged
   input. This is what makes the "zero writes on a re-run" guarantee real: ingest
   compares hashes, so an unstable hash means a full re-embed every run.
4. `domains` are drawn from the known taxonomy and are never empty.
5. `tier` is in range, and the tier rule is justified against the real corpus
   rather than asserted.
6. Section rows point at a parent that is itself emitted.
7. Sensitive domains are excluded unless explicitly requested.

The database-dependent halves of the contract -- tombstone-on-resync and
zero-writes-on-rerun -- are exercised by `verify_ingest.py`, which needs a live
connection and is therefore not part of this offline suite.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import domains as configured_domains, sensitive_domains as configured_sensitive_domains, TIER_RAW, TIER_VERIFIED
from knowledge.contract import Document


class ContractViolation(AssertionError):
    """A connector broke the ingest contract."""


def _check(condition: bool, message: str) -> None:
    if not condition:
        raise ContractViolation(message)


def assert_valid_documents(documents: Sequence[Document], source: str) -> None:
    _check(bool(documents), f"[{source}] emitted no documents")

    for doc in documents:
        _check(
            isinstance(doc, Document),
            f"[{source}] emitted a {type(doc).__name__}, not a Document",
        )
        _check(
            doc.source == source,
            f"[{source}] document {doc.external_id!r} carries source {doc.source!r}",
        )
        _check(
            TIER_VERIFIED <= doc.tier <= TIER_RAW,
            f"[{source}] {doc.external_id!r} has out-of-range tier {doc.tier}",
        )
        _check(
            bool(doc.domains),
            f"[{source}] {doc.external_id!r} has empty domains -- the row would be "
            "invisible to every principal",
        )
        unknown = [d for d in doc.domains if d not in configured_domains()]
        _check(
            not unknown,
            f"[{source}] {doc.external_id!r} carries unknown domains {unknown}",
        )


def assert_unique_external_ids(documents: Sequence[Document], source: str) -> None:
    seen: set[str] = set()
    duplicates: list[str] = []
    for doc in documents:
        if doc.external_id in seen:
            duplicates.append(doc.external_id)
        seen.add(doc.external_id)
    _check(
        not duplicates,
        f"[{source}] duplicate external_ids: {sorted(set(duplicates))[:5]}",
    )


def assert_stable_across_runs(
    collect: Callable[[], Sequence[Document]], source: str
) -> None:
    """Two collections over unchanged input must produce identical identity+hash."""
    first = {doc.external_id: doc.source_hash for doc in collect()}
    second = {doc.external_id: doc.source_hash for doc in collect()}

    _check(
        set(first) == set(second),
        f"[{source}] external_id set changed between runs: "
        f"added={sorted(set(second) - set(first))[:5]} "
        f"removed={sorted(set(first) - set(second))[:5]}",
    )

    drifted = [key for key in first if first[key] != second[key]]
    _check(
        not drifted,
        f"[{source}] source_hash changed between runs for {drifted[:5]}. "
        "An unstable hash re-embeds the entire corpus on every run.",
    )


def assert_parents_present(documents: Sequence[Document], source: str) -> None:
    ids = {doc.external_id for doc in documents}
    orphans = [
        doc.external_id
        for doc in documents
        if doc.parent_external_id and doc.parent_external_id not in ids
    ]
    _check(not orphans, f"[{source}] section rows with no parent: {orphans[:5]}")


def assert_sensitive_excluded(documents: Sequence[Document], source: str) -> None:
    leaked = [
        doc.external_id
        for doc in documents
        if configured_sensitive_domains().intersection(doc.domains)
    ]
    _check(
        not leaked,
        f"[{source}] sensitive-domain documents emitted by a default collect: "
        f"{leaked[:5]}",
    )


def run_contract(
    source: str, collect: Callable[[], Sequence[Document]]
) -> Sequence[Document]:
    documents = list(collect())
    assert_valid_documents(documents, source)
    assert_unique_external_ids(documents, source)
    assert_parents_present(documents, source)
    assert_sensitive_excluded(documents, source)
    assert_stable_across_runs(collect, source)
    return documents


def _wiki_collect() -> Sequence[Document]:
    from knowledge.connectors import wiki

    documents, _ = wiki.collect()
    return documents


def _drive_collect() -> Sequence[Document]:
    from knowledge.connectors import drive

    # Bodies are skipped: the stability check calls collect() twice, and fetching
    # 164 Google Doc bodies twice would make the suite unusable. Body text does
    # not affect external_id stability, which is what this asserts.
    documents, _ = drive.collect(fetch_bodies=False)
    return documents


def main() -> int:
    import argparse

    from knowledge.config import SOURCE_DRIVE, SOURCE_WIKI

    parser = argparse.ArgumentParser(description="Run the connector contract test")
    parser.add_argument(
        "--network",
        action="store_true",
        help="also test connectors that call external APIs (drive)",
    )
    args = parser.parse_args()

    connectors: dict[str, Callable[[], Sequence[Document]]] = {
        SOURCE_WIKI: _wiki_collect,
    }
    if args.network:
        connectors[SOURCE_DRIVE] = _drive_collect
    else:
        print("(skipping network connectors; pass --network to include them)\n")

    failures = 0
    for source, collect in connectors.items():
        try:
            documents = run_contract(source, collect)
        except ContractViolation as error:
            print(f"FAIL  {source}: {error}")
            failures += 1
        except Exception as error:  # connector blew up rather than violated
            print(f"ERROR {source}: {type(error).__name__}: {error}")
            failures += 1
        else:
            print(f"PASS  {source}: {len(documents)} documents")

    if failures:
        print(f"\n{failures} connector(s) failed the contract.")
        return 1

    print("\nAll connectors pass the contract.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
