"""`kbe issues`: read-only, administrators only, through the database's own functions."""

from __future__ import annotations

import json

import pytest

from kbe import cli, issues, people, state
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner, make_context

ISSUE_ID = "00000000-0000-0000-0000-0000000000a1"
OPEN = {"id": ISSUE_ID, "category": "source_failure", "source": "wiki",
        "title": "wiki run failed", "status": "open", "occurrences": 3,
        "opened_at": "2026-01-01T00:00:00+00:00", "has_card": False}
CLOSED = {**OPEN, "id": "00000000-0000-0000-0000-0000000000a2", "status": "closed",
          "category": "unknown_tag", "source": None, "occurrences": 1}
DETAIL = {**OPEN, "detail": "TimeoutError after 30s", "error_class": "TimeoutError",
          "reported_by": "system", "closed_at": None, "pr_url": None, "proof": None}


class Store:
    def __init__(self, detail=DETAIL, error=None):
        self.calls, self.detail, self.error = [], detail, error

    def call(self, function, args=None):
        self.calls.append((function, dict(args or {})))
        if self.error:
            raise self.error
        if function == "issues_list":
            return [OPEN, CLOSED] if args["p_include_closed"] else [OPEN]
        return self.detail


@pytest.fixture
def env(tmp_path, monkeypatch):
    def build(store, owner="owner@example.com"):
        ctx, seen = make_context(tmp_path, FakeRunner())
        if owner:
            state.save(ctx.state_file, state.with_answer(state.empty(), "owner_email", owner))
        monkeypatch.setattr(people, "store", lambda _ctx: store)
        return ctx, seen
    return build


def test_list_shows_open_issues_as_the_owner(env):
    store = Store()
    ctx, seen = env(store)
    assert cli.main(["issues", "list"], ctx) == 0
    assert store.calls == [
        ("issues_list", {"p_email": "owner@example.com", "p_include_closed": False})]
    assert seen == [f"{ISSUE_ID}  open  source_failure  wiki  wiki run failed  x3"]


def test_list_all_includes_closed_and_json_is_the_raw_list(env):
    store = Store()
    ctx, seen = env(store)
    assert cli.main(["issues", "list", "--all", "--json", "--as", "admin@example.com"], ctx) == 0
    assert store.calls[0][1] == {"p_email": "admin@example.com", "p_include_closed": True}
    assert json.loads(seen[0]) == [OPEN, CLOSED]


def test_an_empty_list_says_so(env, monkeypatch):
    store = Store()
    monkeypatch.setattr(store, "call", lambda *_a, **_k: [])
    ctx, seen = env(store)
    cli.main(["issues", "list"], ctx)
    cli.main(["issues", "list", "--all"], ctx)
    assert seen == ["No open issues.", "No issues."]


def test_show_prints_every_stored_field_and_the_detail(env):
    store = Store()
    ctx, seen = env(store)
    assert cli.main(["issues", "show", ISSUE_ID.upper()], ctx) == 0
    assert store.calls == [("issue_detail", {"p_email": "owner@example.com", "p_id": ISSUE_ID})]
    assert seen[0] == "wiki run failed" and seen[-1] == "TimeoutError after 30s"
    assert "error class:  TimeoutError" in seen and not [l for l in seen if "pr url" in l]


def test_show_refuses_a_bad_id_before_the_database(env, capsys):
    store = Store()
    ctx, _seen = env(store)
    assert cli.main(["issues", "show", "1; drop table x"], ctx) == 2
    assert store.calls == []


def test_show_an_unknown_issue_and_a_refusal(env, capsys):
    ctx, _seen = env(Store(detail=None))
    assert cli.main(["issues", "show", ISSUE_ID], ctx) == 1
    assert "no issue" in capsys.readouterr().err
    ctx, _seen = env(Store(error=KbeError("administrators only")))
    assert cli.main(["issues", "list"], ctx) == 1
    assert "administrators only" in capsys.readouterr().err


def test_an_administrator_must_be_known(env, capsys):
    ctx, _seen = env(Store(), owner=None)
    assert cli.main(["issues", "list"], ctx) == 2
    assert "--as EMAIL" in capsys.readouterr().err


def test_no_command_changes_anything():
    assert not [name for name in vars(issues) if "apply" in name or "write" in name]


def test_text_written_by_people_cannot_drive_the_terminal():
    """An issue title is a reader's own words; escape codes in it are not run."""
    hostile = {**DETAIL, "title": "bad\x1b]52;c;AAAA\x07 title\x1b[2K\r\u202e",
               "detail": "line one\nline\x1b[1A two\x9b"}
    line = issues.issue_line(hostile)
    shown = "\n".join(issues.issue_detail_lines(hostile))
    for text in (line, shown):
        assert not any(ch in text for ch in "\x1b\x07\r\x9b\u202e")
    assert "\n" not in line and "line one\nline" in shown
