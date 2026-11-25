#!/usr/bin/env python3
"""`fireflies.to_document` survives a transcript with no sentences.

    python -m pullers.fireflies_no_sentences_test

No network: `to_document()` is pure. `dotenv` is stubbed so importing
`fireflies` works wherever python-dotenv is not installed (it is only used for
reading the API key at fetch time, never in `to_document`).
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

if "dotenv" not in sys.modules:
    _stub = types.ModuleType("dotenv")
    _stub.dotenv_values = lambda *_a, **_k: {}
    sys.modules["dotenv"] = _stub

from pullers import fireflies  # noqa: E402
from pullers.base import SkipPayload  # noqa: E402

BASE_RAW = {
    "id": "ff1",
    "title": "Weekly sync",
    "date": "2026-11-02T15:00:00Z",
    "duration": 12,
    "organizer_email": "owner@example.com",
}


def _raw(**overrides) -> dict:
    return {**BASE_RAW, **overrides}


def test_sentences_present_unchanged() -> None:
    raw = _raw(sentences=[{"speaker_name": "A", "text": "hi", "start_time": 0}])
    doc = fireflies.to_document(raw)
    assert "**A** [00:00]: hi" in doc.body
    assert "fireflies_transcript_unavailable" not in doc.metadata


def test_no_sentences_no_notes_skips() -> None:
    shapes = [
        ({}, "absent"),
        ({"sentences": None}, "null"),
        ({"sentences": []}, "empty"),
    ]
    empty_summaries = [{}, {"summary": {}}, {"summary": {"overview": "", "notes": ""}}]
    for sentence_part, expected_shape in shapes:
        for summary_part in empty_summaries:
            raw = _raw(**sentence_part, **summary_part)
            try:
                fireflies.to_document(raw)
            except SkipPayload as skip:
                assert "ff1" in skip.reason
                assert f"sentences={expected_shape}" in skip.reason
            else:
                raise AssertionError(
                    f"expected SkipPayload for {sentence_part} / {summary_part}"
                )


def test_no_sentences_with_notes_ingests_notes_only() -> None:
    doc = fireflies.to_document(_raw(sentences=[], summary={"overview": "We agreed X"}))
    assert "We agreed X" in doc.body
    assert "(no transcript stored" in doc.body
    assert doc.metadata["fireflies_transcript_unavailable"] is True
    assert "fireflies_notes_unavailable" not in doc.metadata


def test_no_valueerror_any_more() -> None:
    cases = [
        _raw(),
        _raw(sentences=None),
        _raw(sentences=[]),
        _raw(sentences=[], summary={"overview": "We agreed X"}),
    ]
    for raw in cases:
        try:
            fireflies.to_document(raw)
        except ValueError as error:  # noqa: PERF203 -- a ValueError here is the regression
            raise AssertionError(f"to_document raised ValueError: {error}")
        except SkipPayload:
            pass


TESTS = [
    test_sentences_present_unchanged,
    test_no_sentences_no_notes_skips,
    test_no_sentences_with_notes_ingests_notes_only,
    test_no_valueerror_any_more,
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
