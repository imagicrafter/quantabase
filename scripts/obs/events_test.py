#!/usr/bin/env python3
"""The event log: validation, secret scrubbing, and "logging never breaks a job".

    python -m obs.events_test

No network: the sink is a fake.
"""

from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from obs import events  # noqa: E402


class FakeSink:
    def __init__(self, *, fail: bool = False) -> None:
        self.rows: list[dict] = []
        self.fail = fail

    def write(self, row: dict) -> None:
        if self.fail:
            raise RuntimeError("supabase down")
        self.rows.append(row)


def _emit(sink, **kw):
    buf = io.StringIO()
    with redirect_stdout(buf):
        events.emit("kb-engine", "puller-fireflies", kw.pop("event", "run.finished"), sink=sink, **kw)
    return buf.getvalue()


def test_row_has_expected_columns() -> None:
    sink = FakeSink()
    _emit(sink, status="ok", run_id="r1", duration_ms=12, attrs={"fetched": 3})
    row = sink.rows[0]
    assert row["service"] == "kb-engine" and row["component"] == "puller-fireflies"
    assert row["event"] == "run.finished" and row["level"] == "info" and row["status"] == "ok"
    assert row["run_id"] == "r1" and row["duration_ms"] == 12 and row["attrs"] == {"fetched": 3}


def test_stdout_json_line_always_written() -> None:
    out = _emit(FakeSink())
    assert json.loads(out.strip())["event"] == "run.finished"


def test_bad_event_name_rejected() -> None:
    for bad in ("Run Finished", "finished", "run.", "run.Finished"):
        try:
            events.build("s", "c", bad)
        except events.EventError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_bad_level_and_status_rejected() -> None:
    for kw in ({"level": "loud"}, {"status": "maybe"}):
        try:
            events.build("s", "c", "run.finished", **kw)
        except events.EventError:
            continue
        raise AssertionError(f"accepted {kw}")


def test_secret_keys_scrubbed_recursively() -> None:
    row = events.build("s", "c", "run.finished", attrs={
        "GITHUB_TOKEN": "ghp_x", "nested": {"api_key": "k", "ok": 1}, "fine": "v",
    })
    assert row["attrs"] == {"GITHUB_TOKEN": "[redacted]", "nested": {"api_key": "[redacted]", "ok": 1}, "fine": "v"}


def test_sink_failure_never_raises_and_still_prints() -> None:
    lines = _emit(FakeSink(fail=True)).strip().splitlines()
    assert [json.loads(x)["event"] for x in lines] == ["run.finished", "obs.sink_failed"]


def test_invalid_event_never_raises_from_emit() -> None:
    buf = io.StringIO()
    with redirect_stdout(buf):
        events.emit("s", "c", "NOT VALID", sink=FakeSink())  # must not raise
    assert "obs.invalid_event" in buf.getvalue()


def test_input_attrs_not_mutated() -> None:
    attrs = {"token": "x"}
    events.build("s", "c", "run.finished", attrs=attrs)
    assert attrs == {"token": "x"}


def test_run_emits_start_and_finish_ok() -> None:
    sink = FakeSink()
    with redirect_stdout(io.StringIO()):
        with events.run("kb-engine", "puller-fireflies", sink=sink) as r:
            r.attrs = {"fetched": 2}
    names = [(x["event"], x["status"]) for x in sink.rows]
    assert names == [("run.started", None), ("run.finished", "ok")]
    assert sink.rows[0]["run_id"] == sink.rows[1]["run_id"]
    assert sink.rows[1]["attrs"] == {"fetched": 2} and sink.rows[1]["duration_ms"] >= 0


def test_run_marks_failure_and_reraises() -> None:
    sink = FakeSink()
    try:
        with redirect_stdout(io.StringIO()):
            with events.run("kb-engine", "puller-fireflies", sink=sink):
                raise ValueError("boom")
    except ValueError:
        pass
    else:
        raise AssertionError("exception swallowed")
    last = sink.rows[-1]
    assert last["status"] == "failed" and last["level"] == "error"
    assert last["attrs"]["error"] == "ValueError: boom"


def test_run_status_can_be_set_to_failed_without_raising() -> None:
    sink = FakeSink()
    with redirect_stdout(io.StringIO()):
        with events.run("kb-engine", "x", sink=sink) as r:
            r.fail("wiki push failed")
    last = sink.rows[-1]
    assert last["status"] == "failed" and last["attrs"]["error"] == "wiki push failed"


def test_cli_emit_parses_attrs() -> None:
    from obs import __main__ as cli

    sink = FakeSink()
    with redirect_stdout(io.StringIO()):
        code = cli.main(
            ["emit", "--service", "agents", "--component", "kb-health", "--event", "health.fixed",
             "--status", "ok", "--attr", "rule=meeting-links", "--attr", "n=2"],
            sink=sink,
        )
    assert code == 0 and sink.rows[0]["attrs"] == {"rule": "meeting-links", "n": "2"}


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
