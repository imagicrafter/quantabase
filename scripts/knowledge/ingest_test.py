#!/usr/bin/env python3
"""Regression tests for the ingest write path.

    ../.venv/bin/python -m knowledge.ingest_test

No database required. These test the pure helpers whose defects are not
visible from reading the calling code.

WHY THIS FILE EXISTS
--------------------
The wiki connector failed silently for seven consecutive days (2026-08-15 to
2026-08-21) and nothing caught it. The pipeline ran daily, cron reported
success, and the failure was recorded only in `workspace.connector_state`, in
a column nobody reads. The defect itself was a one-line interaction between
`_review_reset` and PostgREST's bulk-insert semantics -- exactly the kind of
thing a unit test catches instantly and a code review does not.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge import ingest
from knowledge.contract import Document
from knowledge.ingest import group_by_columns

PASSED = 0
FAILED: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"PASS  {label}")
    else:
        FAILED.append(label)
        print(f"FAIL  {label}: {detail}")


def test_homogeneous_rows_stay_one_group() -> None:
    rows = [
        {"source": "wiki", "external_id": "a", "title": "A"},
        {"source": "wiki", "external_id": "b", "title": "B"},
    ]
    groups = group_by_columns(rows)
    check(
        "identical key sets produce a single group",
        len(groups) == 1 and len(groups[0]) == 2,
        f"got {len(groups)} group(s)",
    )


def test_review_reset_row_is_isolated() -> None:
    """THE REGRESSION. A row carrying review_status must not travel with rows
    that omit it -- PostgREST would send those an explicit NULL, and
    review_status is NOT NULL DEFAULT 'unreviewed'."""
    rows = [
        {"source": "wiki", "external_id": "a", "title": "A"},
        {
            "source": "wiki",
            "external_id": "b",
            "title": "B",
            "review_status": "unreviewed",
            "reviewed_at": None,
            "reviewed_by": None,
        },
        {"source": "wiki", "external_id": "c", "title": "C"},
    ]
    groups = group_by_columns(rows)

    check(
        "a review-reset row is separated from rows that omit review_status",
        len(groups) == 2,
        f"got {len(groups)} group(s) -- the reset row is still batched with the others",
    )

    for group in groups:
        keysets = {frozenset(r.keys()) for r in group}
        check(
            f"group of {len(group)} row(s) is internally homogeneous",
            len(keysets) == 1,
            f"group holds {len(keysets)} distinct key sets",
        )

    carriers = [g for g in groups if "review_status" in g[0]]
    check(
        "exactly one group carries review_status",
        len(carriers) == 1 and len(carriers[0]) == 1,
        f"{len(carriers)} group(s) carry it",
    )


def test_no_row_is_lost_or_duplicated() -> None:
    rows = [
        {"external_id": "a", "title": "A"},
        {"external_id": "b", "title": "B", "review_status": "unreviewed"},
        {"external_id": "c", "title": "C"},
        {"external_id": "d", "title": "D", "embedding": [0.1]},
    ]
    flattened = [r for g in group_by_columns(rows) for r in g]
    ids_in = [r["external_id"] for r in rows]
    ids_out = [r["external_id"] for r in flattened]
    check(
        "grouping preserves every row exactly once",
        sorted(ids_in) == sorted(ids_out),
        f"in={sorted(ids_in)} out={sorted(ids_out)}",
    )


def test_order_preserved_within_group() -> None:
    rows = [{"external_id": x, "title": x.upper()} for x in ("a", "b", "c")]
    groups = group_by_columns(rows)
    check(
        "order is preserved within a group",
        [r["external_id"] for r in groups[0]] == ["a", "b", "c"],
        f"got {[r['external_id'] for r in groups[0]]}",
    )


def test_empty_input() -> None:
    check("empty input returns no groups", group_by_columns([]) == [])


def test_describe_absent_splits_moved_sections_from_absent_pages() -> None:
    """A section whose page is still in the fetch is a moved id, not a deletion;
    a page (or a section of a vanished page) that is gone is page-absent."""
    present = {"meetings/a.md", "meetings/a.md#00-notes", "projects/p.md"}
    absent = [
        "meetings/a.md#01-old-heading",
        "meetings/a.md#02-x",
        "meetings/gone.md",
        "meetings/gone.md#00-notes",
        "projects/q.md",
    ]
    detail = ingest.describe_absent(absent, present)
    summary = detail.splitlines()[0]

    check(
        "summary counts split moved sections from absent pages",
        all(
            token in summary
            for token in (
                "absent=5",
                "moved_sections=2",
                "page_absent=3",
                "(2 distinct pages)",
            )
        ),
        f"got {summary!r}",
    )
    check(
        "summary carries a per-dir breakdown",
        "meetings/: 4" in summary and "projects/: 1" in summary,
        f"got {summary!r}",
    )
    check(
        "absent pages are sampled as distinct page paths",
        "meetings/gone.md" in detail and "projects/q.md" in detail,
        f"got {detail!r}",
    )
    check(
        "moved-section samples carry the section id",
        "meetings/a.md#01-old-heading" in detail,
        f"got {detail!r}",
    )


def test_describe_absent_caps_samples() -> None:
    """Samples are capped at `limit`; the overflow is reported, not dropped
    silently -- the operator must know the list is truncated."""
    absent = [f"projects/p{i}.md" for i in range(30)]
    detail = ingest.describe_absent(absent, set(), limit=20)
    page_sample_lines = [
        line for line in detail.splitlines() if line.startswith("page absent:")
    ]
    check(
        "page samples are capped at the limit",
        len(page_sample_lines) == 20,
        f"got {len(page_sample_lines)} sample line(s)",
    )
    check(
        "truncation is reported with a remaining count",
        "10 more" in detail,
        f"got {detail!r}",
    )


def test_describe_absent_caps_samples_moved_sections() -> None:
    """Sample cap applies to moved-section ids; overflow is reported explicitly."""
    present = {"projects/p.md"}
    absent = [f"projects/p.md#{i:02d}-heading" for i in range(25)]
    detail = ingest.describe_absent(absent, present, limit=20)

    moved_sample_lines = [
        line for line in detail.splitlines() if line.startswith("moved section:")
    ]
    check(
        "moved-section samples are capped at the limit",
        len(moved_sample_lines) == 20,
        f"got {len(moved_sample_lines)} sample line(s)",
    )
    check(
        "moved-section truncation is reported with a remaining count",
        "5 more moved section" in detail,
        f"got {detail!r}",
    )


def test_guard_error_explains_and_still_refuses() -> None:
    """The bulk-tombstone guard still refuses, and its message now names the
    counts and ids so an operator can diagnose it without SQL."""
    existing = {
        f"concepts/c{i}.md": {
            "source_hash": "h",
            "deleted_at": None,
            "embed_hash": None,
            "review_status": "unreviewed",
        }
        for i in range(10)
    }
    orig_fetch, orig_verify = ingest._fetch_existing, ingest.verify_taxonomy
    ingest._fetch_existing = lambda sb, source: existing
    ingest.verify_taxonomy = lambda sb: None
    raised = ""
    try:
        ingest.upsert([], source="wiki", sb=object(), full_sync=True)
    except ingest.IngestError as error:
        raised = str(error)
    finally:
        ingest._fetch_existing, ingest.verify_taxonomy = orig_fetch, orig_verify

    check(
        "guard still refuses the bulk tombstone",
        "Refusing to tombstone 10/10" in raised and "Nothing was written" in raised,
        f"got {raised!r}",
    )
    check(
        "refusal names the absent-page count and sample ids",
        "page_absent=10" in raised and "concepts/c0.md" in raised,
        f"got {raised!r}",
    )
    check(
        "the summary leads so a 200-char truncation keeps the numbers",
        "absent=" in raised[:200],
        f"got {raised[:200]!r}",
    )


def _doc(external_id: str, parent: str | None = None) -> Document:
    """A minimal valid wiki Document. `title`/`body` vary with the id so each
    doc's `source_hash` is distinct and reproducible."""
    return Document(
        source="wiki",
        external_id=external_id,
        title=external_id,
        body=f"body of {external_id}",
        domains=("properties",),
        parent_external_id=parent,
    )


