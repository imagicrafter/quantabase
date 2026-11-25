"""`kbe deploy secrets push`: app secrets from the local env file -- doctl is a fake."""

from __future__ import annotations

import json

import pytest
import yaml

from kbe import cli, deploy_secrets, proc, state
from kbe.tests.helpers import FakeRunner, make_context

APP_ID = "123e4567-e89b-12d3-a456-426614174000"
ENCRYPTED = "EV[1:abcdefgh:ciphertext-that-must-never-be-shown]"
URL = "https://fixture-project.supabase.co"
ANON = "fixture-anon-key-0123456789"
JWT = "fixture-jwt-secret-0123456789-abcdefghij"
EMBED = "fixture-embed-token-0123456789"
GITHUB = "fixture-github-token-0123456789"
CODE = "fixture_setup-code_0123456789_abcdefghij"
LOCAL = {
    "SUPABASE_URL": URL, "SUPABASE_ANON_KEY": ANON, "SUPABASE_JWT_SECRET": JWT,
    "KNOWLEDGE_EMBED_TOKEN": EMBED, "GITHUB_TOKEN": GITHUB,
}
VALUES = (URL, ANON, JWT, EMBED, GITHUB, CODE)


def _secret(key, value=None):
    return {"key": key, "type": "SECRET", "scope": "RUN_TIME", **({"value": value} if value else {})}


def _live():
    """A live spec: one stored secret, the rest unset, and settings this tool does not own."""
    return {
        "name": "acme-kb-engine", "region": "nyc",
        "envs": [_secret("GITHUB_TOKEN")],
        "ingress": {"rules": [{"match": {"path": {"prefix": "/"}}}]},
        "services": [{
            "name": "kb-engine", "instance_count": 3,
            "envs": [
                _secret("SUPABASE_URL", ENCRYPTED), _secret("SUPABASE_JWT_SECRET"),
                _secret("EMBED_TOKEN"), _secret("SETUP_CODE"),
                {"key": "LOG_LEVEL", "value": "debug", "scope": "RUN_TIME"},
            ],
        }],
        "jobs": [{
            "name": "puller-wiki", "kind": "SCHEDULED",
            "envs": [_secret("SUPABASE_URL"), _secret("KNOWLEDGE_EMBED_TOKEN"),
                     _secret("DO_INFERENCE_KEY")],
        }],
    }


def _app_json():
    return proc.ProcResult(0, json.dumps([{"id": APP_ID, "spec": {"name": "acme-kb-engine"}}]), "")


class Update:
    """Stands in for `doctl apps update`: reads the spec from standard input."""

    def __init__(self, result=None):
        self.result, self.path, self.spec = result, None, None

    def __call__(self, argv, stdin):
        self.path = argv[argv.index("--spec") + 1]
        self.spec = yaml.safe_load(stdin)
        return self.result or _app_json()


def _ctx(tmp_path, live=None, update=None, local=None, extra=None):
    update = update or Update()
    runner = FakeRunner({
        f"doctl apps spec get {APP_ID}": proc.ProcResult(0, yaml.safe_dump(live or _live()), ""),
        f"doctl apps update {APP_ID}": update,
        **(extra or {}),
    })
    ctx, seen = make_context(tmp_path, runner)
    chosen = LOCAL if local is None else local
    ctx.env_file.write_text(
        "".join(f"{name}={value}\n" for name, value in chosen.items()), encoding="utf-8")
    state.save(ctx.state_file, state.with_answer(state.load(ctx.state_file), "do_app_id", APP_ID))
    return ctx, seen, runner, update


def _envs(spec, component):
    holder = spec if component is None else next(
        c for kind in ("services", "jobs") for c in spec[kind] if c["name"] == component)
    return {entry["key"]: entry for entry in holder["envs"]}


def _no_values(text):
    for value in VALUES:
        assert value not in text
    assert "EV[" not in text and "chars" not in text


def _without_secret_values(spec):
    stripped = json.loads(json.dumps(spec))
    for holder in (stripped, *stripped["services"], *stripped["jobs"]):
        for entry in holder["envs"]:
            if entry.get("type") == "SECRET":
                entry.pop("value", None)
    return stripped


# --- the plan (no I/O) ----------------------------------------------------------


