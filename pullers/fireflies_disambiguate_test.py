#!/usr/bin/env python3
"""`_disambiguate()` gives every transcript in a batch a unique external_id.

    python -m pullers.fireflies_disambiguate_test

Pure function test -- no Fireflies API, no database.

Regression for 2026-09-28: one "Client Scope" call was recorded four times (one
Fireflies bot per attendee). Two recordings started in the same minute, both
got the `-1735` suffix, and `ingest._validate_batch` rejected the whole run
with `Duplicate external_id '2026-09-28-client-scope-1735.md'`. Because the run
failed, the cursor never advanced and every later run hit the same batch.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.fireflies import _disambiguate, _external_id, _parse_meeting_date  # noqa: E402


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)


def _raw(transcript_id: str, title: str, iso: str) -> dict:
    return {"id": transcript_id, "title": title, "date": _ms(iso)}


def _ids(raws: list[dict]) -> list[str]:
    out = []
    for raw in _disambiguate(raws):
        date_str = _parse_meeting_date(raw["date"]).strftime("%Y-%m-%d")
        out.append(_external_id(raw["title"], date_str, raw.get("_external_id_suffix")))
    return out


def test_same_minute_recordings_get_unique_ids() -> None:
    raws = [
        _raw("01M3MGWH9GQ67BE7XYD5V76PR2", "Client Scope", "2026-09-28T17:26:55"),
        _raw("01M3MGVF82D11EKH10WBTS4XM4", "Client Scope", "2026-09-28T17:30:00"),
        _raw("01M3MHAQAN06C9JG2YAZSZG9WP", "Client Scope", "2026-09-28T17:35:10"),
        _raw("01M3MHD84HQ79Q5Z4ZF8MGB78B", "Client Scope", "2026-09-28T17:35:40"),
    ]
    ids = _ids(raws)
    assert len(ids) == len(set(ids)), f"duplicate external_ids: {ids}"


def test_earliest_keeps_bare_id_and_first_suffix_stays_hhmm() -> None:
    """Existing rows keep their identity: bare for the earliest, HHMM for the next."""
    raws = [
        _raw("bbbbbb222", "Client Scope", "2026-09-28T17:35:40"),
        _raw("aaaaaa111", "Client Scope", "2026-09-28T17:35:10"),
        _raw("cccccc333", "Client Scope", "2026-09-28T17:26:55"),
    ]
    by_id = dict(zip([r["id"] for r in raws], _ids(raws)))
    assert by_id["cccccc333"] == "2026-09-28-client-scope.md"
    assert by_id["aaaaaa111"] == "2026-09-28-client-scope-1735.md"
    assert by_id["bbbbbb222"] == "2026-09-28-client-scope-1735-bbbbbb.md"


def test_titles_that_slugify_alike_are_one_group() -> None:
    """'Client Scope' and 'Client scope!' both become 'client-scope' -- they must not collide."""
    raws = [
        _raw("aaaaaa111", "Client Scope", "2026-09-28T10:00:00"),
        _raw("bbbbbb222", "Client scope!", "2026-09-28T11:00:00"),
    ]
    ids = _ids(raws)
    assert len(ids) == len(set(ids)), f"duplicate external_ids: {ids}"


def test_order_independent() -> None:
    raws = [
        _raw("aaaaaa111", "Client Scope", "2026-09-28T17:35:10"),
        _raw("bbbbbb222", "Client Scope", "2026-09-28T17:35:40"),
        _raw("cccccc333", "Client Scope", "2026-09-28T17:26:55"),
    ]
    assert sorted(_ids(raws)) == sorted(_ids(list(reversed(raws))))


def test_input_not_mutated() -> None:
    raws = [
        _raw("aaaaaa111", "Client Scope", "2026-09-28T17:35:10"),
        _raw("bbbbbb222", "Client Scope", "2026-09-28T17:35:40"),
    ]
    before = [dict(r) for r in raws]
    _disambiguate(raws)
    assert raws == before


TESTS = [
    test_same_minute_recordings_get_unique_ids,
    test_earliest_keeps_bare_id_and_first_suffix_stays_hhmm,
    test_titles_that_slugify_alike_are_one_group,
    test_order_independent,
    test_input_not_mutated,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except AssertionError as error:
            failed += 1
            print(f"FAIL {test.__name__}: {error}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