def _unchanged_entry(doc: Document) -> dict:
    """An `existing` row that matches `doc` exactly, so upsert writes nothing."""
    return {
        "source_hash": doc.source_hash,
        "deleted_at": None,
        "embed_hash": doc.embed_hash,
        "review_status": "unreviewed",
        "parent_external_id": doc.parent_external_id,
    }


def _absent_entry(parent: str | None = None) -> dict:
    """A live `existing` row with no matching doc in the fetch -- i.e. absent."""
    return {
        "source_hash": "stale",
        "deleted_at": None,
        "embed_hash": None,
        "review_status": "unreviewed",
        "parent_external_id": parent,
    }


def _run_guarded_upsert(docs: list[Document], existing: dict[str, dict]):
    """Drive `upsert()` past the guard with no database.

    Monkeypatches every DB-touching helper to a no-op or recorder (restored in
    `finally`), mirroring the pattern in test_guard_error_explains_and_still_refuses.
    Returns (result_or_None, error_text, tombstoned_ids_or_None).
    """
    captured: dict[str, list[str] | None] = {"tombstone": None}

    def _record_tombstone(sb, source, ids):
        captured["tombstone"] = list(ids)
        return len(ids)

    originals = {
        name: getattr(ingest, name)
        for name in (
            "_fetch_existing",
            "verify_taxonomy",
            "_embed",
            "_upsert_rows",
            "_patch_rows",
            "_tombstone",
            "_assert_no_null_embeddings",
            "_refresh_stats",
        )
    }
    ingest._fetch_existing = lambda sb, source: existing
    ingest.verify_taxonomy = lambda sb: None
    ingest._embed = lambda texts: [[0.0] for _ in texts]
    ingest._upsert_rows = lambda sb, rows: None
    ingest._patch_rows = lambda sb, source, rows: None
    ingest._tombstone = _record_tombstone
    ingest._assert_no_null_embeddings = lambda sb, source: None
    ingest._refresh_stats = lambda sb: None

    result = None
    error = ""
    try:
        result = ingest.upsert(docs, source="wiki", sb=object(), full_sync=True)
    except ingest.IngestError as err:
        error = str(err)
    finally:
        for name, fn in originals.items():
            setattr(ingest, name, fn)
    return result, error, captured["tombstone"]


