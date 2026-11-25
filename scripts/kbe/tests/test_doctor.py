"""`kbe doctor` with every tool mocked."""

from __future__ import annotations

import json

import pytest

from kbe import cli, doctor, proc
from kbe.tests.helpers import FakeRunner, make_context

MISSING = proc.ProcResult(proc.NOT_FOUND, "", "not installed")
ACCOUNT = "someone@example.com"

ALL_GOOD = {
    "git --version": proc.ProcResult(0, "git version 2.50.1\n"),
    "gh --version": proc.ProcResult(0, "gh version 2.86.0\nhttps://example.com\n"),
    "gh auth status": proc.ProcResult(0, f"Logged in as {ACCOUNT}\n"),
    "doctl version": proc.ProcResult(0, "doctl version 1.147.0\n"),
    "doctl account get": proc.ProcResult(0, f"{ACCOUNT}  team\n"),
    "node --version": proc.ProcResult(0, "v22.14.0\n"),
    "psql --version": proc.ProcResult(0, "psql 16.4\n"),
    "supabase --version": proc.ProcResult(0, "2.0.0\n"),
    "docker --version": proc.ProcResult(0, "Docker version 27\n"),
}


@pytest.fixture(autouse=True)
def _psql_on_path(monkeypatch):
    monkeypatch.setattr(doctor.pg, "find_psql", lambda: "psql")


def _findings(overrides=None):
    return doctor.examine(FakeRunner({**ALL_GOOD, **(overrides or {})}))


def test_everything_present_passes():
    findings = _findings()
    assert doctor.healthy(findings)
    assert [f.name for f in findings] == [
        "git", "gh", "gh login", "doctl", "doctl login", "node", "python",
        "psql", "supabase", "docker",
    ]
    assert doctor.render(findings)[-1] == "All required tools are ready."


def test_login_output_is_never_shown():
    findings = _findings()
    text = "\n".join(doctor.render(findings)) + json.dumps([f.detail for f in findings])
    assert ACCOUNT not in text


def test_missing_tool_fails_with_a_fix():
    findings = _findings({"gh --version": MISSING, "gh auth status": MISSING})
    assert not doctor.healthy(findings)
    by_name = {f.name: f for f in findings}
    assert by_name["gh"].detail == "not installed" and "cli.github.com" in by_name["gh"].fix
    assert by_name["gh login"].detail == "not installed"
    lines = doctor.render(findings)
    assert any(line.startswith("FAIL  gh ") for line in lines)
    assert "Fix the FAIL lines" in lines[-1]


def test_not_logged_in_fails():
    findings = _findings({"doctl account get": proc.ProcResult(1, "", "unauthorized")})
    by_name = {f.name: f for f in findings}
    assert not by_name["doctl login"].ok
    assert by_name["doctl login"].detail == "not logged in"
    assert by_name["doctl login"].fix == "Run: doctl auth init"
    assert not doctor.healthy(findings)


def test_node_must_be_22_or_newer():
    old = {f.name: f for f in _findings({"node --version": proc.ProcResult(0, "v20.11.1\n")})}
    assert not old["node"].ok and "too old" in old["node"].detail
    gone = {f.name: f for f in _findings({"node --version": MISSING})}
    assert gone["node"].detail == "not installed"
    new = {f.name: f for f in _findings({"node --version": proc.ProcResult(0, "v24.0.0\n")})}
    assert new["node"].ok


def test_python_version_check(monkeypatch):
    monkeypatch.setattr(doctor, "MIN_PYTHON", (99, 0))
    found = {f.name: f for f in _findings()}
    assert not found["python"].ok and "too old" in found["python"].detail


def test_both_database_clients_are_required_and_each_says_why():
    only_supabase = {f.name: f for f in _findings({"psql --version": MISSING})}
    assert not only_supabase["psql"].ok and only_supabase["supabase"].ok
    assert "kbe db migrate" in only_supabase["psql"].detail
    assert not doctor.healthy(list(only_supabase.values()))
    only_psql = {f.name: f for f in _findings({"supabase --version": MISSING})}
    assert only_psql["psql"].ok and not only_psql["supabase"].ok
    assert "kbe db deploy-functions" in only_psql["supabase"].detail
    assert only_psql["supabase"].fix and not doctor.healthy(list(only_psql.values()))


def test_psql_is_found_the_way_the_database_commands_find_it(monkeypatch):
    monkeypatch.setattr(doctor.pg, "find_psql", lambda: "/opt/keg/bin/psql")
    runner = FakeRunner({**ALL_GOOD, "psql --version": MISSING,
                         "/opt/keg/bin/psql --version": proc.ProcResult(0, "psql 16\n")})
    assert {f.name: f for f in doctor.examine(runner)}["psql"].ok

    def absent():
        raise doctor.KbeError("psql is not installed.")
    monkeypatch.setattr(doctor.pg, "find_psql", absent)
    assert not {f.name: f for f in doctor.examine(FakeRunner(ALL_GOOD))}["psql"].ok


def test_docker_is_optional():
    findings = _findings({"docker --version": MISSING})
    assert doctor.healthy(findings)
    assert any(line.startswith("SKIP  docker") for line in doctor.render(findings))


def test_command_exit_code_and_json(tmp_path):
    ctx, seen = make_context(tmp_path, runner=FakeRunner(ALL_GOOD))
    assert cli.main(["doctor"], ctx) == 0
    assert seen[-1] == "All required tools are ready."

    bad = FakeRunner({**ALL_GOOD, "git --version": MISSING})
    ctx, seen = make_context(tmp_path, runner=bad)
    assert cli.main(["doctor", "--json"], ctx) == 1
    payload = json.loads(seen[0])
    assert payload["ok"] is False
    assert payload["checks"][0] == {
        "name": "git", "ok": False, "required": True, "detail": "not installed",
        "fix": "Install git: https://git-scm.com",
    }
