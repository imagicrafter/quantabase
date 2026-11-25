"""`kbe access`: the setup code is shown once and stored nowhere but as a hash."""

from __future__ import annotations

import argparse
import hashlib
import json
import re

import pytest

from kbe import access, cli, config_store, secret_out, state
from kbe.errors import KbeError, UsageError
from kbe.tests.helpers import FakeRunner, make_context

DB_LINE = "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n"
TEAM = "https://example-team.cloudflareaccess.com"
OPEN = {"setup_state": "open", "setup_code_set": False, "setup_opened_at": None, "access": None}
STORED = {"team_domain": TEAM, "aud": "aud-of-the-mcp-app", "host": "engine.example.com",
          "resource_url": "https://engine.example.com/mcp", "level": "owner"}
ADOPT = ["access", "adopt", "--team-domain", TEAM, "--aud", "aud-of-the-mcp-app",
         "--host", "engine.example.com"]


class Store:
    """Stands in for the database: records calls, answers from `status`."""

    def __init__(self, status=OPEN, error=None):
        self.status, self.error, self.calls = dict(status), error, []

    def describe(self):
        return "a fake database"

    def call(self, function, args=None):
        self.calls.append((function, dict(args or {})))
        if self.error:
            raise self.error
        if function == "engine_setup_reopen":
            self.status = {**self.status, "setup_state": "open", "setup_code_set": True}
            return None
        if function == "engine_access_adopt":
            self.status = {**self.status, "setup_state": "complete", "setup_code_set": False,
                           "access": args["p_access"]}
        return self.status

    def named(self, function):
        return [args for name, args in self.calls if name == function]


@pytest.fixture(autouse=True)
def a_person_at_the_terminal(monkeypatch):
    """`--show` only prints for a person; these tests stand in for one."""
    monkeypatch.setattr(secret_out, "_at_a_terminal", lambda: True)


@pytest.fixture
def env(tmp_path, monkeypatch):
    def build(store, confirm=None):
        ctx, seen = make_context(tmp_path, FakeRunner(), confirm)
        ctx.env_file.write_text(DB_LINE)
        monkeypatch.setattr(config_store, "choose", lambda *_a, **_k: store)
        return ctx, seen
    return build


def _code_in(seen):
    found = [m.group(0) for line in seen for m in [re.fullmatch(r"\s+([A-Za-z0-9_-]{43})", line)] if m]
    return found[0].strip() if found else None


# --- the code -----------------------------------------------------------------


def test_a_code_fits_what_the_service_accepts_and_is_never_repeated():
    codes = {access.new_code() for _ in range(50)}
    assert len(codes) == 50
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{32,256}", code) for code in codes)


def test_the_hash_is_hex_sha256_of_the_utf8_code():
    assert access.code_hash("abc") == hashlib.sha256(b"abc").hexdigest()
    assert re.fullmatch(r"[0-9a-f]{64}", access.code_hash(access.new_code()))


# --- init ---------------------------------------------------------------------


def test_init_stores_only_the_hash_and_shows_the_code_once(env, tmp_path):
    store = Store()
    ctx, seen = env(store, confirm=lambda _q: True)
    assert cli.main(["access", "init", "--show"], ctx) == 0
    code = _code_in(seen)
    assert code, "the code must be shown"
    assert sum(code in line for line in seen) == 1
    assert store.named("engine_setup_reopen") == [{"p_code_hash": access.code_hash(code)}]
    assert code not in json.dumps(store.calls)
    assert any("SETUP_CODE" in line for line in seen)
    saved = ctx.state_file.read_text()
    assert code not in saved and access.code_hash(code) not in saved
    assert state.load(ctx.state_file)["phases"]["access_setup"]["status"] == "pending"
    assert ctx.runner.calls == [], "the code must never reach a child program"
    assert not [p for p in tmp_path.rglob("*") if p.is_file() and code in p.read_text()]


