"""The verify runner: pass, fail, and -- above all -- skipped means failed."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from kbe import cli, manifest, pg, proc, verify
from kbe.errors import KbeError, UsageError
from kbe.tests.helpers import FakeRunner, make_context

REAL_MANIFEST = Path(__file__).resolve().parents[3] / "setup" / "manifest.yaml"
FAKE_VALUE = "fake-value-0123456789"

RAW = {
    "phases": [
        {
            "id": "data",
            "title": "Data",
            "actor": "agent",
            "verify": [
                {"id": "count", "description": "count is zero", "kind": "sql",
                 "run": "select 0;", "expect": {"equals": "0"}},
                {"id": "rejects", "description": "bad insert is rejected", "kind": "sql",
                 "run": "insert bad;", "expect": {"error_contains": "my_constraint"}},
            ],
        },
        {
            "id": "live",
            "title": "Live",
            "depends_on": ["data"],
            "verify": [
                {"id": "health", "description": "service is up", "kind": "shell",
                 "run": "curl https://{state.engine_host}/health", "env": ["API_TOKEN"],
                 "expect": {"contains": "ok"}},
                {"id": "human", "description": "a person confirmed it", "kind": "manual"},
            ],
        },
        {"id": "later", "title": "Later", "status": "planned", "verify": []},
    ]
}


def _tools(tmp_path, runner, values=None, answers=None, with_db=True):
    conn = pg.connection_vars("postgresql://postgres:fake-local-pw@localhost/postgres")
    psql = pg.Psql(conn=conn, runner=runner, binary="psql") if with_db else None
    return verify.Tools(values or {}, answers or {}, psql, runner, tmp_path, tmp_path / "local.env")


def _sql_answer(argv, stdin):
    if "insert bad" in stdin:
        return proc.ProcResult(3, "", 'ERROR: violates check constraint "my_constraint"')
    return proc.ProcResult(0, "0\n", "WARNING: there is no transaction in progress")


def test_manifest_parses_phases_and_checks():
    phases = manifest.parse(RAW)
    assert [p.id for p in phases] == ["data", "live", "later"]
    assert phases[2].planned and phases[2].checks == ()
    assert phases[1].depends_on == ("data",)
    assert phases[1].checks[0].env == ("API_TOKEN",)


@pytest.mark.parametrize(
    "edit, problem",
    [
        (lambda r: r["phases"].append({"id": "data", "verify": [{"id": "x", "description": "x", "kind": "manual"}]}), "repeated id"),
        (lambda r: r["phases"][1].update(depends_on=["nowhere"]), "not a phase"),
        (lambda r: r["phases"][0]["verify"][0].update(kind="telepathy"), "kind must be"),
        (lambda r: r["phases"][0]["verify"][0].update(expect={"vibes": 1}), "expect may only use"),
        (lambda r: r["phases"][0]["verify"][0].update(expect={}), "must say what it expects"),
        (lambda r: r["phases"][0]["verify"][0].update(run=""), "needs something to run"),
        (lambda r: r["phases"][0].update(verify=[]), "no verify checks"),
        (lambda r: r["phases"][0].update(status="someday"), "status must be"),
        (lambda r: r["phases"][0]["verify"][1].update(id="count"), "share an id"),
        (lambda r: r["phases"][0]["verify"][0].pop("description"), "needs an id and a description"),
        (lambda r: r.pop("phases"), "needs a `phases` list"),
    ],
)
def test_manifest_problems_are_reported(edit, problem):
    raw = json.loads(json.dumps(RAW))
    edit(raw)
    with pytest.raises(KbeError, match=problem):
        manifest.parse(raw)


def test_select_keeps_manifest_order_and_rejects_unknown_names():
    phases = manifest.parse(RAW)
    assert [p.id for p in manifest.select(phases, ["live", "data"])] == ["data", "live"]
    assert manifest.select(phases, None) == phases
    with pytest.raises(UsageError, match="Unknown phase: nope"):
        manifest.select(phases, ["nope"])


def test_sql_checks_pass_and_are_rolled_back(tmp_path):
    runner = FakeRunner({"psql": _sql_answer})
    phases = manifest.parse(RAW)[:1]
    results = verify.run_phases(phases, _tools(tmp_path, runner))
    assert [r.status for r in results] == ["pass", "pass"]
    assert not verify.failed(results)
    assert runner.calls[0]["stdin"].rstrip().endswith("rollback;")


def test_sql_check_fails_on_wrong_answer_or_wrong_error(tmp_path):
    def wrong(argv, stdin):
        if "insert bad" in stdin:
            return proc.ProcResult(3, "", "ERROR: something else entirely")
        return proc.ProcResult(0, "7\n", "")

    results = verify.run_phases(manifest.parse(RAW)[:1], _tools(tmp_path, FakeRunner({"psql": wrong})))
    assert [r.status for r in results] == ["fail", "fail"]
    assert 'expected "0", got "7"' in results[0].detail
    assert 'not with "my_constraint"' in results[1].detail
    assert verify.failed(results)


def test_expected_failure_that_succeeds_is_a_fail():
    passed, why = verify.judge({"error_contains": "boom"}, proc.ProcResult(0, "", ""), "sql")
    assert not passed and "succeeded" in why


def test_judge_exit_code_and_output_rules():
    ok = proc.ProcResult(0, "8 passed\n", "")
    assert verify.judge({}, ok, "shell") == (True, "")
    assert verify.judge({"exit_code": 0, "not_contains": "skipped"}, ok, "shell")[0]
    assert not verify.judge({"not_contains": "passed"}, ok, "shell")[0]
    assert not verify.judge({}, proc.ProcResult(2, "", "bad"), "shell")[0]
    # `grep -c` prints 0 and exits 1: with only an output rule, the code is ignored.
    assert verify.judge({"equals": "0"}, proc.ProcResult(1, "0\n", ""), "shell")[0]
    # ...but never for SQL, where a non-zero code means the query broke.
    assert not verify.judge({"equals": "0"}, proc.ProcResult(3, "0\n", "ERROR"), "sql")[0]
    assert not verify.judge({"contains": "x"}, ok, "shell")[0]


def test_skipped_checks_count_as_failure(tmp_path):
    runner = FakeRunner()
    phases = manifest.parse(RAW)[1:2]
    results = verify.run_phases(phases, _tools(tmp_path, runner))
    assert [r.status for r in results] == ["skip", "skip"]
    assert "API_TOKEN" in results[0].detail
    assert "person has to confirm" in results[1].detail
    assert runner.calls == []
    assert verify.failed(results)
    summary = verify.render(phases, results)[-1]
    assert summary == "0 passed, 0 failed, 2 skipped (a skipped check counts as a failure)"


def test_missing_state_value_skips(tmp_path):
    tools = _tools(tmp_path, FakeRunner(), values={"API_TOKEN": FAKE_VALUE})
    result = verify.run_phases(manifest.parse(RAW)[1:2], tools)[0]
    assert result.status == "skip" and "engine_host" in result.detail


def test_missing_database_url_skips_sql_checks(tmp_path):
    results = verify.run_phases(manifest.parse(RAW)[:1], _tools(tmp_path, FakeRunner(), with_db=False))
    assert {r.status for r in results} == {"skip"}
    assert "KBE_DATABASE_URL" in results[0].detail


def test_shell_check_gets_values_by_environment_and_state_is_quoted(tmp_path):
    runner = FakeRunner({"sh": proc.ProcResult(0, f"ok {FAKE_VALUE}", "")})
    tools = _tools(tmp_path, runner, values={"API_TOKEN": FAKE_VALUE, "OTHER": "x"},
                   answers={"answers": {"engine_host": "engine.example.com; echo hi"}})
    result = verify.run_phases(manifest.parse(RAW)[1:2], tools)[0]
    assert result.status == "pass"
    call = runner.calls[0]
    assert call["argv"][:2] == ["sh", "-c"]
    assert "'engine.example.com; echo hi'" in call["argv"][2]
    assert FAKE_VALUE not in call["argv"][2]
    assert call["extra"]["API_TOKEN"] == FAKE_VALUE
    assert "OTHER" not in call["extra"]
    assert call["extra"]["KBE_ENV_FILE"] == str(tmp_path / "local.env")
    assert call["cwd"] == tmp_path


def test_failure_detail_never_shows_a_credential(tmp_path):
    runner = FakeRunner({"sh": proc.ProcResult(1, f"denied for {FAKE_VALUE}", "")})
    tools = _tools(tmp_path, runner, values={"API_TOKEN": FAKE_VALUE},
                   answers={"answers": {"engine_host": "h"}})
    result = verify.run_phases(manifest.parse(RAW)[1:2], tools)[0]
    assert result.status == "fail"
    assert FAKE_VALUE not in result.detail and "********" in result.detail


def test_state_values_are_quoted_for_sql(tmp_path):
    raw = {"phases": [{"id": "p", "verify": [
        {"id": "c", "description": "d", "kind": "sql",
         "run": "select count(*) from t where email = {state.owner_email};",
         "expect": {"equals": "1"}}]}]}
    runner = FakeRunner({"psql": proc.ProcResult(0, "1\n", "")})
    tools = _tools(tmp_path, runner, answers={"answers": {"owner_email": "o'brien@example.com"}})
    assert verify.run_phases(manifest.parse(raw), tools)[0].status == "pass"
    assert "email = 'o''brien@example.com';" in runner.calls[0]["stdin"]


def test_planned_phases_are_listed_but_not_run(tmp_path):
    phases = manifest.parse(RAW)
    runner = FakeRunner({"psql": _sql_answer})
    results = verify.run_phases(phases[2:], _tools(tmp_path, runner))
    assert results == () and runner.calls == []
    assert "later: planned (no checks yet)" in verify.render(phases, results)
    listing = verify.render_list(phases)
    assert listing[0].startswith("data") and "2 check(s)" in listing[0]
    assert "planned" in listing[2] and "(after data)" in listing[1]


def test_real_manifest_is_valid_and_has_every_phase():
    phases = manifest.load(REAL_MANIFEST)
    ids = [p.id for p in phases]
    # The order a new setup reaches them: database, repo and config, the app,
    # sign-in, sources, the first run, the connector, tags, the final suites.
    assert ids == [
        "prereqs", "bronze", "silver", "gold", "retrieval", "access_control", "curation_loop",
        "knowledge_repo", "config", "distill_embed", "deployment", "mcp_engine", "access_setup",
        "sources", "ingestion", "authentication", "tagging", "verification",
    ]
    assert {p.id for p in phases if p.planned} == set()
    assert all(p.checks for p in phases)


def test_real_manifest_has_no_check_that_can_never_pass():
    """A manual check is always skipped, and a skip fails the whole run."""
    checks = [c for p in manifest.load(REAL_MANIFEST) for c in p.checks]
    assert [c.id for c in checks if c.kind == "manual"] == []
    for check in checks:
        expect = check.expect or {}
        both = {str(expect.get("contains")), str(expect.get("equals"))} - {"None"}
        assert str(expect.get("not_contains")) not in both, check.id


def test_real_manifest_state_values_are_ones_a_command_records():
    """{state.x} must be an answer some kbe command saves, or the check always skips."""
    recorded = {"engine_host", "do_default_hostname", "owner_email", "knowledge_repo_path",
                "wiki_repo", "engine_id", "app_name", "region", "do_app_id"}
    used = {
        name
        for p in manifest.load(REAL_MANIFEST) for c in p.checks
        for name in verify._STATE_REF.findall(c.run)
    }
    assert used and used <= recorded, used - recorded


def test_real_manifest_dependencies_come_earlier_and_gates_name_phases():
    import yaml

    raw = yaml.safe_load(REAL_MANIFEST.read_text(encoding="utf-8"))
    seen: list[str] = []
    for phase in raw["phases"]:
        assert set(phase.get("depends_on") or []) <= set(seen), phase["id"]
        seen.append(phase["id"])
    assert [p["chapter"] for p in raw["phases"]] == list(range(1, len(seen) + 1))
    gates = [gate["phase"] for gate in raw["human_gates"]]
    assert set(gates) <= set(seen)
    assert {"deployment", "access_setup", "authentication"} <= set(gates)


def test_manifest_load_errors(tmp_path):
    with pytest.raises(KbeError, match="Could not read"):
        manifest.load(tmp_path / "absent.yaml")
    bad = tmp_path / "bad.yaml"
    bad.write_text("phases: [unclosed")
    with pytest.raises(KbeError, match="not valid YAML"):
        manifest.load(bad)


def _write_manifest(tmp_path):
    folder = tmp_path / "setup"
    folder.mkdir()
    (folder / "manifest.yaml").write_text(json.dumps(RAW))


def test_verify_command_exit_codes_and_state(tmp_path, monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    _write_manifest(tmp_path)
    ctx, seen = make_context(tmp_path, runner=FakeRunner({"psql": _sql_answer}))
    ctx.env_file.write_text("KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n")

    assert cli.main(["verify", "--phases", "data"], ctx) == 0
    assert seen[-1] == "2 passed, 0 failed, 0 skipped"
    saved = json.loads(ctx.state_file.read_text())
    assert saved["phases"]["data"]["status"] == "done"

    seen.clear()
    assert cli.main(["verify"], ctx) == 1
    assert "  SKIP  a person confirmed it" in seen
    saved = json.loads(ctx.state_file.read_text())
    assert saved["phases"]["live"]["status"] == "failed"
    assert "later" not in saved["phases"]


def test_verify_command_list_and_json(tmp_path, capsys):
    _write_manifest(tmp_path)
    ctx, seen = make_context(tmp_path)
    assert cli.main(["verify", "--list"], ctx) == 0
    assert len(seen) == 3 and ctx.runner.calls == []

    seen.clear()
    assert cli.main(["verify", "--phases", "live", "--json"], ctx) == 1
    payload = json.loads(seen[0])
    assert payload["ok"] is False
    assert [c["status"] for c in payload["checks"]] == ["skip", "skip"]

    assert cli.main(["verify", "--phases", "nope"], ctx) == 2
    assert "Unknown phase" in capsys.readouterr().err


def _hostname_check():
    phases = manifest.parse(yaml.safe_load(REAL_MANIFEST.read_text(encoding="utf-8")))
    return next(c for p in phases for c in p.checks if c.id == "hostname-asks-for-sign-in")


def _run_probe(tmp_path, codes):
    """Run the real check with a stand-in `curl` that answers `codes` in turn."""
    import subprocess
    import sys

    answers = tmp_path / "answers"
    answers.write_text("\n".join(codes) + "\n")
    curl = tmp_path / "curl"
    curl.write_text(
        "#!/bin/sh\n"
        f"line=$(head -n 1 '{answers}')\n"
        f"tail -n +2 '{answers}' > '{answers}.next' && mv '{answers}.next' '{answers}'\n"
        "printf '%s' \"${line:-404}\"\n")
    curl.chmod(0o755)
    command = _hostname_check().run.replace("{state.engine_host}", "engine.example.com")
    command = command.replace("{python}", sys.executable)
    env = {"PATH": f"{tmp_path}:/usr/bin:/bin", "KBE_PROBE_WAIT_SECONDS": "0"}
    return subprocess.run(["sh", "-c", command], env=env, capture_output=True, text=True, timeout=60)


def test_a_new_hostname_may_answer_404_for_a_short_while(tmp_path):
    """Seen on a live account: the edge says 404 right after the records are made."""
    done = _run_probe(tmp_path, ["404", "404", "302"])
    assert done.returncode == 0, done.stdout + done.stderr
    assert "HTTP 302" in done.stdout


def test_a_hostname_that_stays_404_still_fails(tmp_path):
    done = _run_probe(tmp_path, ["404"] * 40)
    assert done.returncode != 0 and "HTTP 404" in done.stdout


def test_a_hostname_that_serves_the_connector_openly_fails_at_once(tmp_path):
    done = _run_probe(tmp_path, ["200", "302"])
    assert done.returncode != 0 and "HTTP 200" in done.stdout
