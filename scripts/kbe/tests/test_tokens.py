"""`kbe tokens mint`: only the hash reaches the database; the token is never printed."""

from __future__ import annotations

import re

import pytest

from kbe import cli, proc, tokens
from kbe.tests.helpers import FakeRunner, make_context

DB_LINE = "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@db.example.com/postgres\n"
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")


def _database(people=(("kb-engine", "reader"), ("owner", "administrator"))):
    known = dict(people)
    stored = {}

    def answer(argv, stdin):
        if stdin.startswith("update"):
            handle = re.search(r"where handle = '([^']+)'", stdin).group(1)
            stored[handle] = re.search(r"token_hash = '([0-9a-f]{64})'", stdin).group(1)
            return proc.ProcResult(0, "", "")
        value = re.search(r"= '([^']+)' and active", stdin).group(1)
        handle = value.split("@")[0]
        if handle not in known:
            return proc.ProcResult(0, "", "")
        return proc.ProcResult(0, f"{handle}\x1f{known[handle]}\n", "")

    return FakeRunner({"psql": answer}), stored


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("KBE_PSQL", "psql")

    def build(runner, confirm=None):
        ctx, seen = make_context(tmp_path, runner, confirm)
        ctx.env_file.write_text(DB_LINE + "KEEP=this line\n")
        return ctx, seen
    return build


def _sent(runner):
    return "\n".join(" ".join(c["argv"]) + "\n" + (c["stdin"] or "") for c in runner.calls)


def test_write_env_stores_the_hash_and_prints_no_token(env):
    runner, stored = _database()
    ctx, seen = env(runner)
    assert cli.main(["tokens", "mint", "--handle", "owner", "--write-env", "--yes"], ctx) == 0
    lines = dict(line.split("=", 1) for line in ctx.env_file.read_text().splitlines())
    token = lines["KNOWLEDGE_TOKEN_OWNER"]
    assert TOKEN.fullmatch(token) and stored == {"owner": tokens.token_hash(token)}
    assert lines["KEEP"] == "this line" and lines["KBE_DATABASE_URL"].startswith("postgresql://")
    assert token not in "\n".join(seen) and token not in _sent(runner)


def test_email_with_write_env_works(env):
    """Regression: the old script crashed on --email --write-env."""
    runner, stored = _database()
    ctx, _seen = env(runner)
    code = cli.main(["tokens", "mint", "--email", "Owner@Example.com", "--write-env", "--yes"], ctx)
    assert code == 0 and "owner" in stored
    assert "KNOWLEDGE_TOKEN_OWNER=" in ctx.env_file.read_text()


def test_embed_writes_both_names_and_can_also_go_to_the_clipboard(env):
    runner, stored = _database()
    ctx, seen = env(runner)
    argv = ["tokens", "mint", "--embed", "--write-env", "--clipboard", "--yes"]
    assert cli.main(argv, ctx) == 0
    lines = dict(line.split("=", 1) for line in ctx.env_file.read_text().splitlines())
    token = lines["KNOWLEDGE_EMBED_TOKEN"]
    assert lines["KNOWLEDGE_TOKEN_KB_ENGINE"] == token
    assert stored == {"kb-engine": tokens.token_hash(token)}
    copied = [c["stdin"] for c in runner.calls if c["argv"][0] != "psql"]
    assert copied == [token] and token not in "\n".join(seen)
    assert any("EMBED_TOKEN" in line for line in seen)


def test_a_second_mint_replaces_the_line(env):
    runner, _stored = _database()
    ctx, _seen = env(runner)
    for _ in range(2):
        cli.main(["tokens", "mint", "--handle", "owner", "--write-env", "--yes"], ctx)
    assert ctx.env_file.read_text().count("KNOWLEDGE_TOKEN_OWNER=") == 1


def test_out_file_is_owner_only(env, tmp_path):
    runner, stored = _database()
    ctx, seen = env(runner)
    target = tmp_path / "token.txt"
    assert cli.main(["tokens", "mint", "--handle", "owner", "--out", str(target), "--yes"], ctx) == 0
    name, token = target.read_text().strip().split("=", 1)
    assert name == "KNOWLEDGE_TOKEN_OWNER" and target.stat().st_mode & 0o777 == 0o600
    assert stored == {"owner": tokens.token_hash(token)} and token not in "\n".join(seen)
    assert "KNOWLEDGE_TOKEN_OWNER" not in ctx.env_file.read_text()


def test_nowhere_to_put_it_changes_nothing(env, capsys):
    runner, stored = _database()
    ctx, _seen = env(runner)
    assert cli.main(["tokens", "mint", "--handle", "owner", "--yes"], ctx) == 2
    assert stored == {} and runner.calls == []
    assert "--write-env" in capsys.readouterr().err


def test_there_is_no_flag_that_prints(capsys):
    with pytest.raises(SystemExit):
        cli.main(["tokens", "mint", "--handle", "owner", "--show"])
    assert "--show" in capsys.readouterr().err


def test_dry_run_and_a_no_change_nothing(env, capsys):
    runner, stored = _database()
    ctx, seen = env(runner)
    assert cli.main(["tokens", "mint", "--embed", "--write-env", "--dry-run"], ctx) == 0
    assert cli.main(["tokens", "mint", "--embed", "--write-env"], ctx) == 1
    assert stored == {} and "KNOWLEDGE_EMBED_TOKEN" not in ctx.env_file.read_text()
    assert "Dry run" in "\n".join(seen)


def test_unknown_person_and_bad_names(env, capsys):
    runner, stored = _database()
    ctx, _seen = env(runner)
    assert cli.main(["tokens", "mint", "--handle", "nobody", "--write-env", "--yes"], ctx) == 1
    assert cli.main(["tokens", "mint", "--handle", "x'; drop", "--write-env", "--yes"], ctx) == 2
    assert cli.main(["tokens", "mint", "--email", "not-an-email", "--write-env", "--yes"], ctx) == 2
    assert stored == {}


def test_a_new_env_file_is_created_owner_only(tmp_path):
    target = tmp_path / "new.env"
    tokens.write_env(target, {"A": "1"})
    assert target.read_text() == "A=1\n" and target.stat().st_mode & 0o777 == 0o600


def test_an_env_file_others_could_read_is_tightened(tmp_path):
    target = tmp_path / "loose.env"
    target.write_text("KEEP=1\n")
    target.chmod(0o644)
    tokens.write_env(target, {"A": "1"})
    assert target.read_text() == "KEEP=1\nA=1\n" and target.stat().st_mode & 0o777 == 0o600
    assert [p.name for p in tmp_path.iterdir()] == ["loose.env"], "no temp file is left behind"


def test_env_names():
    assert tokens.env_name("kb-engine") == "KNOWLEDGE_TOKEN_KB_ENGINE"
    assert tokens.env_name("first.last") == "KNOWLEDGE_TOKEN_FIRST_LAST"
