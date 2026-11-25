"""`kbe deploy`: render, apply (create and update), status, redeploy -- doctl is a fake."""

from __future__ import annotations

import argparse
import json
import shutil
import stat
from pathlib import Path

import pytest
import yaml

from kbe import cli, deploy, proc, state
from kbe.tests.helpers import FakeRunner, make_context

ROOT = Path(__file__).resolve().parents[3]
APP_ID = "123e4567-e89b-12d3-a456-426614174000"
OTHER_ID = "99999999-e89b-12d3-a456-426614174000"
INGRESS = "https://acme-kb-engine-abc12.ondigitalocean.app"
HOSTNAME = "acme-kb-engine-abc12.ondigitalocean.app"
ENCRYPTED = "EV[1:abcdefgh:ciphertext-that-must-never-be-shown]"
HOST = "engine.example.com"


def _app_json(**changes):
    app = {
        "id": APP_ID, "default_ingress": INGRESS, "spec": {"name": "acme-kb-engine"},
        "active_deployment": {"id": "d1", "phase": "ACTIVE", "updated_at": "2026-01-02T03:04:05Z"},
    }
    return proc.ProcResult(0, json.dumps([{**app, **changes}]), "")


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A temp repo root with the example config where a knowledge repo would be."""
    monkeypatch.delenv("KB_SCHEMA", raising=False)
    vault = tmp_path / "vault" / ".kb-engine"
    vault.mkdir(parents=True)
    shutil.copy(ROOT / "config" / "engine.example.yaml", vault / "engine.yaml")
    return tmp_path


def _heads(argv, _stdin):
    """Every branch asked for exists, unless a test says otherwise."""
    return proc.ProcResult(0, f"0123abc\trefs/heads/{argv[-1]}\n", "")


def _ctx(repo, answers=None, confirm=None):
    runner = FakeRunner({"git ls-remote": _heads, **(answers or {})})
    ctx, seen = make_context(repo, runner, confirm)
    return ctx, seen, runner


def _remember(ctx, **answers):
    current = state.load(ctx.state_file)
    for key, value in answers.items():
        current = state.with_answer(current, key, value)
    state.save(ctx.state_file, current)


def _render(repo, *extra, ctx=None):
    ctx = ctx or _ctx(repo)[0]
    config = str(repo / "vault" / ".kb-engine" / "engine.yaml")
    assert cli.main(["deploy", "render", "--host", HOST, "--config", config, "--server-mode",
                     *extra], ctx) == 0
    ctx.runner.calls.clear()  # the branch check; the tests below count what apply runs
    return yaml.safe_load(deploy.spec_path(ctx).read_text(encoding="utf-8"))


def _live_from(spec, **changes):
    """The rendered spec as the platform would return it: secrets hold stored values."""
    live = json.loads(json.dumps(spec))
    for kind in ("services", "jobs"):
        for component in live.get(kind, []):
            for entry in component["envs"]:
                if entry.get("type") == "SECRET" and entry["key"] != "SETUP_CODE":
                    entry["value"] = f"{ENCRYPTED}-{component['name']}-{entry['key']}"
    return {**live, **changes}


def _spec_get(live):
    return {f"doctl apps spec get {APP_ID}": proc.ProcResult(0, yaml.safe_dump(live), "")}


def _never_claims_set_or_not(text):
    """A live spec holds EV[...] for every secret, set or not: no output may guess."""
    assert "[set]" not in text and "[NOT SET]" not in text and "stored value" not in text
    assert "does not reveal" in text and "deploy secrets push" in text


# --- render -------------------------------------------------------------------


def test_render_writes_a_private_file_and_remembers_the_answers(repo):
    ctx, seen, _ = _ctx(repo)
    spec = _render(repo, ctx=ctx)
    path = deploy.spec_path(ctx)
    assert path == repo / ".kb-engine-local" / "do-app-spec.yaml"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert spec["name"] == "acme-kb-engine" and spec["region"] == "nyc"
    answers = state.load(ctx.state_file)["answers"]
    assert answers == {"app_name": "acme-kb-engine", "region": "nyc", "engine_host": HOST,
                       "engine_source": "public@stable", "server_mode": True}
    text = "\n".join(seen)
    assert "SETUP_CODE" in text and "kbe access init" in text and "puller-wiki" in text
    assert "deploy apply" in text


def test_render_without_server_mode_has_the_service_alone_and_says_why(repo):
    ctx, seen, _ = _ctx(repo)
    config = str(repo / "vault" / ".kb-engine" / "engine.yaml")
    assert cli.main(["deploy", "render", "--host", HOST, "--config", config], ctx) == 0
    spec = yaml.safe_load(deploy.spec_path(ctx).read_text(encoding="utf-8"))
    assert "jobs" not in spec
    text = "\n".join(seen)
    assert "Server mode is off" in text and "--server-mode" in text
    assert state.load(ctx.state_file)["answers"]["server_mode"] is False


def test_server_mode_is_remembered_until_turned_off(repo):
    ctx, _, _ = _ctx(repo)
    _render(repo, ctx=ctx)
    config = ["--config", str(repo / "vault" / ".kb-engine" / "engine.yaml")]
    assert cli.main(["deploy", "render", *config], ctx) == 0
    assert yaml.safe_load(deploy.spec_path(ctx).read_text(encoding="utf-8")).get("jobs")
    assert cli.main(["deploy", "render", "--no-server-mode", *config], ctx) == 0
    assert "jobs" not in yaml.safe_load(deploy.spec_path(ctx).read_text(encoding="utf-8"))
    assert cli.main(["deploy", "render", *config], ctx) == 0
    assert "jobs" not in yaml.safe_load(deploy.spec_path(ctx).read_text(encoding="utf-8"))


def test_render_reuses_remembered_answers_and_flags_win(repo):
    ctx, _, _ = _ctx(repo)
    _remember(ctx, knowledge_repo_path=str(repo / "vault"), engine_host=HOST, app_name="first-app",
              region="fra", engine_source="github:acme/engine-fork@main")
    assert cli.main(["deploy", "render"], ctx) == 0
    spec = yaml.safe_load(deploy.spec_path(ctx).read_text(encoding="utf-8"))
    assert (spec["name"], spec["region"]) == ("first-app", "fra")
    assert spec["services"][0]["github"]["repo"] == "acme/engine-fork"
    assert cli.main(["deploy", "render", "--app-name", "second-app", "--region", "ams"], ctx) == 0
    spec = yaml.safe_load(deploy.spec_path(ctx).read_text(encoding="utf-8"))
    assert (spec["name"], spec["region"]) == ("second-app", "ams")
    assert state.answer(state.load(ctx.state_file), "app_name") == "second-app"


def test_render_stdout_writes_nothing(repo):
    ctx, seen, _ = _ctx(repo)
    _render_args = ["deploy", "render", "--host", HOST, "--stdout",
                    "--config", str(repo / "vault" / ".kb-engine" / "engine.yaml")]
    assert cli.main(_render_args, ctx) == 0
    assert yaml.safe_load(seen[0])["name"] == "acme-kb-engine"
    assert not deploy.spec_path(ctx).exists() and not ctx.state_file.exists()


def test_render_needs_a_host_and_a_config(repo, capsys):
    ctx, _, _ = _ctx(repo)
    assert cli.main(["deploy", "render", "--host", HOST], ctx) == 2
    assert "--config" in capsys.readouterr().err
    _remember(ctx, knowledge_repo_path=str(repo / "vault"))
    assert cli.main(["deploy", "render"], ctx) == 2
    assert "--host" in capsys.readouterr().err
    assert cli.main(["deploy", "render", "--host", HOST, "--config", str(repo / "none.yaml")],
                    ctx) == 1


def test_render_checks_the_branch_exists_on_the_remote(repo, capsys):
    ctx, _seen, runner = _ctx(repo, {"git ls-remote": proc.ProcResult(0, "", "")})
    config = str(repo / "vault" / ".kb-engine" / "engine.yaml")
    argv = ["deploy", "render", "--host", HOST, "--config", config]
    assert cli.main(argv, ctx) == 1
    message = capsys.readouterr().err
    assert "`stable` does not exist" in message and "--skip-source-check" in message
    assert not deploy.spec_path(ctx).exists()
    call = next(c for c in runner.calls if c["argv"][:2] == ["git", "ls-remote"])
    assert call["argv"][2:] == ["--heads", deploy.deploy_render.ENGINE_CLONE_URL, "stable"]
    assert call["extra"]["GIT_TERMINAL_PROMPT"] == "0"
    assert cli.main([*argv, "--skip-source-check"], ctx) == 0 and deploy.spec_path(ctx).exists()


def test_render_does_not_take_a_longer_branch_name_for_the_branch(repo, capsys):
    other = proc.ProcResult(0, "0123abc\trefs/heads/stable-old\n", "")
    ctx, _seen, _runner = _ctx(repo, {"git ls-remote": other})
    config = str(repo / "vault" / ".kb-engine" / "engine.yaml")
    assert cli.main(["deploy", "render", "--host", HOST, "--config", config], ctx) == 1


def test_render_says_when_the_remote_could_not_be_checked(repo, capsys):
    ctx, _seen, runner = _ctx(repo, {"git ls-remote": proc.ProcResult(128, "", "fatal: no")})
    config = str(repo / "vault" / ".kb-engine" / "engine.yaml")
    argv = ["deploy", "render", "--host", HOST, "--config", config,
            "--source", "github:acme/kb-engine@main"]
    assert cli.main(argv, ctx) == 1
    assert "Could not check" in capsys.readouterr().err
    call = next(c for c in runner.calls if c["argv"][:2] == ["git", "ls-remote"])
    assert call["argv"][3:] == ["https://github.com/acme/kb-engine.git", "main"]


def test_render_takes_the_schema_from_the_env_file(repo):
    ctx, _, _ = _ctx(repo)
    ctx.env_file.write_text("KB_SCHEMA=kb_acme\n", encoding="utf-8")
    spec = _render(repo, ctx=ctx)
    for component in [*spec["services"], *spec["jobs"]]:
        assert {"key": "KB_SCHEMA", "value": "kb_acme", "scope": "RUN_TIME"} in component["envs"]


def test_render_env_configured_mode(repo):
    spec = _render(repo, "--cf-team-domain", "https://acme.cloudflareaccess.com",
                   "--cf-aud", "aud-one")
    keys = [entry["key"] for entry in spec["services"][0]["envs"]]
    assert "EXPECTED_HOST" in keys and "CF_ACCESS_AUD" in keys


# --- apply: create ------------------------------------------------------------


def test_apply_needs_a_rendered_spec(repo, capsys):
    ctx, _, runner = _ctx(repo)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    assert "deploy render" in capsys.readouterr().err
    assert runner.calls == []
    deploy.spec_path(ctx).parent.mkdir()
    deploy.spec_path(ctx).write_text("- not a spec\n", encoding="utf-8")
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1


def test_create_asks_first(repo, capsys):
    ctx, _, runner = _ctx(repo)
    _render(repo, ctx=ctx)
    assert cli.main(["deploy", "apply"], ctx) == 1
    assert "Not created" in capsys.readouterr().err
    assert runner.calls == []


def test_create_dry_run_calls_nothing(repo):
    ctx, seen, runner = _ctx(repo)
    _render(repo, ctx=ctx)
    assert cli.main(["deploy", "apply", "--dry-run"], ctx) == 0
    assert runner.calls == [] and "Dry run" in "\n".join(seen)
    assert state.answer(state.load(ctx.state_file), "do_app_id") is None


def test_create_records_the_app_and_lists_the_secrets(repo):
    ctx, seen, runner = _ctx(repo, {"doctl apps create": _app_json()}, confirm=lambda _q: True)
    _render(repo, ctx=ctx)
    del seen[:]
    assert cli.main(["deploy", "apply"], ctx) == 0
    assert runner.calls[0]["argv"] == [
        "doctl", "apps", "create", "--spec", str(deploy.spec_path(ctx)), "--output", "json"]
    saved = state.load(ctx.state_file)
    assert saved["answers"]["do_app_id"] == APP_ID
    assert saved["answers"]["do_default_hostname"] == HOSTNAME
    assert state.phase_done(saved, "deploy")
    text = "\n".join(seen)
    assert "SETUP_CODE  <-" in text and "kbe access init" in text
    assert "puller-drive" in text and "DRIVE_TOKEN_JSON_B64  <-" in text
    _never_claims_set_or_not(text)
    assert f"open setup at exactly this address: https://{HOSTNAME}/setup" in text
    assert f"https://{HOSTNAME}/setup" in text


def test_create_without_an_address_yet_says_how_to_find_it(repo):
    ctx, seen, _ = _ctx(repo, {"doctl apps create": _app_json(default_ingress="")})
    _render(repo, ctx=ctx)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 0
    assert "deploy status" in "\n".join(seen[-2:])
    assert state.answer(state.load(ctx.state_file), "do_default_hostname") is None


def test_doctl_failures_are_clear_and_redacted(repo, capsys):
    hidden = "super-hidden-value-123"
    failing = {"doctl apps create": proc.ProcResult(1, "spec dump", f"denied for {hidden}")}
    ctx, _, _ = _ctx(repo, failing)
    ctx.env_file.write_text(f"SOME_TOKEN={hidden}\n", encoding="utf-8")
    _render(repo, ctx=ctx)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    err = capsys.readouterr().err
    assert "could not create the app" in err and hidden not in err and "spec dump" not in err

    missing = {"doctl": proc.ProcResult(proc.NOT_FOUND, "", "doctl: not installed")}
    ctx, _, _ = _ctx(repo, missing)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    assert "kbe doctor" in capsys.readouterr().err

    garbled = {"doctl apps create": proc.ProcResult(0, "not json", "")}
    ctx, _, _ = _ctx(repo, garbled)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    ctx, _, _ = _ctx(repo, {"doctl apps create": proc.ProcResult(0, "[]", "")})
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1


# --- apply: update ------------------------------------------------------------


def _update_ctx(repo, live_changes=None, confirm=None, **render_flags):
    ctx, seen, runner = _ctx(repo, confirm=confirm)
    spec = _render(repo, ctx=ctx)
    live = _live_from(spec, **({"region": "ams"} if live_changes is None else live_changes))
    runner.answers.update({**_spec_get(live), f"doctl apps update {APP_ID}": _app_json(),
                           f"doctl apps get {APP_ID}": _app_json()})
    _remember(ctx, do_app_id=APP_ID)
    del seen[:]
    return ctx, seen, runner, spec


def _update_call(runner):
    return next(c for c in runner.calls if c["argv"][:3] == ["doctl", "apps", "update"])


def test_update_carries_stored_secrets_and_sends_the_spec_on_stdin(repo):
    ctx, seen, runner, _ = _update_ctx(repo)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 0
    call = _update_call(runner)
    assert call["argv"] == ["doctl", "apps", "update", APP_ID, "--spec", "-", "--output", "json"]
    sent = yaml.safe_load(call["stdin"])
    for kind in ("services", "jobs"):
        for component in sent[kind]:
            for entry in component["envs"]:
                if entry.get("type") != "SECRET":
                    continue
                if entry["key"] == "SETUP_CODE":
                    assert "value" not in entry
                else:
                    assert entry["value"] == f"{ENCRYPTED}-{component['name']}-{entry['key']}"
    for made in runner.calls:
        assert "EV[" not in " ".join(made["argv"])
    text = "\n".join(seen)
    assert "EV[" not in text and "ciphertext" not in text
    assert "-region: ams" in text and "+region: nyc" in text
    assert "SETUP_CODE  <-" in text and "SUPABASE_URL  <-" in text
    _never_claims_set_or_not(text)
    assert state.phase_done(state.load(ctx.state_file), "deploy")


def test_update_asks_and_a_no_changes_nothing(repo, capsys):
    ctx, seen, runner, _ = _update_ctx(repo)
    assert cli.main(["deploy", "apply"], ctx) == 1
    assert "Not updated" in capsys.readouterr().err
    assert "+region: nyc" in "\n".join(seen)
    assert not [c for c in runner.calls if "update" in c["argv"]]


def test_update_dry_run_shows_the_diff_only(repo):
    ctx, seen, runner, _ = _update_ctx(repo)
    assert cli.main(["deploy", "apply", "--dry-run"], ctx) == 0
    assert "Dry run" in seen[-1]
    assert not [c for c in runner.calls if "update" in c["argv"]]


def test_update_with_nothing_to_change_does_not_update(repo):
    ctx, seen, runner, _ = _update_ctx(repo, live_changes={})
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 0
    assert "No changes" in seen[0]
    assert not [c for c in runner.calls if "update" in c["argv"]]
    assert "SETUP_CODE  <-" in "\n".join(seen)
    _never_claims_set_or_not("\n".join(seen))


def test_update_refuses_to_delete_a_live_component_unless_allowed(repo, capsys):
    extra = {"workers": [{"name": "old-worker", "envs": []}]}
    ctx, seen, runner, _ = _update_ctx(repo, live_changes=extra)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    assert "--allow-remove" in capsys.readouterr().err
    assert "WOULD DELETE LIVE COMPONENTS: worker old-worker" in "\n".join(seen)
    assert not [c for c in runner.calls if "update" in c["argv"]]
    # Allowed, but --yes alone is not enough: a person must still say yes.
    assert cli.main(["deploy", "apply", "--yes", "--allow-remove"], ctx) == 1
    assert not [c for c in runner.calls if "update" in c["argv"]]

    ctx, _, runner, _ = _update_ctx(repo, live_changes=extra, confirm=lambda _q: True)
    assert cli.main(["deploy", "apply", "--allow-remove"], ctx) == 0
    assert "workers" not in yaml.safe_load(_update_call(runner)["stdin"])


def test_a_dry_run_reports_a_removal_without_failing(repo):
    extra = {"workers": [{"name": "old-worker", "envs": []}]}
    ctx, seen, runner, _ = _update_ctx(repo, live_changes=extra)
    assert cli.main(["deploy", "apply", "--dry-run"], ctx) == 0
    text = "\n".join(seen)
    assert "WOULD DELETE LIVE COMPONENTS: worker old-worker" in text and "Dry run" in seen[-1]
    assert not [c for c in runner.calls if "update" in c["argv"]]


def test_update_by_app_id_flag_and_bad_ids(repo, capsys):
    ctx, _, runner, _ = _update_ctx(repo)
    assert cli.main(["deploy", "apply", "--app-id", "not-an-id", "--yes"], ctx) == 2
    # The flag wins over the remembered app (the fake knows no such app).
    assert cli.main(["deploy", "apply", "--app-id", OTHER_ID, "--dry-run"], ctx) == 1
    assert runner.calls[-1]["argv"][:5] == ["doctl", "apps", "spec", "get", OTHER_ID]
    capsys.readouterr()


def test_unreadable_live_spec_stops_the_update(repo, capsys):
    ctx, _, runner, _ = _update_ctx(repo)
    runner.answers[f"doctl apps spec get {APP_ID}"] = proc.ProcResult(0, "- a\n- list\n", "")
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    runner.answers[f"doctl apps spec get {APP_ID}"] = proc.ProcResult(0, "a: [unclosed\n", "")
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    assert not [c for c in runner.calls if "update" in c["argv"]]
    capsys.readouterr()


# --- no way to pass a secret ----------------------------------------------------


def _options(parser):
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for child in action.choices.values():
                yield from _options(child)
        else:
            yield action


def test_no_deploy_argument_can_carry_a_secret_value():
    parser = cli.build_parser()
    group = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    seen = 0
    for action in _options(group.choices["deploy"]):
        names = [action.dest, *action.option_strings]
        for name in names:
            seen += 1
            assert not state.looks_secret(name.lstrip("-").replace("-", "_")), name
            lowered = name.lower()
            assert not any(w in lowered for w in ("secret", "token", "password", "value"))
    assert seen > 15


def test_doctl_errors_written_to_standard_output_are_shown_redacted(repo, capsys):
    """doctl writes its error to stdout: JSON with --output json, `Error: ...` without."""
    hidden = "super-hidden-value-123"
    detail = json.dumps({"errors": [{"detail": f"POST /v2/apps: 422 region is invalid ({hidden})"}]})
    ctx, _, _ = _ctx(repo, {"doctl apps create": proc.ProcResult(1, detail + "\n", "")})
    ctx.env_file.write_text(f"SOME_TOKEN={hidden}\n", encoding="utf-8")
    _render(repo, ctx=ctx)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    err = capsys.readouterr().err
    assert "could not create the app" in err and "422 region is invalid" in err
    assert hidden not in err and "exit 1" not in err

    plain = f"name: spec-dump\nError: 401 unable to authenticate {hidden} {ENCRYPTED}\n"
    ctx, _, _ = _ctx(repo, {"doctl apps create": proc.ProcResult(1, plain, "")})
    ctx.env_file.write_text(f"SOME_TOKEN={hidden}\n", encoding="utf-8")
    _render(repo, ctx=ctx)
    assert cli.main(["deploy", "apply", "--yes"], ctx) == 1
    err = capsys.readouterr().err
    assert "401 unable to authenticate" in err
    assert hidden not in err and "spec-dump" not in err and "ciphertext" not in err
