"""`pullers.run_issues` and the two places `runner.run_source` calls it.

No network and no database: a fake client records the calls.
"""

from __future__ import annotations

import sys
import types
from contextlib import contextmanager

import pytest

if "dotenv" not in sys.modules:
    _stub = types.ModuleType("dotenv")
    _stub.dotenv_values = lambda *_a, **_k: {}
    sys.modules["dotenv"] = _stub

from pullers import run_issues, runner  # noqa: E402


class HTTPError(Exception):
    def __init__(self, status_code: int):
        super().__init__(f"upstream answered {status_code}")
        self.status_code = status_code


class FakeSb:
    """Records rpc calls; `broken=True` makes every call raise."""

    def __init__(self, *, broken: bool = False):
        self.calls: list[tuple[str, dict]] = []
        self.broken = broken

    def schema(self, _name: str):
        return self

    def rpc(self, fn: str, params: dict):
        if self.broken:
            raise RuntimeError("database is down")
        self.calls.append((fn, params))
        return self

    def execute(self):
        return types.SimpleNamespace(data=None)


def _count(value: int):
    return lambda _name, *, sb: value


def _names(sb: FakeSb) -> list[str]:
    return [fn for fn, _ in sb.calls]


# -- report_failure ----------------------------------------------------------

def test_an_ordinary_failure_opens_an_issue_at_once() -> None:
    sb = FakeSb()
    opened = run_issues.report_failure("drive", ValueError("bad value"), sb=sb, failure_count=_count(1))
    assert opened is True
    fn, params = sb.calls[0]
    assert fn == "issue_upsert"
    assert params["p_category"] == "source_failure"
    assert params["p_dedupe_key"] == "run-drive"
    assert params["p_source"] == "drive"
    assert params["p_error_class"] == "ValueError"


@pytest.mark.parametrize("error", [HTTPError(502), HTTPError(503), HTTPError(504), TimeoutError("slow")])
def test_a_first_short_outage_opens_nothing(error: BaseException) -> None:
    sb = FakeSb()
    assert run_issues.report_failure("drive", error, sb=sb, failure_count=_count(1)) is False
    assert sb.calls == []


@pytest.mark.parametrize("failures", [2, 3, 10])
def test_a_repeated_short_outage_opens_an_issue(failures: int) -> None:
    sb = FakeSb()
    assert run_issues.report_failure("drive", HTTPError(503), sb=sb, failure_count=_count(failures)) is True
    assert _names(sb) == ["issue_upsert"]


def test_rate_limiting_is_not_a_short_outage() -> None:
    sb = FakeSb()
    assert run_issues.report_failure("drive", HTTPError(429), sb=sb, failure_count=_count(1)) is True
    assert _names(sb) == ["issue_upsert"]


def test_an_unreadable_failure_count_opens_the_issue() -> None:
    def boom(_name, *, sb):
        raise RuntimeError("cannot read state")

    sb = FakeSb()
    assert run_issues.report_failure("drive", HTTPError(503), sb=sb, failure_count=boom) is True
    assert _names(sb) == ["issue_upsert"]


def test_the_failure_count_is_not_read_for_an_ordinary_failure() -> None:
    def boom(_name, *, sb):
        raise AssertionError("must not be called")

    assert run_issues.report_failure("drive", KeyError("k"), sb=FakeSb(), failure_count=boom) is True


def test_a_broken_issue_log_never_raises_on_failure(capsys) -> None:
    opened = run_issues.report_failure(
        "drive", ValueError("secret title text"), sb=FakeSb(broken=True), failure_count=_count(5)
    )
    assert opened is False
    err = capsys.readouterr().err
    assert "could not log the issue" in err
    assert "secret title text" not in err and "database is down" not in err


# -- report_clean ------------------------------------------------------------

def test_a_clean_run_closes_the_issue_with_proof() -> None:
    sb = FakeSb()
    assert run_issues.report_clean("drive", {}, sb=sb) is True
    fn, params = sb.calls[0]
    assert fn == "issue_close_by_key"
    assert params["p_dedupe_key"] == "run-drive"
    assert params["p_proof"].startswith("clean run at 20") and params["p_proof"].endswith("Z")


def test_a_run_with_a_wiki_warning_is_not_proof() -> None:
    sb = FakeSb()
    assert run_issues.report_clean("fireflies", {"wiki_error": "push failed"}, sb=sb) is False
    assert sb.calls == []


def test_a_broken_issue_log_never_fails_a_clean_run(capsys) -> None:
    assert run_issues.report_clean("drive", None, sb=FakeSb(broken=True)) is False
    assert "could not close the issue" in capsys.readouterr().err


# -- runner.run_source -------------------------------------------------------

