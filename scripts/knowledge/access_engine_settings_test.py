"""Unit checks for the engine-settings cases in access_test.py.

access_test.py itself runs against a live database. These tests drive its new
cases with stand-in clients to prove each one fails when the guarantee it
checks is broken -- a denial test that cannot fail proves nothing.
"""

from __future__ import annotations

import pytest

from knowledge import access_test


class Denied(Exception):
    def __str__(self) -> str:
        return "{'code': '42501', 'message': 'permission denied for table'}"


class FakeEngine:
    """A kb_engine client: tables refuse, functions answer."""

    def __init__(self, *, readable_table=None, leak_hash=False, accept_wrong_code=False):
        self.readable_table = readable_table
        self.leak_hash = leak_hash
        self.accept_wrong_code = accept_wrong_code
        self.state = "open"
        self._table = None
        self._rpc = None

    def schema(self, name):
        assert name == "workspace"
        return self

    def table(self, name):
        self._table, self._rpc = name, None
        return self

    def select(self, columns):
        return self

    def limit(self, n):
        return self

    def rpc(self, name, args):
        self._rpc, self._table = (name, args), None
        return self

    def execute(self):
        if self._table is not None:
            if self._table == self.readable_table:
                return type("Resp", (), {"data": [{}]})()
            raise Denied()
        name, _args = self._rpc
        if name == "engine_settings_public":
            data = {"config": None, "access": None, "setup_state": self.state}
            if self.leak_hash:
                data["setup_code_hash"] = "ab" * 32
            return type("Resp", (), {"data": data})()
        if name == "engine_setup_complete":
            if self.accept_wrong_code:
                self.state = "complete"
            return type("Resp", (), {"data": self.accept_wrong_code})()
        raise AssertionError(f"unexpected rpc {name}")


@pytest.fixture(autouse=True)
def fresh_results(monkeypatch):
    monkeypatch.setattr(access_test, "_results", [])


def failures() -> list[str]:
    return [label for ok, label, _ in access_test._results if not ok]


def test_a_correct_database_passes_every_check():
    access_test.test_engine_settings(FakeEngine())
    assert failures() == []
    assert len(access_test._results) == len(access_test.WORKSPACE_TABLES) + 5


def test_a_table_grant_to_kb_engine_is_caught():
    access_test.test_engine_settings(FakeEngine(readable_table="engine_settings"))
    assert "kb_engine has no table grant on engine_settings" in failures()
    assert "kb_engine cannot read setup_code_hash" in failures()


def test_a_leaked_setup_code_hash_is_caught():
    access_test.test_engine_settings(FakeEngine(leak_hash=True))
    assert failures() == ["engine_settings_public never returns the setup code hash"]


def test_a_wrong_code_that_closes_setup_is_caught():
    access_test.test_engine_settings(FakeEngine(accept_wrong_code=True))
    assert failures() == [
        "a wrong setup code is refused",
        "a wrong setup code leaves the setup state unchanged",
    ]
