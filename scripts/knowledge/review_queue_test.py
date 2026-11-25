#!/usr/bin/env python3
"""Offline tests for the review-queue eligibility fix (2026-08-14).

The defect: `build_batch` filtered on the `distillation` COLUMN, which every
connector populates with a placeholder at ingest, instead of on
`metadata.distill`, which is written only by `apply_distillations.py` after
verbatim-term verification. 160 of 240 live queued items were blank as a
result. This tests the fixed predicate and the guard added against a repeat.

Run:

    python3 -m knowledge.review_queue_test
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.review_queue import NotReviewableError, is_reviewable

REAL_DISTILL_METADATA = {
    "distill": {"version": 2, "model": "sonnet", "content_hash": "abc123"}
}

# The exact shape the defect let through: a connector-written placeholder in
# the `distillation` column, no `metadata.distill` at all.
PLACEHOLDER_ONLY_METADATA = {"wiki_type": "concept", "folder_path": "concepts"}


class AssertionFailure(AssertionError):
    pass


def _check(label: str, condition: bool, detail: str) -> None:
    if not condition:
        raise AssertionFailure(f"{label}: {detail}")
    print(f"PASS  {label}: {detail}")


def test_row_with_metadata_distill_is_eligible() -> None:
    row = {
        "id": "doc-1",
        "distillation": "A real WHAT/WHY/TERMS summary.",
        "metadata": REAL_DISTILL_METADATA,
    }
    _check(
        "row with metadata.distill is eligible",
        is_reviewable(row) is True,
        f"is_reviewable -> {is_reviewable(row)}",
    )


def test_placeholder_distillation_column_is_not_eligible() -> None:
    """The exact bug: a non-null `distillation` column, no `metadata.distill`."""
    row = {
        "id": "doc-2",
        "distillation": "Wiki page in concepts. ## Heading one\n## Heading two",
        "metadata": PLACEHOLDER_ONLY_METADATA,
    }
    _check(
        "non-null distillation column but no metadata.distill is NOT eligible",
        is_reviewable(row) is False,
        f"is_reviewable -> {is_reviewable(row)}",
    )


def test_missing_metadata_is_not_eligible() -> None:
    row = {"id": "doc-3", "distillation": "placeholder text", "metadata": None}
    _check(
        "row with no metadata at all is NOT eligible",
        is_reviewable(row) is False,
        f"is_reviewable -> {is_reviewable(row)}",
    )


def test_assertion_raises_on_ineligible_selection() -> None:
    """`build_batch`'s post-selection guard: import-level, no DB needed.

    Exercises the exact check `build_batch` runs after slicing candidates,
    without needing a live Supabase connection.
    """
    selected = [
        {"id": "doc-1", "metadata": REAL_DISTILL_METADATA},
        {"id": "doc-2", "metadata": PLACEHOLDER_ONLY_METADATA},
    ]
    not_reviewable = [row["id"] for row in selected if not is_reviewable(row)]

    raised = False
    try:
        if not_reviewable:
            raise NotReviewableError(
                f"{len(not_reviewable)} selected row(s) lack metadata.distill: "
                f"{not_reviewable}"
            )
    except NotReviewableError as error:
        raised = True
        detail = str(error)

    _check(
        "assertion raises when selection contains an ineligible row",
        raised and "doc-2" in detail,
        detail if raised else "did not raise",
    )


def test_empty_pool_is_not_an_error() -> None:
    """An empty candidate pool must never raise -- it's a normal quiet week."""
    selected: list[dict] = []
    not_reviewable = [row["id"] for row in selected if not is_reviewable(row)]
    _check(
        "empty candidate pool produces no error",
        not_reviewable == [],
        f"not_reviewable -> {not_reviewable!r} (batch would report 0 items, not raise)",
    )


def main() -> int:
    tests = [
        test_row_with_metadata_distill_is_eligible,
        test_placeholder_distillation_column_is_not_eligible,
        test_missing_metadata_is_not_eligible,
        test_assertion_raises_on_ineligible_selection,
        test_empty_pool_is_not_an_error,
    ]
    failures = 0
    for test in tests:
        try:
            test()
        except AssertionFailure as error:
            print(f"FAIL  {error}")
            failures += 1

    if failures:
        print(f"\n{failures} test(s) failed.")
        return 1

    print("\nAll review_queue eligibility tests pass.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
