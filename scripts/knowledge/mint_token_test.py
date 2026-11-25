"""mint_token: --email with --write-env writes under the principal's handle."""

from __future__ import annotations

import sys

import pytest

from knowledge import mint_token

ENV_NAME = ".env"


class _Query:
    def __init__(self, store, rows):
        self._store, self._rows = store, rows

    def select(self, *_a):
        return self

    def update(self, values):
        self._store["updated"] = values
        return self

    def eq(self, column, value):
        self._store["filter"] = (column, value)
        return self

    def ilike(self, *_a):
        return self

    def execute(self):
        return type("Resp", (), {"data": self._rows})()


class _Client:
    def __init__(self, store, rows):
        self._store, self._rows = store, rows

    def table(self, _name):
        return _Query(self._store, self._rows)


@pytest.fixture
def minted(tmp_path, monkeypatch, capsys):
    store: dict = {}
    rows = [{"id": 1, "handle": "first.last", "role": "administrator", "active": True}]
    monkeypatch.setattr(mint_token, "WORKSPACE_ROOT", tmp_path)
    monkeypatch.setattr(mint_token, "get_supabase", lambda: _Client(store, rows))
    monkeypatch.setattr(mint_token, "db", lambda client: client)

    def run(*argv):
        monkeypatch.setattr(sys, "argv", ["mint_token", *argv])
        code = mint_token.main()
        return code, store, capsys.readouterr().out
    return run, tmp_path


def test_email_with_write_env_does_not_crash(minted):
    run, root = minted
    code, store, out = run("--email", "First.Last@example.com", "--write-env")
    assert code == 0
    name, token = (root / ENV_NAME).read_text().strip().split("=", 1)
    assert name == "KNOWLEDGE_TOKEN_FIRST_LAST"
    assert store["updated"] == {"token_hash": mint_token.token_hash(token)}
    assert store["filter"] == ("handle", "first.last")
    assert token not in out


def test_handle_with_write_env_still_works(minted):
    run, root = minted
    code, _store, out = run("--handle", "first.last", "--write-env")
    assert code == 0 and "KNOWLEDGE_TOKEN_FIRST_LAST=" in (root / ENV_NAME).read_text()
    assert "KNOWLEDGE_TOKEN_FIRST_LAST" in out


def test_env_key_keeps_the_old_form_for_dashes():
    assert mint_token.env_key("kb-engine") == "KNOWLEDGE_TOKEN_KB_ENGINE"