def test_split_superseded_uses_stored_parent() -> None:
    """An absent id is superseded only when its STORED parent is in the fetch.
    The `#` in an id is never parsed; a sectioned id with a None parent is
    guarded like any page."""
    existing = {
        "m.md#01-a": _absent_entry(parent="m.md"),
        "gone.md#00-x": _absent_entry(parent="gone.md"),
        "gone.md": _absent_entry(parent=None),
        "p.md": _absent_entry(parent=None),
        "orphan.md#00-y": _absent_entry(parent=None),
    }
    seen = {"m.md", "m.md#00-new"}
    absent = ["gone.md", "gone.md#00-x", "m.md#01-a", "p.md", "orphan.md#00-y", "not-in-existing.md"]

    superseded, guarded = ingest.split_superseded(absent, existing, seen)

    check(
        "only the section whose stored parent is in the fetch is superseded",
        superseded == ["m.md#01-a"],
        f"got {superseded!r}",
    )
    check(
        "everything else is guarded, in the original order",
        guarded == ["gone.md", "gone.md#00-x", "p.md", "orphan.md#00-y", "not-in-existing.md"],
        f"got {guarded!r}",
    )
    check(
        "a sectioned id with a None stored parent is guarded, not superseded",
        "orphan.md#00-y" in guarded,
        f"got guarded={guarded!r}",
    )
    check(
        "an id absent from existing entirely falls into guarded",
        "not-in-existing.md" in guarded,
        f"got guarded={guarded!r}",
    )


def test_guard_allows_superseded_sections() -> None:
    """Production shape (scaled): the only absent rows are sections whose parent
    page is still in the fetch. 29% of live rows, well over the 10% guard, yet
    upsert must proceed and soft-delete exactly those sections."""
    pages = [_doc(f"p{i}.md") for i in range(71)]
    existing = {doc.external_id: _unchanged_entry(doc) for doc in pages}

    superseded_ids = [f"p0.md#{i:02d}-renamed" for i in range(29)]
    for section_id in superseded_ids:
        existing[section_id] = _absent_entry(parent="p0.md")

    check("fixture reproduces the 29% ratio", len(superseded_ids) / len(existing) > 0.10)

    result, error, tombstoned = _run_guarded_upsert(pages, existing)

    check(
        "superseded-only sync does not trip the guard",
        error == "" and result is not None,
        f"got error={error!r}",
    )
    check(
        "every superseded section is still tombstoned",
        tombstoned is not None and sorted(tombstoned) == sorted(superseded_ids),
        f"got {tombstoned!r}",
    )


