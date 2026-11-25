"""The entry point, the process runner, the context, and the `db` commands."""

from __future__ import annotations

import json
import sys

import pytest

from kbe import cli, context, pg, proc
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner, make_context

URL_LINE = "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n"
REF = "abcdefghijklmnopqrst"


def test_help_exists_for_every_command(capsys):
    for argv in (
        ["--help"], ["doctor", "--help"], ["db", "--help"], ["db", "migrate", "--help"],
        ["db", "adopt", "--help"], ["db", "deploy-functions", "--help"], ["config", "--help"],
        ["db", "expose-schema", "--help"], ["db", "render", "--help"],
        ["config", "validate", "--help"], ["config", "apply", "--help"], ["verify", "--help"],
        ["repo", "--help"], ["repo", "init", "--help"], ["repo", "status", "--help"],
        ["deploy", "--help"], ["deploy", "render", "--help"], ["deploy", "apply", "--help"],
        ["deploy", "status", "--help"], ["deploy", "redeploy", "--help"],
        ["access", "--help"], ["sources", "--help"], ["sources", "list", "--help"],
        ["sources", "drive", "auth", "--help"], ["people", "--help"], ["support", "--help"],
        ["tags", "--help"],
    ):
        with pytest.raises(SystemExit) as stopped:
            cli.main(argv)
        assert stopped.value.code == 0
        assert len(capsys.readouterr().out) > 120, argv


def test_a_group_is_required(capsys):
    with pytest.raises(SystemExit) as stopped:
        cli.main([])
    assert stopped.value.code == 2


def test_errors_become_a_message_and_an_exit_code(tmp_path, capsys):
    _repo(tmp_path)
    ctx, _ = make_context(tmp_path)
    assert cli.main(["db", "migrate"], ctx) == 1
    err = capsys.readouterr().err
    assert err.startswith("kbe: No local env file")
    assert "Traceback" not in err


def test_keyboard_interrupt_is_quiet(tmp_path, capsys, monkeypatch):
    def stop(_args, _ctx):
        raise KeyboardInterrupt

    monkeypatch.setattr(cli.doctor, "_cmd_doctor", stop)
    ctx, _ = make_context(tmp_path)
    assert cli.main(["doctor"], ctx) == 130


def test_main_module_runs(monkeypatch):
    import runpy

    monkeypatch.setattr(sys, "argv", ["kbe", "--version"])
    with pytest.raises(SystemExit) as stopped:
        runpy.run_module("kbe", run_name="__main__")
    assert stopped.value.code == 0


# --- context --------------------------------------------------------------------


def test_context_env_file_order(tmp_path, monkeypatch):
    monkeypatch.delenv(context.ENV_FILE_VAR, raising=False)
    monkeypatch.delenv(context.STATE_FILE_VAR, raising=False)
    plain = context.build(root=tmp_path)
    assert plain.env_file == tmp_path / ".env"
    assert plain.state_file == tmp_path / ".kb-engine-local" / "state.json"
    assert plain.migrations_dir == tmp_path / "supabase" / "migrations"
    assert plain.manifest_file == tmp_path / "setup" / "manifest.yaml"

    monkeypatch.setenv(context.ENV_FILE_VAR, str(tmp_path / "from-var.env"))
    monkeypatch.setenv(context.STATE_FILE_VAR, str(tmp_path / "elsewhere.json"))
    assert context.build(root=tmp_path).env_file == tmp_path / "from-var.env"
    assert context.build(root=tmp_path).state_file == tmp_path / "elsewhere.json"
    assert context.build(str(tmp_path / "flag.env"), root=tmp_path).env_file == tmp_path / "flag.env"
    assert context.build("relative.env", root=tmp_path).env_file.is_absolute()
    assert (context.repo_root() / "scripts" / "kbe").is_dir()


def test_confirm_says_no_without_a_terminal(monkeypatch):
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)
    assert context._ask("Sure?") is False


