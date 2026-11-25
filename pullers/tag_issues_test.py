"""`pullers.tag_issues`: one unknown-tag issue per source, opened and closed."""

from __future__ import annotations

import types

from pullers import tag_issues


class FakeSb:
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


def _reader(rows):
    return lambda _source, _sb: rows


def test_unknown_tags_open_one_issue_with_a_count() -> None:
    sb = FakeSb()
    rows = [("unknown_tag", "unknown_tag:finanse"), ("unknown_tag", "unknown_tag:finanse")]
    assert tag_issues.report("drive", sb=sb, read=_reader(rows)) == "opened"
    (name, params), = sb.calls
    assert name == "issue_upsert"
    assert params["p_category"] == "unknown_tag"
    assert params["p_dedupe_key"] == "unknown-tag-drive"
    assert params["p_source"] == "drive"
    assert params["p_detail"].startswith("2 item(s)")
    assert "finanse" in params["p_detail"]


def test_no_unknown_tag_closes_the_issue() -> None:
    sb = FakeSb()
    assert tag_issues.report("wiki", sb=sb, read=_reader([])) == "closed"
    (name, params), = sb.calls
    assert name == "issue_close_by_key"
    assert params["p_dedupe_key"] == "unknown-tag-wiki"


def test_the_tag_list_is_capped_in_count_and_length() -> None:
    rows = [("unknown_tag", f"unknown_tag:topic{n}" + "x" * 80) for n in range(9)]
    issue = tag_issues.build_issue("drive", rows)
    listed = issue.detail.split(": ", 1)[1]
    assert "and 4 more" in listed
    tags = listed.split(" and ")[0].split(", ")
    assert len(tags) == tag_issues.MAX_TAGS
    assert all(len(tag) <= tag_issues.MAX_TAG_CHARS for tag in tags)
    assert len(issue.detail) <= 500


def test_tag_text_is_reduced_to_tag_characters() -> None:
    rows = [("unknown_tag", "unknown_tag:Ann Example <ann@example.com>")]
    issue = tag_issues.build_issue("gmail", rows)
    assert "@" not in issue.detail and "<" not in issue.detail and " ann" not in issue.detail.lower().split(": ")[1]


def test_the_issue_holds_no_title_or_id() -> None:
    rows = [("unknown_tag", "unknown_tag:nope")]
    issue = tag_issues.build_issue("drive", rows)
    assert issue.title == "drive has items with an unknown tag"
    assert issue.detail == "1 item(s) carry a tag that names no topic: nope"


def test_a_database_failure_never_raises() -> None:
    assert tag_issues.report("drive", sb=FakeSb(broken=True), read=_reader([("unknown_tag",)])) == "failed"

    def boom(_source, _sb):
        raise RuntimeError("no")

    assert tag_issues.report("drive", sb=FakeSb(), read=boom) == "failed"


def test_read_signals_asks_only_for_this_sources_live_unknown_rows() -> None:
    seen: list[tuple] = []

    class Query:
        def __getattr__(self, name):
            def step(*args):
                seen.append((name, *args))
                return self
            return step

        def execute(self):
            return types.SimpleNamespace(data=[{"tag_signals": ["unknown_tag", "unknown_tag:x"]}])

    class Sb:
        def schema(self, _name):
            return Query()

    assert tag_issues.read_signals("drive", Sb()) == [("unknown_tag", "unknown_tag:x")]
    assert ("select", "tag_signals") in seen, "no title, id or body is read"
    assert ("eq", "source", "drive") in seen
    assert ("is_", "deleted_at", "null") in seen
    assert ("contains", "tag_signals", ["unknown_tag"]) in seen


# -- where the runner calls it ------------------------------------------------

def _wire(monkeypatch, log):
    from contextlib import contextmanager

    from pullers import runner

    @contextmanager
    def fake_lock(*_a, **_k):
        yield True

    upserted = types.SimpleNamespace(
        scanned=0, inserted=0, updated=0, unchanged=0, tombstoned=0, revived=0, embedded=0
    )
    monkeypatch.setattr(runner, "get_supabase_ingest", lambda: FakeSb())
    monkeypatch.setattr(runner.cursors, "with_lock", fake_lock)
    monkeypatch.setattr(runner.cursors, "get_cursor", lambda *_a, **_k: {})
    monkeypatch.setattr(runner.cursors, "set_cursor", lambda *_a, **_k: None)
    monkeypatch.setattr(runner.cursors, "record_run", lambda *_a, **_k: None)
    monkeypatch.setattr(runner.ingest, "upsert", lambda *_a, **_k: upserted)
    monkeypatch.setattr(runner.review_apply, "apply_pending", lambda **_k: None)
    monkeypatch.setattr(runner, "_triage_and_distil", lambda *_a: (0, 0))
    monkeypatch.setattr(runner.review_queue, "build_batch", lambda **_k: types.SimpleNamespace(items=[]))
    monkeypatch.setattr(runner.run_issues, "report_clean", lambda *_a, **_k: True)
    monkeypatch.setattr(runner.run_issues, "report_failure", lambda *_a, **_k: True)
    monkeypatch.setattr(runner.tag_issues, "report", lambda name, *, sb: log.append(name))
    return runner


def _puller(fetch):
    return types.SimpleNamespace(SOURCE="fake", FULL_SYNC=False, BRONZE=False, fetch=fetch)


def test_a_clean_run_updates_the_unknown_tag_issue(monkeypatch) -> None:
    log: list[str] = []
    runner = _wire(monkeypatch, log)
    monkeypatch.setitem(runner.REGISTRY, "fake", _puller(lambda _c, *, sb: ([], {})))
    assert runner.run_source("fake").ok is True
    assert log == ["fake"]


def test_a_dry_run_and_a_failed_run_leave_it_alone(monkeypatch) -> None:
    log: list[str] = []
    runner = _wire(monkeypatch, log)
    monkeypatch.setitem(runner.REGISTRY, "fake", _puller(lambda _c, *, sb: ([], {})))
    assert runner.run_source("fake", dry_run=True).ok is True

    def fail(_cursor, *, sb):
        raise RuntimeError("down")

    monkeypatch.setitem(runner.REGISTRY, "fake", _puller(fail))
    assert runner.run_source("fake").ok is False
    assert log == []


def test_the_recorded_model_is_the_configured_one(monkeypatch) -> None:
    from pathlib import Path

    from knowledge import model_client

    monkeypatch.setattr(
        model_client, "_read_env",
        lambda: {"KNOWLEDGE_MODEL_BACKEND": "anthropic", "KNOWLEDGE_MODEL_ID": "some-model"},
    )
    assert model_client.model_label() == "anthropic:some-model"
    monkeypatch.setattr(model_client, "_read_env", lambda: {})
    assert model_client.model_label() == f"{model_client.DEFAULT_BACKEND}:{model_client.DEFAULT_MODEL}"
    source = (Path(__file__).parent / "runner.py").read_text(encoding="utf-8")
    assert '"model": model_label()' in source and "gpt-oss" not in source