def test_init_asks_first_and_changes_nothing_on_no(env):
    store = Store()
    ctx, seen = env(store, confirm=lambda _q: False)
    with pytest.raises(KbeError, match="Not changed"):
        access._cmd_init(argparse.Namespace(via="auto", dry_run=False, yes=False, show=True), ctx)
    assert store.named("engine_setup_reopen") == [] and _code_in(seen) is None


def test_init_yes_skips_the_question(env):
    store = Store()
    ctx, seen = env(store)
    assert cli.main(["access", "init", "--show", "--yes"], ctx) == 0
    assert _code_in(seen) and len(store.named("engine_setup_reopen")) == 1


def test_init_dry_run_makes_no_code(env):
    store = Store()
    ctx, seen = env(store)
    assert cli.main(["access", "init", "--dry-run"], ctx) == 0
    assert store.named("engine_setup_reopen") == [] and _code_in(seen) is None
    assert not ctx.state_file.exists()


@pytest.mark.parametrize("status, hint", [
    ({**OPEN, "setup_state": "complete", "access": STORED}, "already set up"),
    ({**OPEN, "access": STORED}, "already set up"),
    ({**OPEN, "setup_code_set": True}, "already set"),
])
def test_init_refuses_when_setup_is_done_or_a_code_exists(env, capsys, status, hint):
    store = Store(status)
    ctx, _seen = env(store, confirm=lambda _q: True)
    assert cli.main(["access", "init", "--show"], ctx) == 1
    assert hint in capsys.readouterr().err
    assert store.named("engine_setup_reopen") == []


def test_an_unmigrated_database_says_to_migrate(env, capsys):
    error = KbeError("The database refused x.engine_access_status:\n"
                     "ERROR:  function x.engine_access_status() does not exist")
    ctx, _seen = env(Store(error=error))
    assert cli.main(["access", "status"], ctx) == 1
    assert "kbe db migrate" in capsys.readouterr().err


def test_other_database_errors_are_passed_on(env, capsys):
    ctx, _seen = env(Store(error=KbeError("Could not reach the database")))
    assert cli.main(["access", "status"], ctx) == 1
    assert "Could not reach" in capsys.readouterr().err


def test_no_settings_row_is_an_error(env, capsys):
    store = Store()
    store.call = lambda *_a, **_k: None
    ctx, _seen = env(store)
    assert cli.main(["access", "status"], ctx) == 1
    assert "no Engine settings" in capsys.readouterr().err


# --- reopen -------------------------------------------------------------------


def test_reopen_replaces_the_code_and_keeps_settings_in_force(env):
    store = Store({**OPEN, "setup_state": "complete", "setup_code_set": True, "access": STORED})
    ctx, seen = env(store, confirm=lambda _q: True)
    assert cli.main(["access", "reopen", "--show"], ctx) == 0
    code = _code_in(seen)
    assert store.named("engine_setup_reopen") == [{"p_code_hash": access.code_hash(code)}]
    text = "\n".join(seen)
    assert "stay in force" in text and "stops working" in text


def test_the_instructions_name_the_address_to_open(env):
    store = Store()
    ctx, seen = env(store)
    saved = state.with_answer(state.empty(), "do_default_hostname", "acme-abc12.ondigitalocean.app")
    state.save(ctx.state_file, state.with_answer(saved, "engine_host", "engine.example.com"))
    cli.main(["access", "init", "--show", "--yes"], ctx)
    text = "\n".join(seen)
    assert "https://acme-abc12.ondigitalocean.app/setup -- exactly that address" in text
    assert "remove SETUP_CODE from the app" in text

    store = Store({**OPEN, "setup_state": "complete", "access": STORED})
    ctx, seen = env(store)
    cli.main(["access", "reopen", "--show", "--yes"], ctx)
    text = "\n".join(seen)
    assert "https://engine.example.com/setup (it is behind sign-in now)" in text
    assert "give: acme-abc12.ondigitalocean.app" in text


def test_two_reopens_give_two_codes(env):
    store = Store()
    ctx, seen = env(store)
    cli.main(["access", "reopen", "--show", "--yes"], ctx)
    first = _code_in(seen)
    seen.clear()
    cli.main(["access", "reopen", "--show", "--yes"], ctx)
    assert first and _code_in(seen) and first != _code_in(seen)


