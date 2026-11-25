"""`kbe sources list`: enabled sources from the applied config, last runs from
connector state, and never a stored error message."""

from __future__ import annotations

import argparse
import json

import pytest

from kbe import cli, config_store, ingest_client, pg, proc, schema, sources_state
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner, make_context

API_LINES = (
    "SUPABASE_URL=https://example.supabase.co\n"
    "SUPABASE_ANON_KEY=fake-anon-key-0123456789\n"
    "SUPABASE_JWT_SECRET=fake-jwt-secret-0123456789-0123456789\n"
)
DB_LINE = "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n"
CONFIG = {
    "version": 1,
    "sources": {
        "wiki": {"enabled": True, "repo": "acme/knowledge"},
        "drive": {"enabled": True},
        "fireflies": {"enabled": False},
    },
}
ROWS = [
    {"source": "wiki", "last_run_at": "2026-01-02T11:00:00+00:00",
     "last_success_at": "2026-01-02T11:00:00+00:00", "consecutive_failures": 0},
    {"source": "drive", "last_run_at": "2026-01-02T11:20:00+00:00",
     "last_success_at": "2026-01-01T11:20:00+00:00", "consecutive_failures": 3},
]


class Store:
    def __init__(self, config=CONFIG):
        self.config = config

    def get(self):
        return self.config


class Table:
    def __init__(self, rows, error=None):
        self.rows, self.error, self.calls = rows, error, []

    def __getattr__(self, name):
        def method(*args):
            self.calls.append((name, args))
            return self
        return method

    def execute(self):
        if self.error:
            raise self.error
        return argparse.Namespace(data=self.rows)


@pytest.fixture(autouse=True)
def no_process_setting(monkeypatch):
    monkeypatch.delenv(schema.SCHEMA_ENV_VAR, raising=False)


def _wire(monkeypatch, table, store=None):
    seen = {}

    def choose(values, via, runner):
        seen.update(via=via, values=dict(values))
        return store or Store()

    class Inner:
        def schema(self, name):
            seen["schema"] = name
            return table

    monkeypatch.setattr(config_store, "choose", choose)
    monkeypatch.setattr(ingest_client, "_build", lambda _values, _role: Inner())
    return seen


def _ctx(tmp_path, lines=API_LINES, runner=None):
    ctx, seen = make_context(tmp_path, runner=runner)
    ctx.env_file.write_text(lines, encoding="utf-8")
    return ctx, seen


def test_list_shows_enabled_sources_first_with_their_last_run(tmp_path, monkeypatch):
    table = Table(ROWS)
    seen = _wire(monkeypatch, table)
    ctx, lines = _ctx(tmp_path, API_LINES + "KB_SCHEMA=kb_acme\n")
    assert cli.main(["sources", "list"], ctx) == 0
    text = lines[0].splitlines()
    assert [line.split()[0] for line in text] == ["wiki", "drive", "fireflies", "gmail"]
    assert "enabled" in text[0] and text[0].endswith("ok")
    assert "FAILED (3 in a row); last good run 2026-01-01T11:20:00+00:00" in text[1]
    assert "disabled" in text[2] and text[2].endswith("never run")
    assert text[3].endswith("never run")
    assert seen["via"] == "auto" and seen["schema"] == "kb_acme"
    assert ("table", ("connector_state",)) in table.calls
    selected = dict(table.calls)["select"][0]
    assert "last_error" not in selected and "cursor" not in selected


def test_list_json(tmp_path, monkeypatch):
    _wire(monkeypatch, Table(ROWS))
    ctx, lines = _ctx(tmp_path)
    assert cli.main(["sources", "list", "--json"], ctx) == 0
    data = {item["source"]: item for item in json.loads(lines[0])}
    assert data["wiki"]["state"] == "ok" and data["wiki"]["enabled"] is True
    assert data["drive"]["state"] == "failing" and data["drive"]["consecutive_failures"] == 3
    assert data["gmail"] == {
        "source": "gmail", "enabled": False, "last_run_at": None,
        "last_success_at": None, "consecutive_failures": 0, "state": "never run",
    }


def test_list_needs_an_applied_config(tmp_path, monkeypatch, capsys):
    _wire(monkeypatch, Table([]), Store(config=None))
    ctx, _lines = _ctx(tmp_path)
    assert cli.main(["sources", "list"], ctx) == 1
    assert "kbe config apply" in capsys.readouterr().err


def test_a_read_failure_names_only_the_error_type(tmp_path, monkeypatch, capsys):
    _wire(monkeypatch, Table([], error=ConnectionError("fake-jwt-secret-0123456789")))
    ctx, _lines = _ctx(tmp_path)
    assert cli.main(["sources", "list"], ctx) == 1
    message = capsys.readouterr().err
    assert "ConnectionError" in message and "fake-jwt" not in message


def test_without_api_keys_the_direct_connection_is_used(tmp_path, monkeypatch):
    monkeypatch.setattr(pg, "find_psql", lambda: "psql")
    sep = "\x1f"
    answer = proc.ProcResult(0, f"wiki{sep}2026-01-02 11:00:00+00{sep}{sep}2\n", "")
    runner = FakeRunner({"psql": answer})
    rows = sources_state.state_rows(
        {"KBE_DATABASE_URL": "postgresql://postgres:fake-local-pw@localhost/db",
         "KB_SCHEMA": "kb_acme"},
        runner,
    )
    assert rows == [{
        "source": "wiki", "last_run_at": "2026-01-02 11:00:00+00",
        "last_success_at": None, "consecutive_failures": "2",
    }]
    sql = runner.calls[0]["stdin"]
    assert "from kb_acme.connector_state" in sql and "last_error" not in sql
    assert "fake-local-pw" not in " ".join(runner.calls[0]["argv"])
    status = sources_state.combine({"wiki": True}, rows)[0]
    assert status.state == "failing" and status.consecutive_failures == 2


def test_no_way_to_reach_the_database(tmp_path):
    with pytest.raises(KbeError, match="No way to reach the database"):
        sources_state.state_rows({}, FakeRunner())


def test_enabled_sources_tolerates_odd_shapes():
    assert sources_state.enabled_sources({"sources": "nope"}) == dict.fromkeys(
        sources_state.SOURCE_ORDER, False
    )
    assert sources_state.enabled_sources({"sources": {"gmail": {"enabled": True}}})["gmail"]
    odd = sources_state.combine({}, [{"source": "wiki", "consecutive_failures": "x"}])
    assert odd[0].consecutive_failures == 0 and odd[0].state == "never run"
