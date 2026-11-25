"""`kbe support`: the connection string is shown once and stored nowhere."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re

import pytest

from kbe import cli, pg, proc, secret_out, support
from kbe.errors import UsageError
from kbe.tests.helpers import FakeRunner, make_context

DB_LINE = "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@db.example.com:6543/postgres\n"
SHOWN = re.compile(r"\s+(postgresql://kb_support_login:([A-Za-z0-9_-]{43})@\S+)")


def _database(group=True, logins=()):
    """A psql stand-in that tracks roles."""
    roles = {"kb_support"} if group else set()
    roles |= set(logins)

    def answer(argv, stdin):
        if "create role" in stdin:
            roles.add(re.search(r"create role (\w+)", stdin).group(1))
            return proc.ProcResult(0, "", "")
        if "drop role" in stdin:
            roles.discard(re.search(r"drop role (\w+)", stdin).group(1))
            return proc.ProcResult(0, "", "")
        if "pg_auth_members" in stdin:
            lines = [f"{name}\x1ft" for name in sorted(roles - {"kb_support"})]
            return proc.ProcResult(0, "\n".join(lines) + "\n", "")
        name = re.search(r"rolname = '(\w+)'", stdin).group(1)
        return proc.ProcResult(0, "1\n" if name in roles else "0\n", "")

    return FakeRunner({"psql": answer}), roles


@pytest.fixture(autouse=True)
def a_person_at_the_terminal(monkeypatch):
    """`--show` only prints for a person; these tests stand in for one."""
    monkeypatch.setattr(secret_out, "_at_a_terminal", lambda: True)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("KBE_PSQL", "psql")

    def build(runner, confirm=None):
        ctx, seen = make_context(tmp_path, runner, confirm)
        ctx.env_file.write_text(DB_LINE)
        return ctx, seen
    return build


def _everything_sent(runner):
    return "\n".join(" ".join(c["argv"]) + "\n" + (c["stdin"] or "") for c in runner.calls)


def test_the_verifier_matches_the_scram_definition():
    salt = b"0123456789abcdef"
    verifier = support.scram_verifier("pencil", salt)
    head, keys = verifier.rsplit("$", 1)
    assert head == "SCRAM-SHA-256$4096:" + base64.b64encode(salt).decode()
    salted = hashlib.pbkdf2_hmac("sha256", b"pencil", salt, 4096)
    stored = hashlib.sha256(hmac.new(salted, b"Client Key", hashlib.sha256).digest()).digest()
    server = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    assert keys == f"{base64.b64encode(stored).decode()}:{base64.b64encode(server).decode()}"
    assert support.scram_verifier("pencil") != support.scram_verifier("pencil")


def test_enable_creates_the_login_and_shows_the_string_once(env, tmp_path):
    runner, roles = _database()
    asked = []
    ctx, seen = env(runner, confirm=lambda q: asked.append(q) or True)
    assert cli.main(["support", "enable", "--show"], ctx) == 0
    shown = [m for line in seen for m in [SHOWN.fullmatch(line)] if m]
    assert len(shown) == 1 and len(asked) == 1
    text, password = shown[0].group(1), shown[0].group(2)
    assert text.endswith("@db.example.com:6543/postgres?sslmode=require")
    assert "kb_support_login" in roles
    sent = _everything_sent(runner)
    assert password not in sent, "the password must not reach psql; only its verifier does"
    assert "fake-local-pw" not in " ".join(" ".join(c["argv"]) for c in runner.calls)
    create = next(c["stdin"] for c in runner.calls if "create role" in c["stdin"])
    assert "create role kb_support_login login inherit connection limit 5" in create
    assert "password 'SCRAM-SHA-256$4096:" in create and "in role kb_support;" in create
    assert not ctx.state_file.exists(), "nothing about support goes into local state"
    assert not [p for p in tmp_path.rglob("*") if p.is_file() and password in p.read_text()]


def test_enable_needs_the_migration(env, capsys):
    runner, _roles = _database(group=False)
    ctx, _seen = env(runner, confirm=lambda _q: True)
    assert cli.main(["support", "enable", "--show"], ctx) == 1
    assert "kbe db migrate" in capsys.readouterr().err


def test_enable_refuses_a_second_login(env, capsys):
    runner, _roles = _database(logins=["kb_support_login"])
    ctx, seen = env(runner, confirm=lambda _q: True)
    assert cli.main(["support", "enable", "--show"], ctx) == 1
    assert "already enabled" in capsys.readouterr().err
    assert "create role" not in _everything_sent(runner) and not seen


def test_enable_dry_run_and_no(env, capsys):
    runner, roles = _database()
    ctx, seen = env(runner, confirm=lambda _q: False)
    assert cli.main(["support", "enable", "--dry-run"], ctx) == 0
    assert "Dry run" in seen[-1]
    assert cli.main(["support", "enable", "--show"], ctx) == 1
    assert "Not changed" in capsys.readouterr().err
    assert roles == {"kb_support"}


def test_enable_reports_a_database_refusal(env, capsys):
    def answer(argv, stdin):
        if "create role" in stdin:
            return proc.ProcResult(3, "", "ERROR:  permission denied to create role")
        return proc.ProcResult(0, "1\n" if "'kb_support'" in stdin else "0\n", "")

    ctx, seen = env(FakeRunner({"psql": answer}))
    assert cli.main(["support", "enable", "--show", "--yes"], ctx) == 1
    assert "could not be created" in capsys.readouterr().err
    assert not [line for line in seen if "postgresql://" in line]


def test_a_named_login_and_a_bad_name(env, capsys):
    runner, roles = _database()
    ctx, seen = env(runner)
    assert cli.main(["support", "enable", "--show", "--login", "kb_support_vendor", "--yes"], ctx) == 0
    assert "kb_support_vendor" in roles
    assert any("postgresql://kb_support_vendor:" in line for line in seen)
    assert cli.main(["support", "enable", "--show", "--login", "postgres", "--yes"], ctx) == 2
    assert "--login" in capsys.readouterr().err
    with pytest.raises(UsageError):
        support.login_name("kb_support_x; drop role postgres")


def test_a_pooler_login_keeps_the_project_suffix():
    conn = pg.connection_vars(
        "postgresql://postgres.abcdefghijklmnopqrst:pw@pooler.example.com:5432/postgres"
        "?sslmode=verify-full")
    text = support.connection_string(conn, "kb_support_login", "p")
    assert text == ("postgresql://kb_support_login.abcdefghijklmnopqrst:p@pooler.example.com:5432"
                    "/postgres?sslmode=verify-full")


def test_disable_ends_sessions_and_drops_the_login(env):
    runner, roles = _database(logins=["kb_support_login"])
    ctx, seen = env(runner, confirm=lambda _q: True)
    assert cli.main(["support", "disable"], ctx) == 0
    assert roles == {"kb_support"}, "the group role stays"
    drop = next(c["stdin"] for c in runner.calls if "drop role" in c["stdin"])
    assert "pg_terminate_backend" in drop and "usename = 'kb_support_login'" in drop
    assert "disabled" in seen[-1]


def test_disable_when_not_enabled_dry_run_and_no(env, capsys):
    runner, roles = _database()
    ctx, seen = env(runner, confirm=lambda _q: False)
    assert cli.main(["support", "disable"], ctx) == 0
    assert "not enabled" in seen[-1]
    roles.add("kb_support_login")
    assert cli.main(["support", "disable", "--dry-run"], ctx) == 0
    assert cli.main(["support", "disable"], ctx) == 1
    assert "Not changed" in capsys.readouterr().err
    assert "kb_support_login" in roles


def test_disable_only_drops_a_member_of_the_support_role(env, capsys):
    def answer(argv, stdin):
        if "pg_auth_members" in stdin:
            return proc.ProcResult(0, "kb_support_login\x1ft\n", "")
        return proc.ProcResult(0, "1\n", "")

    runner = FakeRunner({"psql": answer})
    ctx, _seen = env(runner, confirm=lambda _q: True)
    assert cli.main(["support", "disable", "--login", "kb_support_other", "--yes"], ctx) == 1
    assert "not a support login" in capsys.readouterr().err
    assert "drop role" not in _everything_sent(runner)


def test_disable_reports_a_database_refusal(env, capsys):
    def answer(argv, stdin):
        if "drop role" in stdin:
            return proc.ProcResult(3, "", "ERROR:  role cannot be dropped")
        if "pg_auth_members" in stdin:
            return proc.ProcResult(0, "kb_support_login\x1ft\n", "")
        return proc.ProcResult(0, "1\n", "")

    ctx, _seen = env(FakeRunner({"psql": answer}))
    assert cli.main(["support", "disable", "--yes"], ctx) == 1
    assert "could not be dropped" in capsys.readouterr().err


def test_status(env):
    runner, _roles = _database(group=False)
    ctx, seen = env(runner)
    assert cli.main(["support", "status"], ctx) == 0
    assert "missing" in seen[0] and "none" in seen[1]

    runner, _roles = _database()
    ctx, seen = env(runner)
    cli.main(["support", "status"], ctx)
    assert "present" in seen[0] and "disabled" in seen[1]

    runner, _roles = _database(logins=["kb_support_login"])
    ctx, seen = env(runner)
    cli.main(["support", "status"], ctx)
    assert seen[1] == "support login: kb_support_login"


def test_no_flag_takes_a_secret_and_help_exists(capsys):
    for command in ("enable", "disable", "status"):
        with pytest.raises(SystemExit) as stopped:
            cli.main(["support", command, "--help"])
        assert stopped.value.code == 0
        out = capsys.readouterr().out
        assert len(out) > 120 and "--password" not in out


def test_enable_without_a_delivery_flag_creates_nothing(env, capsys):
    runner, roles = _database()
    ctx, seen = env(runner, confirm=lambda _q: True)
    assert cli.main(["support", "enable", "--yes"], ctx) == 2
    assert "kb_support_login" not in roles
    assert "--clipboard" in capsys.readouterr().err
    assert not [line for line in seen if "postgresql://" in line]


def test_enable_to_a_file_prints_no_connection_string(env, tmp_path):
    runner, roles = _database()
    ctx, seen = env(runner)
    target = tmp_path / "support.txt"
    assert cli.main(["support", "enable", "--out", str(target), "--yes"], ctx) == 0
    name, text = target.read_text().strip().split("=", 1)
    assert name == "SUPPORT_DATABASE_URL" and text.startswith("postgresql://kb_support_login")
    assert target.stat().st_mode & 0o777 == 0o600 and "kb_support_login" in roles
    assert "postgresql://" not in "\n".join(seen)


def test_enable_to_the_clipboard_prints_no_connection_string(env):
    runner, _roles = _database()
    ctx, seen = env(runner)
    assert cli.main(["support", "enable", "--clipboard", "--yes"], ctx) == 0
    copied = [c["stdin"] for c in runner.calls if c["argv"][0] != "psql"]
    assert len(copied) == 1 and copied[0].startswith("postgresql://kb_support_login")
    assert "postgresql://" not in "\n".join(seen)