def test_the_local_name_table_maps_the_service_embed_token():
    assert deploy_secrets.local_name("EMBED_TOKEN") == "KNOWLEDGE_EMBED_TOKEN"
    assert deploy_secrets.local_name("SUPABASE_URL") == "SUPABASE_URL"


def test_plan_covers_the_app_the_service_and_the_jobs():
    plan = {(i.component, i.key): i.action for i in deploy_secrets.plan(_live(), LOCAL)}
    assert plan == {
        ("(app-wide)", "GITHUB_TOKEN"): deploy_secrets.SET,
        ("kb-engine", "SUPABASE_URL"): deploy_secrets.SET,   # EV[...] says nothing
        ("kb-engine", "SUPABASE_JWT_SECRET"): deploy_secrets.SET,
        ("kb-engine", "EMBED_TOKEN"): deploy_secrets.SET,
        ("kb-engine", "SETUP_CODE"): deploy_secrets.SKIP,
        ("puller-wiki", "SUPABASE_URL"): deploy_secrets.SET,
        ("puller-wiki", "KNOWLEDGE_EMBED_TOKEN"): deploy_secrets.SET,
        ("puller-wiki", "DO_INFERENCE_KEY"): deploy_secrets.SKIP,
    }


def test_updated_spec_changes_only_secret_values_and_not_its_input():
    live = _live()
    before = json.dumps(live, sort_keys=True)
    new = deploy_secrets.updated(live, LOCAL)
    assert json.dumps(live, sort_keys=True) == before
    assert _envs(new, "kb-engine")["SUPABASE_URL"]["value"] == URL
    assert _envs(new, "kb-engine")["EMBED_TOKEN"]["value"] == EMBED
    assert "value" not in _envs(new, "kb-engine")["SETUP_CODE"]
    assert _envs(new, None)["GITHUB_TOKEN"]["value"] == GITHUB
    assert _without_secret_values(new) == _without_secret_values(live)


def test_a_plain_variable_with_a_secret_name_is_not_touched():
    live = {"name": "x", "services": [{"name": "kb-engine", "envs": [
        {"key": "SUPABASE_URL", "value": "typed-in-plain", "scope": "RUN_TIME"}]}]}
    assert deploy_secrets.plan(live, LOCAL) == ()
    assert deploy_secrets.updated(live, LOCAL) == live


# --- the command ----------------------------------------------------------------


def test_preview_is_the_default_shows_no_value_and_changes_nothing(tmp_path):
    ctx, seen, runner, update = _ctx(tmp_path)
    assert cli.main(["deploy", "secrets", "push"], ctx) == 0
    text = "\n".join(seen)
    _no_values(text)
    assert "SUPABASE_JWT_SECRET  will set" in text
    assert "SUPABASE_URL  will set" in text
    assert "SETUP_CODE  no local value, left as it is" in text
    assert "already set" not in text and "does not reveal" in text and "safe to run again" in text
    assert "6 to set, 2 with no local value." in text
    assert "EMBED_TOKEN  will set  (KNOWLEDGE_EMBED_TOKEN in your env file)" in text
    assert "kb-engine" in text and "puller-wiki" in text and "(app-wide)" in text
    assert "new deployment" in text and "--yes" in text
    assert "DO_INFERENCE_KEY" in text.split("No local value for")[1]
    assert update.path is None
    assert not any(line.startswith("doctl apps update") for line in runner.lines())


def test_dry_run_with_yes_still_changes_nothing(tmp_path):
    ctx, _seen, _runner, update = _ctx(tmp_path)
    assert cli.main(["deploy", "secrets", "push", "--dry-run", "--yes"], ctx) == 0
    assert update.path is None


def test_yes_sets_every_secret_that_has_a_local_value(tmp_path):
    ctx, seen, runner, update = _ctx(tmp_path)
    assert cli.main(["deploy", "secrets", "push", "--yes"], ctx) == 0
    service, job = _envs(update.spec, "kb-engine"), _envs(update.spec, "puller-wiki")
    assert service["SUPABASE_URL"]["value"] == URL
    assert service["SUPABASE_JWT_SECRET"]["value"] == JWT
    assert service["EMBED_TOKEN"]["value"] == EMBED          # the name mapping
    assert "value" not in service["SETUP_CODE"]
    assert job["SUPABASE_URL"]["value"] == URL and job["KNOWLEDGE_EMBED_TOKEN"]["value"] == EMBED
    assert "value" not in job["DO_INFERENCE_KEY"]
    assert _envs(update.spec, None)["GITHUB_TOKEN"]["value"] == GITHUB
    # What this tool does not own is sent back as it was.
    assert _without_secret_values(update.spec) == _without_secret_values(_live())
    text = "\n".join(seen)
    _no_values(text)
    assert "Set 6 secret values" in text and "deploy status" in text
    # No secret on a command line; the spec travels on standard input only.
    for call in runner.calls:
        for value in VALUES:
            assert value not in " ".join(call["argv"])
        if call["argv"][:3] != ["doctl", "apps", "update"]:
            assert call["stdin"] is None