def test_guard_still_refuses_absent_pages() -> None:
    """Absent PAGES still trip the guard. 10 live pages, 8 re-emitted, 2 gone."""
    pages = [_doc(f"page{i}.md") for i in range(10)]
    existing = {doc.external_id: _unchanged_entry(doc) for doc in pages}
    fetched = pages[:8]

    result, error, tombstoned = _run_guarded_upsert(fetched, existing)

    check(
        "two absent pages out of ten trip the guard",
        "Refusing to tombstone 2/10" in error and "Nothing was written" in error,
        f"got {error!r}",
    )
    check(
        "nothing is tombstoned when the guard refuses",
        tombstoned is None and result is None,
        f"got tombstoned={tombstoned!r}",
    )


def test_guard_counts_sections_of_absent_pages() -> None:
    """A section whose parent page is ALSO absent is guarded, not superseded."""
    pages = [_doc(f"page{i}.md") for i in range(8)]
    existing = {doc.external_id: _unchanged_entry(doc) for doc in pages}
    existing["gone.md"] = _absent_entry(parent=None)
    existing["gone.md#00-x"] = _absent_entry(parent="gone.md")

    result, error, tombstoned = _run_guarded_upsert(pages, existing)

    check(
        "a page and a section of that same absent page both count as guarded",
        "Refusing to tombstone 2/10" in error and "Nothing was written" in error,
        f"got {error!r}",
    )
    check(
        "the guard refuses before any tombstone",
        tombstoned is None and result is None,
        f"got tombstoned={tombstoned!r}",
    )


def test_guard_mixed_under_threshold_proceeds() -> None:
    """40 superseded sections + 5 absent pages over 100 live rows. Only the 5
    pages are guarded (5% <= 10%), so upsert proceeds and tombstones all 45."""
    pages = [_doc(f"p{i}.md") for i in range(55)]
    existing = {doc.external_id: _unchanged_entry(doc) for doc in pages}

    superseded_ids = [f"p0.md#{i:02d}-renamed" for i in range(40)]
    for section_id in superseded_ids:
        existing[section_id] = _absent_entry(parent="p0.md")
    absent_page_ids = [f"gone{i}.md" for i in range(5)]
    for page_id in absent_page_ids:
        existing[page_id] = _absent_entry(parent=None)

    check("fixture has exactly 100 live rows", len(existing) == 100, f"got {len(existing)}")

    result, error, tombstoned = _run_guarded_upsert(pages, existing)

    check(
        "5% guarded is under the threshold -- the sync proceeds",
        error == "" and result is not None,
        f"got error={error!r}",
    )
    check(
        "all 45 absent rows -- superseded and guarded alike -- are tombstoned",
        tombstoned is not None
        and sorted(tombstoned) == sorted(superseded_ids + absent_page_ids),
        f"got {None if tombstoned is None else len(tombstoned)} ids",
    )


def test_guard_refusal_message_includes_superseded_count() -> None:
    """When the guard fires with both guarded and superseded rows, the error
    message must carry superseded=N so an operator can read the diagnostic."""
    pages = [_doc(f"page{i}.md") for i in range(10)]
    existing = {doc.external_id: _unchanged_entry(doc) for doc in pages}
    # 5 superseded sections (parent still in fetch -- exempt from guard)
    for i in range(5):
        existing[f"page0.md#{i:02d}-renamed"] = _absent_entry(parent="page0.md")
    # Only 2 pages re-emitted: 8 absent pages → 8/10 = 80% guarded → guard fires
    fetched = pages[:2]

    _, error, _ = _run_guarded_upsert(fetched, existing)

    check(
        "guard fires with high guarded ratio",
        "Refusing to tombstone 8/15" in error and "Nothing was written" in error,
        f"got {error!r}",
    )
    check(
        "refusal message names the superseded count",
        "superseded=5" in error,
        f"got {error[:300]!r}",
    )


def main() -> int:
    test_homogeneous_rows_stay_one_group()
    test_review_reset_row_is_isolated()
    test_no_row_is_lost_or_duplicated()
    test_order_preserved_within_group()
    test_empty_input()
    test_describe_absent_splits_moved_sections_from_absent_pages()
    test_describe_absent_caps_samples()
    test_describe_absent_caps_samples_moved_sections()
    test_guard_error_explains_and_still_refuses()
    test_split_superseded_uses_stored_parent()
    test_guard_allows_superseded_sections()
    test_guard_still_refuses_absent_pages()
    test_guard_counts_sections_of_absent_pages()
    test_guard_mixed_under_threshold_proceeds()
    test_guard_refusal_message_includes_superseded_count()

    print()
    total = PASSED + len(FAILED)
    print(f"{PASSED}/{total} assertions passed.")
    if FAILED:
        print("\nFAILED:")
        for label in FAILED:
            print(f"  - {label}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