def test_confirm_reads_an_answer(monkeypatch):
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.setattr("builtins.input", lambda _prompt: " Yes ")
    assert context._ask("Sure?") is True
    monkeypatch.setattr("builtins.input", lambda _prompt: "")
    assert context._ask("Sure?") is False

    def closed(_prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", closed)
    assert context._ask("Sure?") is False


# --- proc -----------------------------------------------------------------------


def test_run_captures_output_and_passes_extra_values():
    code = "import os, sys; print(os.environ['KBE_TEST_VALUE'] + sys.stdin.read())"
    result = proc.run([sys.executable, "-c", code], extra={"KBE_TEST_VALUE": "a"}, stdin="b")
    assert result.ok and result.stdout.strip() == "ab"


def test_run_never_raises():
    assert proc.run(["kbe-no-such-program-xyz"]).code == proc.NOT_FOUND
    failed = proc.run([sys.executable, "-c", "import sys; sys.exit(3)"])
    assert failed.code == 3 and not failed.ok
    slow = proc.run([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.2)
    assert slow.code == proc.TIMED_OUT


# --- db commands ----------------------------------------------------------------


def _repo(tmp_path):
    folder = tmp_path / "supabase" / "migrations"
    folder.mkdir(parents=True)
    (folder / "0000_prelude.sql").write_text("create schema if not exists workspace;\n")
    (folder / "0001_first.sql").write_text("select 1;\n")


class FakeDatabase:
    """Answers psql the way a real tracking table would."""

    def __init__(self, schema="workspace"):
        self.rows = {}
        self.exists = False
        self.schema = schema

    def __call__(self, argv, stdin):
        if "to_regclass" in stdin:
            return proc.ProcResult(0, "t\n" if self.exists else "f\n", "")
        if "to_regnamespace" in stdin:
            return proc.ProcResult(0, "t\n", "")
        if stdin.startswith("select n.nspname"):
            return proc.ProcResult(0, f"{self.schema}\n" if self.exists else "", "")
        if "information_schema.columns" in stdin:
            return proc.ProcResult(0, "1\n", "")
        if stdin.startswith("select distinct kb_schema"):
            return proc.ProcResult(0, f"{self.schema}\n" if self.rows else "", "")
        if stdin.startswith("select filename"):
            out = "".join(f"{name}\x1f{digest}\n" for name, digest in sorted(self.rows.items()))
            return proc.ProcResult(0, out, "")
        if f"create table if not exists {self.schema}.kbe_migrations" in stdin:
            self.exists = True
        for line in stdin.splitlines():
            if line.startswith(f"insert into {self.schema}.kbe_migrations"):
                name, digest, named = line.split("values ('")[1].split("')")[0].split("', '")
                assert named == self.schema
                self.rows[name] = digest
        return proc.ProcResult(0, "", "")


def test_migrate_and_adopt_commands(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    _repo(tmp_path)
    database = FakeDatabase()
    runner = FakeRunner({"psql": database})
    ctx, seen = make_context(tmp_path, runner=runner)
    ctx.env_file.write_text(URL_LINE)

    assert cli.main(["db", "migrate", "--dry-run"], ctx) == 0
    assert database.rows == {} and not database.exists
    assert cli.main(["db", "migrate"], ctx) == 0
    assert sorted(database.rows) == ["0000_prelude.sql", "0001_first.sql"]
    assert seen[-1] == "Applied 2 migration(s)."
    assert cli.main(["db", "migrate"], ctx) == 0
    assert seen[-1] == "Nothing to apply: the database is up to date."

    assert cli.main(["db", "adopt", "--through", "0001"], ctx) == 1
    assert "already has 2 recorded" in capsys.readouterr().err
    assert cli.main(["db", "adopt", "--through", "0001", "--force"], ctx) == 0

    (tmp_path / "supabase" / "migrations" / "0001_first.sql").write_text("select 2;\n")
    assert cli.main(["db", "migrate"], ctx) == 1
    assert "--accept-changed 0001_first.sql" in capsys.readouterr().err
    assert cli.main(["db", "migrate", "--accept-changed", "0001_first.sql"], ctx) == 0
    assert cli.main(["db", "migrate"], ctx) == 0
    assert all("fake-local-pw" not in line for line in runner.lines())


def test_adopt_command_on_an_untracked_database(tmp_path, monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    _repo(tmp_path)
    database = FakeDatabase()
    ctx, seen = make_context(tmp_path, runner=FakeRunner({"psql": database}))
    ctx.env_file.write_text(URL_LINE)
    assert cli.main(["db", "adopt", "--through", "0000"], ctx) == 0
    assert sorted(database.rows) == ["0000_prelude.sql"]
    assert cli.main(["db", "migrate", "--dry-run"], ctx) == 0
    assert "would apply 0001_first.sql" in seen


def test_deploy_functions_dry_run_prints_the_command(tmp_path):
    ctx, seen = make_context(tmp_path)
    assert cli.main(["db", "deploy-functions", "--project-ref", REF, "--dry-run"], ctx) == 0
    assert seen == [
        "would clear the function's KB_SCHEMA setting if it has one",
        f"would run: supabase functions deploy embed --project-ref {REF} --no-verify-jwt",
    ]
    assert ctx.runner.calls == []


def test_deploy_functions_runs_supabase_and_remembers_the_ref(tmp_path):
    ctx, seen = make_context(tmp_path)
    ctx.env_file.write_text(
        f"SUPABASE_URL=https://{REF}.supabase.co\nSUPABASE_ACCESS_TOKEN=fake-login-value-123\n"
    )
    assert cli.main(["db", "deploy-functions"], ctx) == 0
    assert ctx.runner.calls[0]["argv"] == ["supabase", "secrets", "list", "--project-ref", REF]
    call = ctx.runner.calls[1]
    assert len(ctx.runner.calls) == 2, "no KB_SCHEMA setting was listed, so none is cleared"
    assert call["argv"] == ["supabase", "functions", "deploy", "embed", "--project-ref", REF,
                            "--no-verify-jwt"]
    assert call["extra"] == {"SUPABASE_ACCESS_TOKEN": "fake-login-value-123"}
    assert call["cwd"] == tmp_path
    assert json.loads(ctx.state_file.read_text())["answers"]["supabase_project_ref"] == REF
    assert "fake-login-value-123" not in "\n".join(seen)


def test_deploy_functions_clears_an_old_schema_setting_on_the_default_schema(tmp_path, capsys):
    listed = proc.ProcResult(0, "NAME | DIGEST\nKB_SCHEMA | abc123\nOTHER_KB_SCHEMAS | d\n", "")
    runner = FakeRunner({"supabase secrets list": listed})
    ctx, seen = make_context(tmp_path, runner=runner)
    ctx.env_file.write_text(f"SUPABASE_PROJECT_REF={REF}\n")
    assert cli.main(["db", "deploy-functions"], ctx) == 0
    assert [call["argv"][:4] for call in runner.calls] == [
        ["supabase", "secrets", "list", "--project-ref"],
        ["supabase", "secrets", "unset", "KB_SCHEMA"],
        ["supabase", "functions", "deploy", "embed"],
    ]
    assert any("Cleared the function's old KB_SCHEMA" in line for line in seen)


def test_deploy_functions_stops_when_the_old_setting_cannot_be_read_or_cleared(tmp_path, capsys):
    for answers in (
        {"supabase secrets list": proc.ProcResult(1, "", "no access")},
        {"supabase secrets list": proc.ProcResult(0, "KB_SCHEMA | abc\n", ""),
         "supabase secrets unset": proc.ProcResult(1, "", "no access")},
    ):
        runner = FakeRunner(answers)
        ctx, _ = make_context(tmp_path, runner=runner)
        ctx.env_file.write_text(f"SUPABASE_PROJECT_REF={REF}\n")
        assert cli.main(["db", "deploy-functions"], ctx) == 1
        assert "Nothing was deployed" in capsys.readouterr().err
        assert not [c for c in runner.calls if c["argv"][1] == "functions"]


def test_deploy_functions_failure_is_redacted(tmp_path, capsys):
    runner = FakeRunner({"supabase": proc.ProcResult(1, "", "bad login fake-login-value-123")})
    ctx, _ = make_context(tmp_path, runner=runner)
    ctx.env_file.write_text(f"SUPABASE_PROJECT_REF={REF}\nSUPABASE_ACCESS_TOKEN=fake-login-value-123\n")
    assert cli.main(["db", "deploy-functions"], ctx) == 1
    err = capsys.readouterr().err
    assert "supabase login" in err and "fake-login-value-123" not in err
    assert not ctx.state_file.exists()


def test_deploy_functions_needs_a_project_ref(tmp_path, capsys):
    ctx, _ = make_context(tmp_path)
    assert cli.main(["db", "deploy-functions"], ctx) == 1
    assert "No Supabase project ref" in capsys.readouterr().err
    assert isinstance(KbeError("x"), Exception)