def test_the_spec_goes_on_standard_input_and_no_file_is_written(tmp_path, monkeypatch):
    import tempfile

    ctx, _seen, _runner, update = _ctx(tmp_path)
    made = []
    for name in ("mkdtemp", "mkstemp", "NamedTemporaryFile", "TemporaryDirectory"):
        monkeypatch.setattr(tempfile, name, lambda *a, _n=name, **k: made.append(_n))
    before = sorted(p.name for p in tmp_path.rglob("*"))
    assert cli.main(["deploy", "secrets", "push", "--yes"], ctx) == 0
    assert update.path == "-" and update.spec is not None
    assert made == []
    assert sorted(p.name for p in tmp_path.rglob("*")) == before


def test_the_error_is_redacted_when_doctl_fails(tmp_path, capsys):
    failed = proc.ProcResult(1, "", f"invalid spec near {JWT} and {EMBED} with {ENCRYPTED}")
    ctx, seen, _runner, update = _ctx(tmp_path, update=Update(failed))
    assert cli.main(["deploy", "secrets", "push", "--yes"], ctx) == 1
    err = capsys.readouterr().err
    assert "could not update the app" in err and "invalid spec near" in err
    _no_values(err.replace("EV[...]", "") + "\n".join(seen))
    assert "ciphertext" not in err
    assert update.path == "-"


def test_a_fresh_app_where_every_secret_reads_as_encrypted_is_still_set(tmp_path):
    """Right after `apps create` the platform returns EV[...] for every secret."""
    live = _live()
    for holder in (live, *live["services"], *live["jobs"]):
        for entry in holder["envs"]:
            if entry.get("type") == "SECRET":
                entry["value"] = f"{ENCRYPTED}-{entry['key']}"
    ctx, seen, _runner, update = _ctx(tmp_path, live=live)
    assert cli.main(["deploy", "secrets", "push"], ctx) == 0
    assert "6 to set, 2 with no local value." in "\n".join(seen)
    assert cli.main(["deploy", "secrets", "push", "--yes"], ctx) == 0
    service, job = _envs(update.spec, "kb-engine"), _envs(update.spec, "puller-wiki")
    assert service["SUPABASE_JWT_SECRET"]["value"] == JWT and service["EMBED_TOKEN"]["value"] == EMBED
    assert job["SUPABASE_URL"]["value"] == URL
    # No local value: the exact text goes back, so whatever is stored stays.
    assert service["SETUP_CODE"]["value"] == f"{ENCRYPTED}-SETUP_CODE"
    assert job["DO_INFERENCE_KEY"]["value"] == f"{ENCRYPTED}-DO_INFERENCE_KEY"


def test_there_is_no_overwrite_flag(tmp_path, capsys):
    ctx, _seen, _runner, update = _ctx(tmp_path)
    with pytest.raises(SystemExit):
        cli.main(["deploy", "secrets", "push", "--overwrite"], ctx)
    assert update.path is None
    capsys.readouterr()


def test_nothing_to_set_does_not_update(tmp_path):
    live = {"name": "x", "services": [{"name": "kb-engine",
                                       "envs": [_secret("SETUP_CODE", ENCRYPTED)]}]}
    ctx, seen, _runner, update = _ctx(tmp_path, local={"SUPABASE_URL": URL}, live=live)
    assert cli.main(["deploy", "secrets", "push", "--yes"], ctx) == 0
    assert update.path is None and "Nothing to set" in "\n".join(seen)


def test_a_placeholder_in_the_env_file_is_not_pushed(tmp_path):
    ctx, seen, _runner, update = _ctx(
        tmp_path, local={"SUPABASE_JWT_SECRET": "<your-jwt-secret>", "SUPABASE_URL": URL})
    assert cli.main(["deploy", "secrets", "push", "--yes"], ctx) == 0
    assert "SUPABASE_JWT_SECRET  no local value, left as it is" in "\n".join(seen)
    assert "value" not in _envs(update.spec, "kb-engine")["SUPABASE_JWT_SECRET"]


