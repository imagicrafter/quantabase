#!/usr/bin/env python3
"""`fireflies_upstream_delete` safety rules, against a fake Fireflies client.

    python -m pullers.fireflies_upstream_delete_test

No network, no secrets.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.fireflies_upstream_delete import (  # noqa: E402
    RateLimited, delete_with_backoff, execute_enabled, sweep,
)

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


def _ms(days_old: int) -> int:
    return int((NOW - timedelta(days=days_old)).timestamp() * 1000)


class FakeClient:
    def __init__(self, throttle: dict[str, int] | None = None):
        self.deleted: list[str] = []
        self.calls: list[str] = []
        self.throttle = dict(throttle or {})  # id -> number of 429s before success

    def delete_transcript(self, tid: str) -> None:
        self.calls.append(tid)
        if self.throttle.get(tid, 0) > 0:
            self.throttle[tid] -= 1
            raise RateLimited()
        self.deleted.append(tid)


def _run(client, transcripts, captured, *, execute=False, days=90, log=None, max_backoffs=3):
    return sweep(
        client, transcripts, lambda tid: tid in captured,
        retention_days=days, now=NOW, execute=execute,
        log=(log.append if log is not None else (lambda _m: None)),
        sleep=lambda _s: None, max_backoffs=max_backoffs,
    )


def test_not_captured_never_deleted():
    c = FakeClient()
    r = _run(c, [{"id": "a", "date": _ms(200)}], captured=set(), execute=True)
    assert c.calls == [] and r.deleted == [] and r.skipped == [("a", "not captured")]


def test_younger_than_retention_never_deleted():
    c = FakeClient()
    r = _run(c, [{"id": "a", "date": _ms(10)}], captured={"a"}, execute=True)
    assert c.calls == [] and r.skipped == [("a", "within retention")]


def test_missing_date_never_deleted():
    c = FakeClient()
    r = _run(c, [{"id": "a"}], captured={"a"}, execute=True)
    assert c.calls == [] and r.skipped == [("a", "no date")]


def test_dry_run_deletes_nothing_and_logs_candidates():
    c, log = FakeClient(), []
    r = _run(c, [{"id": "a", "date": _ms(200)}], captured={"a"}, execute=False, log=log)
    assert c.calls == [] and r.deleted == [] and r.eligible == ["a"]
    assert any("DRY-RUN" in m and "a" in m for m in log)


def test_execute_deletes_only_eligible():
    c = FakeClient()
    ts = [{"id": "old", "date": _ms(200)}, {"id": "new", "date": _ms(5)}, {"id": "uncap", "date": _ms(300)}]
    r = _run(c, ts, captured={"old", "new"}, execute=True)
    assert c.deleted == ["old"] and r.deleted == ["old"]


def test_every_candidate_logged():
    log = []
    ts = [{"id": "old", "date": _ms(200)}, {"id": "new", "date": _ms(5)}]
    _run(FakeClient(), ts, captured={"old", "new"}, execute=True, log=log)
    assert any("old" in m for m in log) and any("new" in m for m in log)


def test_429_backs_off_then_succeeds():
    c = FakeClient(throttle={"a": 2})
    r = _run(c, [{"id": "a", "date": _ms(200)}], captured={"a"}, execute=True)
    assert c.calls == ["a", "a", "a"] and r.deleted == ["a"]


def test_429_gives_up_and_halts_run():
    c = FakeClient(throttle={"a": 99})
    ts = [{"id": "a", "date": _ms(200)}, {"id": "b", "date": _ms(201)}]
    r = _run(c, ts, captured={"a", "b"}, execute=True, max_backoffs=2)
    assert c.deleted == [] and "b" not in c.calls and r.errors and r.halted


def test_delete_with_backoff_sleeps_between_retries():
    sleeps, n = [], {"i": 0}

    def flaky(_tid):
        n["i"] += 1
        if n["i"] < 3:
            raise RateLimited()

    delete_with_backoff(flaky, "a", sleep=sleeps.append, max_backoffs=5, backoff_seconds=7)
    assert sleeps == [7, 7]


def test_execute_flag_default_off():
    assert execute_enabled({}) is False
    assert execute_enabled({"FIREFLIES_UPSTREAM_DELETE_EXECUTE": "false"}) is False
    assert execute_enabled({"FIREFLIES_UPSTREAM_DELETE_EXECUTE": "true"}) is True


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]


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