@pytest.fixture
def wired(monkeypatch):
    """`run_source` with every collaborator replaced; returns the call log."""
    log: list[tuple] = []
    sb = FakeSb()

    @contextmanager
    def fake_lock(*_a, **_k):
        yield True

    upserted = types.SimpleNamespace(
        scanned=0, inserted=0, updated=0, unchanged=0, tombstoned=0, revived=0, embedded=0
    )
    monkeypatch.setattr(runner, "get_supabase_ingest", lambda: sb)
    monkeypatch.setattr(runner.cursors, "with_lock", fake_lock)
    monkeypatch.setattr(runner.cursors, "get_cursor", lambda *_a, **_k: {})
    monkeypatch.setattr(runner.cursors, "set_cursor", lambda *_a, **_k: None)
    monkeypatch.setattr(
        runner.cursors, "record_run", lambda name, **kw: log.append(("record_run", kw["success"]))
    )
    monkeypatch.setattr(runner.ingest, "upsert", lambda *_a, **_k: upserted)
    monkeypatch.setattr(runner.review_apply, "apply_pending", lambda **_k: None)
    monkeypatch.setattr(runner, "_triage_and_distil", lambda *_a: (0, 0))
    monkeypatch.setattr(runner.review_queue, "build_batch", lambda **_k: types.SimpleNamespace(items=[]))
    monkeypatch.setattr(
        runner.run_issues, "report_failure",
        lambda name, error, *, sb: log.append(("report_failure", name, type(error).__name__)),
    )
    monkeypatch.setattr(
        runner.run_issues, "report_clean",
        lambda name, hook, *, sb: log.append(("report_clean", name)),
    )

    def install(fetch):
        puller = types.SimpleNamespace(SOURCE="fake", FULL_SYNC=False, BRONZE=False, fetch=fetch)
        monkeypatch.setitem(runner.REGISTRY, "fake", puller)
        return log

    return install


def _fail(_cursor, *, sb):
    raise HTTPError(500)


def test_a_failed_run_reports_after_recording_and_keeps_its_error(wired) -> None:
    log = wired(_fail)
    receipt = runner.run_source("fake")
    assert receipt.ok is False
    assert receipt.error == "HTTPError: upstream answered 500"
    assert log == [("record_run", False), ("report_failure", "fake", "HTTPError")]


def test_a_clean_run_reports_clean(wired) -> None:
    log = wired(lambda _cursor, *, sb: ([], {"at": 1}))
    receipt = runner.run_source("fake")
    assert receipt.ok is True and receipt.error is None
    assert log == [("record_run", True), ("report_clean", "fake")]


def test_a_dry_run_touches_no_issue(wired) -> None:
    log = wired(lambda _cursor, *, sb: ([], {}))
    assert runner.run_source("fake", dry_run=True).ok is True
    assert log == []
    log = wired(_fail)
    assert runner.run_source("fake", dry_run=True).ok is False
    assert ("report_failure", "fake", "HTTPError") not in log


def test_a_broken_issue_log_leaves_the_receipt_alone(wired, monkeypatch) -> None:
    """With the real run_issues and a database that refuses every call."""
    wired(_fail)
    monkeypatch.undo()
    broken = FakeSb(broken=True)

    @contextmanager
    def fake_lock(*_a, **_k):
        yield True

    monkeypatch.setattr(runner, "get_supabase_ingest", lambda: broken)
    monkeypatch.setattr(runner.cursors, "with_lock", fake_lock)
    monkeypatch.setattr(runner.cursors, "get_cursor", lambda *_a, **_k: {})
    monkeypatch.setattr(runner.cursors, "record_run", lambda *_a, **_k: None)
    monkeypatch.setitem(
        runner.REGISTRY, "fake",
        types.SimpleNamespace(SOURCE="fake", FULL_SYNC=False, BRONZE=False, fetch=_fail),
    )
    receipt = runner.run_source("fake")
    assert receipt.ok is False
    assert receipt.error == "HTTPError: upstream answered 500"


# -- cursors.consecutive_failures --------------------------------------------

class FakeStateSb:
    """Answers the one `connector_state` read with `rows`, or raises."""

    def __init__(self, rows=None, *, broken: bool = False):
        self.rows = rows or []
        self.broken = broken
        self.asked: list = []

    def schema(self, _name: str):
        return self

    def table(self, name: str):
        self.asked.append(name)
        return self

    def select(self, columns: str):
        self.asked.append(columns)
        return self

    def eq(self, column: str, value: str):
        self.asked.append((column, value))
        return self

    def limit(self, _n: int):
        return self

    def execute(self):
        if self.broken:
            raise RuntimeError("database is down")
        return types.SimpleNamespace(data=self.rows)


@pytest.mark.parametrize(
    ("rows", "expected"),
    [([], 0), ([{"consecutive_failures": None}], 0), ([{"consecutive_failures": 3}], 3)],
)
def test_consecutive_failures_reads_the_state_row(rows, expected) -> None:
    sb = FakeStateSb(rows)
    assert runner.cursors.consecutive_failures("drive", sb=sb) == expected
    assert sb.asked == ["connector_state", "consecutive_failures", ("source", "drive")]


def test_consecutive_failures_raises_a_cursor_error_when_unreadable() -> None:
    with pytest.raises(runner.cursors.CursorError):
        runner.cursors.consecutive_failures("drive", sb=FakeStateSb(broken=True))