def test_it_needs_an_app_and_an_env_file(tmp_path, capsys):
    ctx, _seen = make_context(tmp_path)
    assert cli.main(["deploy", "secrets", "push"], ctx) == 1
    assert "No app yet" in capsys.readouterr().err
    assert cli.main(["deploy", "secrets", "push", "--app-id", APP_ID], ctx) == 1
    assert "No local env file" in capsys.readouterr().err


# --- the setup code from the clipboard -------------------------------------------


def _paste(text):
    return {"pbpaste": proc.ProcResult(0, text, "")}


def test_the_setup_code_can_come_from_the_clipboard(tmp_path):
    ctx, seen, _runner, update = _ctx(tmp_path, extra=_paste(CODE + "\n"))
    args = ["deploy", "secrets", "push", "--setup-code-from-clipboard"]
    assert cli.main(args, ctx) == 0
    assert "SETUP_CODE  will set  (from the clipboard)" in "\n".join(seen)
    assert cli.main([*args, "--yes"], ctx) == 0
    assert _envs(update.spec, "kb-engine")["SETUP_CODE"]["value"] == CODE
    _no_values("\n".join(seen))


@pytest.mark.parametrize("clip", ["", "too-short", "has spaces " + "a" * 40, "a" * 257,
                                  "line-one-" + "a" * 30 + "\nline-two"])
def test_a_clipboard_that_is_not_a_setup_code_is_refused(tmp_path, capsys, clip):
    ctx, _seen, _runner, update = _ctx(tmp_path, extra=_paste(clip))
    assert cli.main(["deploy", "secrets", "push", "--setup-code-from-clipboard", "--yes"], ctx) == 2
    err = capsys.readouterr().err
    assert "does not hold a setup code" in err and update.path is None
    assert not clip.strip() or clip.strip() not in err


def test_a_clipboard_that_holds_another_local_secret_is_refused(tmp_path, capsys):
    token = "fixture-embed-token-0123456789-abcdefghijkl"
    ctx, _seen, _runner, update = _ctx(
        tmp_path, local={**LOCAL, "KNOWLEDGE_EMBED_TOKEN": token}, extra=_paste(token))
    assert cli.main(["deploy", "secrets", "push", "--setup-code-from-clipboard", "--yes"], ctx) == 2
    err = capsys.readouterr().err
    assert "KNOWLEDGE_EMBED_TOKEN" in err and token not in err and update.path is None


def test_the_clipboard_is_read_even_when_the_setup_code_reads_as_encrypted(tmp_path):
    live = _live()
    live["services"][0]["envs"][3] = _secret("SETUP_CODE", f"{ENCRYPTED}-code")
    ctx, seen, runner, update = _ctx(tmp_path, live=live, extra=_paste(CODE))
    args = ["deploy", "secrets", "push", "--setup-code-from-clipboard"]
    assert cli.main(args, ctx) == 0
    assert "pbpaste" in runner.lines()
    assert "SETUP_CODE  will set  (from the clipboard)" in "\n".join(seen)
    assert cli.main([*args, "--yes"], ctx) == 0
    assert _envs(update.spec, "kb-engine")["SETUP_CODE"]["value"] == CODE


def test_the_clipboard_is_not_read_when_the_app_declares_no_setup_code(tmp_path):
    live = {"name": "x", "services": [{"name": "kb-engine", "envs": [_secret("SUPABASE_URL")]}]}
    ctx, _seen, runner, _update = _ctx(tmp_path, live=live, extra=_paste("not a code"))
    assert cli.main(["deploy", "secrets", "push", "--setup-code-from-clipboard"], ctx) == 0
    assert "pbpaste" not in runner.lines()


def test_no_clipboard_tool_is_said_plainly(tmp_path, capsys):
    ctx, _seen, _runner, _update = _ctx(
        tmp_path, extra={"pbpaste": proc.ProcResult(proc.NOT_FOUND, "", "pbpaste: not installed")})
    assert cli.main(["deploy", "secrets", "push", "--setup-code-from-clipboard"], ctx) == 1
    assert "pbpaste" in capsys.readouterr().err
