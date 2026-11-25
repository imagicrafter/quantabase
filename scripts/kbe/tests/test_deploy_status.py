"""`kbe deploy status` and `kbe deploy redeploy` -- doctl is a fake."""

from __future__ import annotations

import json

import pytest

from kbe import cli, deploy_doctl, proc, state
from kbe.errors import KbeError, UsageError
from kbe.tests.test_deploy import APP_ID, HOSTNAME, _app_json, _ctx, _remember, repo  # noqa: F401

# --- status and redeploy --------------------------------------------------------


def test_status_shows_the_deployment_and_job_runs(repo):
    runs = [
        {"job_name": "puller-wiki", "phase": "SUCCEEDED", "completed_at": "2026-01-02T11:01:00Z"},
        {"job_name": "puller-wiki", "phase": "FAILED", "completed_at": "2026-01-01T11:01:00Z"},
        {"job_name": "puller-drive", "phase": "RUNNING", "started_at": "2026-01-02T11:20:00Z"},
        "junk",
    ]
    ctx, seen, _ = _ctx(repo, {
        f"doctl apps get {APP_ID}": _app_json(in_progress_deployment={"phase": "BUILDING"}),
        f"doctl apps list-job-invocations {APP_ID}": proc.ProcResult(0, json.dumps(runs), ""),
    })
    _remember(ctx, do_app_id=APP_ID)
    assert cli.main(["deploy", "status"], ctx) == 0
    text = "\n".join(seen)
    assert "Active deployment: ACTIVE at 2026-01-02T03:04:05Z" in text
    assert "Deployment in progress: BUILDING" in text
    assert f"Default hostname: {HOSTNAME}" in text
    assert "puller-wiki: SUCCEEDED" in text and "puller-drive: RUNNING" in text
    assert "FAILED" not in text
    assert state.answer(state.load(ctx.state_file), "do_default_hostname") == HOSTNAME


def test_status_json_and_unknown_job_runs(repo):
    ctx, seen, _ = _ctx(repo, {
        f"doctl apps get {APP_ID}": _app_json(default_ingress="", active_deployment=None),
        f"doctl apps list-job-invocations {APP_ID}": proc.ProcResult(1, "", "unknown command"),
    })
    assert cli.main(["deploy", "status", "--app-id", APP_ID, "--json"], ctx) == 0
    shown = json.loads(seen[0])
    assert shown["job_runs"] is None and shown["default_hostname"] == ""
    assert shown["active_deployment"]["phase"] == "no active deployment"
    del seen[:]
    assert cli.main(["deploy", "status", "--app-id", APP_ID], ctx) == 0
    text = "\n".join(seen)
    assert "unknown" in text and "not assigned yet" in text


def test_status_with_no_runs_yet_and_garbled_runs(repo):
    ctx, seen, runner = _ctx(repo, {
        f"doctl apps get {APP_ID}": _app_json(),
        f"doctl apps list-job-invocations {APP_ID}": proc.ProcResult(0, "[]", ""),
    })
    assert cli.main(["deploy", "status", "--app-id", APP_ID], ctx) == 0
    assert "none yet" in "\n".join(seen)
    runner.answers[f"doctl apps list-job-invocations {APP_ID}"] = proc.ProcResult(0, "x", "")
    assert deploy_doctl.Doctl(runner).job_runs(APP_ID) is None


def test_status_and_redeploy_need_an_app(repo, capsys):
    ctx, _, _ = _ctx(repo)
    assert cli.main(["deploy", "status"], ctx) == 1
    assert cli.main(["deploy", "redeploy", "--yes"], ctx) == 1
    assert "deploy apply" in capsys.readouterr().err


def test_redeploy_asks_then_starts_a_deployment(repo, capsys):
    made = proc.ProcResult(0, json.dumps([{"id": "dep-42"}]), "")
    ctx, seen, runner = _ctx(repo, {f"doctl apps create-deployment {APP_ID}": made})
    _remember(ctx, do_app_id=APP_ID)
    assert cli.main(["deploy", "redeploy", "--dry-run"], ctx) == 0
    assert cli.main(["deploy", "redeploy"], ctx) == 1
    assert runner.calls == [] and "Not deployed" in capsys.readouterr().err
    assert cli.main(["deploy", "redeploy", "--yes"], ctx) == 0
    assert runner.calls[0]["argv"] == [
        "doctl", "apps", "create-deployment", APP_ID, "--output", "json"]
    assert "dep-42" in seen[-1]


def test_help_exists_for_every_deploy_command(capsys):
    for command in ((), ("render",), ("apply",), ("status",), ("redeploy",)):
        argv = ["deploy", *command, "--help"]
        with pytest.raises(SystemExit) as stopped:
            cli.main(argv)
        assert stopped.value.code == 0
        assert len(capsys.readouterr().out) > 120, argv


def test_app_id_shape():
    assert deploy_doctl.check_app_id(APP_ID) == APP_ID
    with pytest.raises(UsageError):
        deploy_doctl.check_app_id("abc; rm")
    with pytest.raises(KbeError):
        deploy_doctl._app({"no": "id"})
