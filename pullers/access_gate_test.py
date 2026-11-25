"""The runner ingests nothing until sign-in is set up."""

from __future__ import annotations

import argparse
import sys

import pytest

from pullers import access_gate, runner

STORED = {"team_domain": "https://example-team.cloudflareaccess.com", "aud": "aud-tag",
          "host": "engine.example.com"}
FROM_ENV = {"CF_ACCESS_TEAM_DOMAIN": "https://example-team.cloudflareaccess.com",
            "CF_ACCESS_AUD": "aud-tag"}
LOCAL_FILE = ".env"


class FakeDb:
    def __init__(self, data=None, error=None):
        self.data, self.error, self.calls = data, error, []

    def schema(self, name):
        self.calls.append(("schema", name))
        return self

    def rpc(self, name, args):
        self.calls.append(("rpc", name))
        return self

    def execute(self):
        if self.error:
            raise self.error
        return argparse.Namespace(data=self.data)


@pytest.mark.parametrize("status", [
    None, {}, {"setup_state": "open", "access": None},
    {"setup_state": "open", "access": {}},
    {"setup_state": "open", "access": {**STORED, "aud": ""}},
    {"setup_state": "open", "access": {"team_domain": "x", "aud": "y"}},
    {"setup_state": "complete", "access": None},
    {"setup_state": "open", "access": "not a mapping"},
])
def test_no_sign_in_settings_means_no_ingestion(status):
    decision = access_gate.decide(status, {})
    assert not decision.allowed and "setup not complete" in decision.reason


def test_stored_settings_allow_ingestion_also_while_setup_is_reopened():
    assert access_gate.decide({"setup_state": "complete", "access": STORED}, {}).allowed
    assert access_gate.decide({"setup_state": "open", "access": STORED}, {}).allowed


def test_a_job_given_both_variables_may_ingest():
    decision = access_gate.decide({"setup_state": "open", "access": None}, FROM_ENV)
    assert decision.allowed and "environment" in decision.reason


@pytest.mark.parametrize("settings", [
    {"CF_ACCESS_TEAM_DOMAIN": FROM_ENV["CF_ACCESS_TEAM_DOMAIN"]},
    {"CF_ACCESS_AUD": "aud-tag"},
    {"CF_ACCESS_TEAM_DOMAIN": "  ", "CF_ACCESS_AUD": "aud-tag"},
    {"CF_ACCESS_TEAM_DOMAIN": None, "CF_ACCESS_AUD": None},
])
def test_one_variable_is_not_enough(settings):
    assert not access_gate.decide({"access": None}, settings).allowed


def test_check_asks_the_database_as_the_runner_does():
    sb = FakeDb({"setup_state": "complete", "access": STORED})
    assert access_gate.check(sb, {}).allowed
    assert ("rpc", "engine_access_status") in sb.calls
    assert not access_gate.check(FakeDb({"setup_state": "open", "access": None}), {}).allowed


class _ApiError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def test_a_database_from_before_the_gate_is_allowed():
    error = _ApiError("PGRST202", "Could not find the function engine_access_status")
    decision = access_gate.check(FakeDb(error=error), {})
    assert decision.allowed and "predates" in decision.reason


def test_only_this_missing_function_counts_as_an_older_database():
    for error in (
        _ApiError("42883", "function kb_acme.engine_access_status() does not exist"),
        _ApiError("PGRST202", "Could not find the function kb_acme.engine_access_status"),
    ):
        assert access_gate.check(FakeDb(error=error), {}).allowed
    for error in (
        _ApiError("42704", 'role "kb_ingest" does not exist'),
        _ApiError("42P01", 'relation "engine_settings" does not exist'),
        _ApiError("PGRST202", "Could not find the function some_other_function"),
    ):
        with pytest.raises(_ApiError):
            access_gate.check(FakeDb(error=error), {})


def test_any_other_failure_is_not_a_yes():
    with pytest.raises(ConnectionError):
        access_gate.check(FakeDb(error=ConnectionError("network down")), {})
    with pytest.raises(_ApiError):
        access_gate.check(FakeDb(error=_ApiError("42501", "permission denied")), {})


def test_job_settings_reads_the_local_file_then_the_process(tmp_path, monkeypatch):
    for key in access_gate.ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    assert access_gate.job_settings(tmp_path) == {"CF_ACCESS_TEAM_DOMAIN": "", "CF_ACCESS_AUD": ""}
    monkeypatch.setenv("CF_ACCESS_AUD", "from-process")
    (tmp_path / LOCAL_FILE).write_text("CF_ACCESS_TEAM_DOMAIN=https://t.cloudflareaccess.com\n")
    assert access_gate.job_settings(tmp_path) == {
        "CF_ACCESS_TEAM_DOMAIN": "https://t.cloudflareaccess.com", "CF_ACCESS_AUD": "from-process"}


# --- the runner ---------------------------------------------------------------


def _run_main(monkeypatch, decision):
    ran = []
    monkeypatch.setattr(sys, "argv", ["runner", "--source", "wiki"])
    monkeypatch.setattr(runner, "get_supabase_ingest", lambda: object())
    monkeypatch.setattr(runner.access_gate, "check", lambda _sb: decision)
    monkeypatch.setattr(
        runner.run_events, "observe",
        lambda *_a, **_k: ran.append("observed") or runner.SourceReceipt(source="wiki", ok=True))
    monkeypatch.setattr(runner.run_issues, "report_failure",
                        lambda *_a, **_k: ran.append("issue"))
    return runner.main(), ran


def test_the_runner_exits_cleanly_before_setup(monkeypatch, capsys):
    code, ran = _run_main(monkeypatch, access_gate.Decision(False, "setup not complete: x"))
    assert code == 0 and ran == [], "no run, no event, no issue"
    out = capsys.readouterr().out.strip().splitlines()
    assert out == ["[runner:wiki] setup not complete: x"]


def test_the_runner_runs_once_sign_in_is_set_up(monkeypatch, capsys):
    code, ran = _run_main(monkeypatch, access_gate.Decision(True, "stored"))
    assert code == 0 and ran == ["observed"]
    assert "setup not complete" not in capsys.readouterr().out