# --- status -------------------------------------------------------------------


def test_status_of_a_new_engine(env):
    ctx, seen = env(Store())
    assert cli.main(["access", "status"], ctx) == 0
    text = "\n".join(seen)
    assert re.search(r"setup:\s+open", text) and re.search(r"setup code:\s+not set", text)
    assert re.search(r"sign-in settings:\s+missing", text)
    assert "Nothing is indexed" in text


def test_status_of_a_set_up_engine(env):
    status = {**OPEN, "setup_state": "complete", "access": {**STORED, "status_aud": "aud-status"}}
    ctx, seen = env(Store(status))
    assert cli.main(["access", "status"], ctx) == 0
    text = "\n".join(seen)
    assert re.search(r"setup:\s+complete", text) and re.search(r"sign-in settings:\s+present", text)
    assert re.search(r"admin pages app:\s+present", text)
    assert "engine.example.com" in text and re.search(r"level:\s+owner", text)
    assert "Nothing is indexed" not in text


def test_status_json(env):
    ctx, seen = env(Store({**OPEN, "setup_opened_at": "2026-01-02T03:04:05+00:00",
                           "setup_code_set": True}))
    assert cli.main(["access", "status", "--json"], ctx) == 0
    assert json.loads(seen[0])["setup_code_set"] is True


def test_status_shows_when_an_open_setup_was_opened():
    lines = access.describe_status({**OPEN, "setup_opened_at": "2026-01-02T03:04:05+00:00"})
    assert any("opened at" in line for line in lines)


# --- adopt --------------------------------------------------------------------


def test_adopt_shows_the_change_asks_and_stores(env):
    store = Store()
    asked = []
    ctx, seen = env(store, confirm=lambda q: asked.append(q) or True)
    argv = [*ADOPT, "--status-aud", "aud-of-the-admin-app", "--level", "people"]
    assert cli.main(argv, ctx) == 0
    assert len(asked) == 1
    sent = store.named("engine_access_adopt")[0]["p_access"]
    assert sent == {
        "team_domain": TEAM, "aud": "aud-of-the-mcp-app", "host": "engine.example.com",
        "resource_url": "https://engine.example.com/mcp",
        "status_aud": "aud-of-the-admin-app", "level": "people",
    }
    assert any("(not set) -> engine.example.com" in line for line in seen)
    saved = state.load(ctx.state_file)
    assert saved["answers"]["engine_host"] == "engine.example.com"
    assert saved["phases"]["access_setup"]["status"] == "done"


def test_adopt_without_a_yes_changes_nothing(env, capsys):
    store = Store()
    ctx, _seen = env(store, confirm=lambda _q: False)
    assert cli.main(ADOPT, ctx) == 1
    assert "Not changed" in capsys.readouterr().err
    assert store.named("engine_access_adopt") == []


def test_adopt_dry_run(env):
    store = Store()
    ctx, seen = env(store)
    assert cli.main([*ADOPT, "--dry-run"], ctx) == 0
    assert store.named("engine_access_adopt") == [] and "Dry run" in seen[-1]


def test_adopt_is_a_no_op_when_nothing_changes(env):
    store = Store({**OPEN, "setup_state": "complete",
                   "access": {k: v for k, v in STORED.items() if k != "level"}})
    ctx, seen = env(store)
    assert cli.main([*ADOPT, "--yes"], ctx) == 0
    assert store.named("engine_access_adopt") == [] and "No changes" in seen[-1]


def test_adopt_completes_an_open_setup_that_holds_the_same_settings(env):
    store = Store({**OPEN, "access": {k: v for k, v in STORED.items() if k != "level"}})
    ctx, _seen = env(store)
    assert cli.main([*ADOPT, "--yes"], ctx) == 0
    assert len(store.named("engine_access_adopt")) == 1


