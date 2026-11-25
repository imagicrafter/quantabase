#!/usr/bin/env python3
"""`backfill_meeting_pages.pair_rows` never puts one meeting onto another's row.

    python -m pullers.backfill_meeting_pages_test

Pure: fake documents, raws and rows -- no Fireflies, no database.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.backfill_meeting_pages import pair_rows  # noqa: E402

WORDS = "ledger transition import engine claude skills dispatch routing invoice customer location statement"


@dataclass(frozen=True)
class Doc:
    external_id: str


def _raw(fid: str, text: str = WORDS) -> dict:
    return {"id": fid, "sentences": [{"text": f"{text} sentence number {i} words"} for i in range(40)]}


def _row(external_id: str, fid: str | None = None, text: str = WORDS) -> dict:
    body = "\n".join(f"**A** [00:0{i % 10}]: {text} sentence number {i} words" for i in range(40))
    return {"external_id": external_id, "body": body, "metadata": {"fireflies_id": fid} if fid else {}}


def test_fireflies_id_beats_name() -> None:
    docs = [Doc("2026-10-06-build.md"), Doc("2026-10-06-other.md")]
    raws = [_raw("B"), _raw("A")]
    rows = [_row("2026-10-06-build.md", fid="A")]
    pairs = pair_rows(docs, raws, rows)
    assert pairs == {1: rows[0]}, pairs  # A owns the row, even though doc 0 has its name


def test_overlap_never_claims_foreign_row() -> None:
    docs = [Doc("2026-10-06-build-session-1405.md")]
    raws = [_raw("B")]
    rows = [_row("2026-10-06-build-session.md", fid="A")]  # A was deleted from Fireflies
    assert pair_rows(docs, raws, rows) == {}


def test_overlap_matches_calendar_titled_row() -> None:
    docs = [Doc("2026-10-06-fireflies-title.md")]
    raws = [_raw("C")]
    rows = [_row("2026-10-06-calendar-title.md")]  # disk-era row, no fireflies_id
    assert pair_rows(docs, raws, rows) == {0: rows[0]}


def test_low_overlap_not_matched() -> None:
    docs = [Doc("2026-10-06-x.md")]
    raws = [_raw("C", text="completely unrelated words about gardening tomatoes watering")]
    rows = [_row("2026-10-06-y.md")]
    assert pair_rows(docs, raws, rows) == {}


def test_each_row_claimed_once() -> None:
    docs = [Doc("2026-10-06-a.md"), Doc("2026-10-06-a-1405.md")]
    raws = [_raw("A"), _raw("A2")]
    rows = [_row("2026-10-06-a.md")]
    pairs = pair_rows(docs, raws, rows)
    assert list(pairs) == [0], pairs


TESTS = [
    test_fireflies_id_beats_name,
    test_overlap_never_claims_foreign_row,
    test_overlap_matches_calendar_titled_row,
    test_low_overlap_not_matched,
    test_each_row_claimed_once,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
