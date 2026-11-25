#!/usr/bin/env python3
"""`fireflies.fetch` re-lists recent days but never moves its cursor backwards.

    python -m pullers.fireflies_cursor_test

No network: the listing and transcript calls are patched.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers import fireflies  # noqa: E402

CURSOR = {"last_checked": "2026-10-06T19:02:56+00:00"}


def test_quiet_run_keeps_cursor() -> None:
    with mock.patch.object(fireflies, "_list_stubs", return_value=[]) as listing:
        _raws, cursor = fireflies.fetch(CURSOR)
    assert cursor == CURSOR
    assert listing.call_args[0][0].isoformat() == "2026-10-04T19:02:56+00:00"


def test_new_meeting_advances_cursor() -> None:
    full = {"id": "x", "title": "T", "date": "2026-10-08T15:00:00Z", "sentences": [{"text": "hi"}]}
    with mock.patch.object(fireflies, "_list_stubs", return_value=[{"id": "x"}]), \
         mock.patch.object(fireflies, "_gql", return_value={"transcript": full}), \
         mock.patch.object(fireflies.time, "sleep"):
        raws, cursor = fireflies.fetch(CURSOR)
    assert len(raws) == 1
    assert cursor["last_checked"].startswith("2026-10-08T15:00:00")


TESTS = [test_quiet_run_keeps_cursor, test_new_meeting_advances_cursor]


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