@pytest.mark.parametrize("flag, value, problem", [
    ("--team-domain", "https://team.example.com", "--team-domain"),
    ("--host", "https://engine.example.com", "--host"),
    ("--host", "localhost", "--host"),
    ("--aud", "has spaces", "--aud"),
    ("--status-aud", "aud-of-the-mcp-app", "must differ"),
])
def test_adopt_checks_its_values_before_the_database(env, capsys, flag, value, problem):
    store = Store()
    ctx, _seen = env(store, confirm=lambda _q: True)
    argv = [*ADOPT, flag, value]
    assert cli.main(argv, ctx) == 2
    assert problem in capsys.readouterr().err
    assert store.calls == []


def test_build_access_normalises_host_and_team_domain():
    args = argparse.Namespace(team_domain=TEAM + "/", aud="aud-of-the-mcp-app",
                              status_aud=None, host="Engine.Example.com", level=None)
    built = access.build_access(args)
    assert built["team_domain"] == TEAM and built["host"] == "engine.example.com"
    assert "status_aud" not in built and "level" not in built
    with pytest.raises(UsageError):
        access.build_access(argparse.Namespace(team_domain="x", aud="a", status_aud=None,
                                               host="h", level=None))


def test_no_flag_takes_a_secret():
    parser = cli.build_parser()
    group = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    commands = next(a for a in group.choices["access"]._actions
                    if isinstance(a, argparse._SubParsersAction))
    actions = [a for sub in commands.choices.values() for a in sub._actions]
    flags = {opt for a in actions for opt in a.option_strings}
    named = [f for f in flags if re.search(r"code|token|secret|password|key", f)]
    # The one flag named after a secret takes a path to a file, never the value.
    assert named == ["--token-file"]
    assert {a.metavar for a in actions if "--token-file" in a.option_strings} == {"PATH"}


def test_help_for_every_command(capsys):
    for command in ("init", "reopen", "status", "adopt", "setup"):
        with pytest.raises(SystemExit) as stopped:
            cli.main(["access", command, "--help"])
        assert stopped.value.code == 0
        assert len(capsys.readouterr().out) > 120


# --- where the code goes --------------------------------------------------------


@pytest.mark.parametrize("command", ["init", "reopen"])
def test_without_a_delivery_flag_nothing_is_made(env, capsys, command):
    store = Store()
    ctx, seen = env(store, confirm=lambda _q: True)
    assert cli.main(["access", command, "--yes"], ctx) == 2
    assert store.named("engine_setup_reopen") == []
    message = capsys.readouterr().err
    assert all(flag in message for flag in ("--clipboard", "--out FILE", "--show"))
    assert _code_in(seen) is None


def test_clipboard_keeps_the_code_off_the_screen(env):
    store = Store()
    ctx, seen = env(store)
    assert cli.main(["access", "init", "--clipboard", "--yes"], ctx) == 0
    copied = ctx.runner.calls[0]["stdin"]
    assert store.named("engine_setup_reopen") == [{"p_code_hash": access.code_hash(copied)}]
    assert copied not in "\n".join(seen) and _code_in(seen) is None
    assert any("clipboard" in line for line in seen) and any("SETUP_CODE" in line for line in seen)


def test_out_writes_the_code_to_an_owner_only_file(env, tmp_path):
    store = Store()
    ctx, seen = env(store)
    target = tmp_path / "setup-code.txt"
    assert cli.main(["access", "reopen", "--out", str(target), "--yes"], ctx) == 0
    name, code = target.read_text().strip().split("=", 1)
    assert name == "SETUP_CODE" and target.stat().st_mode & 0o777 == 0o600
    assert store.named("engine_setup_reopen") == [{"p_code_hash": access.code_hash(code)}]
    assert code not in "\n".join(seen)


def test_an_existing_out_file_stops_before_a_code_is_made(env, tmp_path, capsys):
    store = Store()
    ctx, _seen = env(store)
    target = tmp_path / "taken.txt"
    target.write_text("keep")
    assert cli.main(["access", "init", "--out", str(target), "--yes"], ctx) == 2
    assert store.named("engine_setup_reopen") == [] and target.read_text() == "keep"
    assert "already exists" in capsys.readouterr().err
