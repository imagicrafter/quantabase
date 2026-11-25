#!/usr/bin/env python3
"""A puller run leaves start/finish events, and a wiki warning makes it failed.

    python -m pullers.run_events_test
"""

from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.run_events import observe  # noqa: E402
from pullers.runner import SourceReceipt  # noqa: E402


class FakeSink:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def write(self, row: dict) -> None:
        self.rows.append(row)


def _observe(receipt: SourceReceipt, *, dry_run: bool = False):
    sink = FakeSink()
    with redirect_stdout(io.StringIO()):
        out = observe("fireflies", lambda: receipt, dry_run=dry_run, sink=sink)
    assert out is receipt
    return sink.rows


def test_clean_run_is_ok_with_counts() -> None:
    r = SourceReceipt(source="fireflies", ok=True, ingest={"scanned": 2, "inserted": 1}, hook={"wiki_written": 1})
    rows = _observe(r)
    assert [x["event"] for x in rows] == ["run.started", "run.finished"]
    done = rows[-1]
    assert done["component"] == "puller-fireflies" and done["service"] == "kb-engine"
    assert done["status"] == "ok"
    assert done["attrs"]["ingest"] == {"scanned": 2, "inserted": 1}
    assert done["attrs"]["hook"] == {"wiki_written": 1}


def test_wiki_error_marks_run_failed() -> None:
    r = SourceReceipt(source="fireflies", ok=True, hook={"wiki_error": "push rejected"})
    done = _observe(r)[-1]
    assert done["status"] == "failed" and done["attrs"]["error"] == "wiki push rejected"


def test_receipt_error_marks_run_failed() -> None:
    r = SourceReceipt(source="fireflies", ok=False, error="RuntimeError: boom")
    done = _observe(r)[-1]
    assert done["status"] == "failed" and done["attrs"]["error"] == "RuntimeError: boom"


def test_stood_down_is_skipped_not_failed() -> None:
    r = SourceReceipt(source="fireflies", ok=True, stood_down=True)
    assert _observe(r)[-1]["status"] == "skipped"


def test_skipped_payloads_leave_a_warn_event_but_the_run_stays_ok() -> None:
    skipped = [{"index": 0, "external_id": "abc", "reason": "Fireflies transcript abc has no sentences"}]
    r = SourceReceipt(source="fireflies", ok=True, skipped=skipped)
    rows = _observe(r)
    assert [x["event"] for x in rows] == ["run.started", "payload.skipped", "run.finished"]
    warn = rows[1]
    assert warn["level"] == "warn" and warn["component"] == "puller-fireflies"
    assert warn["run_id"] == rows[-1]["run_id"]
    assert warn["attrs"] == {"count": 1, "skipped": skipped}
    assert rows[-1]["status"] == "ok" and rows[-1]["attrs"]["skipped"] == skipped


def test_no_skips_no_warn_event() -> None:
    rows = _observe(SourceReceipt(source="fireflies", ok=True))
    assert "payload.skipped" not in [x["event"] for x in rows]


def test_dry_run_emits_nothing() -> None:
    assert _observe(SourceReceipt(source="fireflies", ok=True), dry_run=True) == []


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(error).__name__}: {error}")
    sys.exit(1 if failed else 0)
