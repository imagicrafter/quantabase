"""One setting, KB_SCHEMA, decides the schema for every `kbe` command."""

from __future__ import annotations

import pytest

from kbe import cli, config_store, manifest, migrations as mig, pg, proc, schema, verify
from kbe.errors import KbeError, UsageError
from kbe.tests.helpers import FakeRunner, make_context
from kbe.tests.test_cli import REF, URL_LINE, FakeDatabase, _repo
from kbe.tests.test_pg import _psql

FAKE_ANON = "fake-anon-key-0123456789"
FAKE_SECRET = "fake-jwt-secret-0123456789-0123456789"


@pytest.fixture(autouse=True)
def no_process_setting(monkeypatch):
    monkeypatch.delenv(schema.SCHEMA_ENV_VAR, raising=False)


# --- choosing ---------------------------------------------------------------


def test_default_is_workspace():
    assert schema.chosen({}) == "workspace"


def test_env_file_value_is_used():
    assert schema.chosen({"KB_SCHEMA": "kb_acme"}) == "kb_acme"


def test_process_value_is_used(monkeypatch):
    monkeypatch.setenv("KB_SCHEMA", "kb_acme")
    assert schema.chosen({}) == "kb_acme"


def test_flag_names_the_schema_when_nothing_is_set():
    assert schema.chosen({}, "kb_acme") == "kb_acme"


def test_flag_may_repeat_the_setting_but_not_disagree():
    assert schema.chosen({"KB_SCHEMA": "kb_acme"}, "kb_acme") == "kb_acme"
    with pytest.raises(KbeError, match="disagrees"):
        schema.chosen({"KB_SCHEMA": "kb_acme"}, "kb_other")


@pytest.mark.parametrize("bad", ["public", "pg_catalog", "Has-Dash", ""])
def test_a_bad_name_is_a_usage_error_never_a_fallback(bad):
    if bad:
        with pytest.raises(UsageError):
            schema.chosen({"KB_SCHEMA": bad})
    with pytest.raises(UsageError):
        schema.chosen({}, bad)


# --- the tracking table ------------------------------------------------------


@pytest.fixture
def one(tmp_path):
    path = tmp_path / "0001_first.sql"
    path.write_text(
        "create table workspace.t (id int);\n-- in workspace.t\n"
        "create function workspace.f() returns int language sql "
        "set search_path = workspace, pg_temp as $$ select 1 $$;\n"
    )
    return mig.discover(tmp_path)[0]


def test_apply_sends_the_file_unchanged_for_the_default_schema(one):
    runner = FakeRunner()
    pg.PsqlExecutor(_psql(runner)).apply(one)
    sent = runner.calls[0]["stdin"]
    assert sent.startswith(one.path.read_text() + "\n;\n")
    assert "values ('0001_first.sql', " in sent and ", 'workspace') on conflict" in sent


def test_apply_renames_the_schema_and_records_the_original_checksum(one):
    runner = FakeRunner()
    pg.PsqlExecutor(_psql(runner), "kb_acme").apply(one)
    sent = runner.calls[0]["stdin"]
    assert "create table kb_acme.t (id int);" in sent
    assert "set search_path = kb_acme, pg_temp" in sent
    assert "-- in workspace.t" in sent
    assert "workspace.t (" not in sent and "workspace.f" not in sent
    assert "insert into kb_acme.kbe_migrations (filename, checksum, kb_schema)" in sent
    assert f"'{mig.checksum(one.path)}', 'kb_acme')" in sent


def test_apply_refuses_a_file_it_cannot_rename(tmp_path):
    (tmp_path / "0001_odd.sql").write_text("select workspace from t;\n")
    runner = FakeRunner()
    executor = pg.PsqlExecutor(_psql(runner), "kb_acme")
    found = mig.discover(tmp_path)
    with pytest.raises(KbeError, match="0001_odd.sql cannot be applied"):
        executor.prepare(found)
    with pytest.raises(KbeError, match="0001_odd.sql cannot be applied"):
        executor.apply(found[0])
    assert runner.calls == []
    pg.PsqlExecutor(_psql(runner)).prepare(found)


def test_tracking_table_is_built_in_the_chosen_schema():
    created = pg.tracking_sql("kb_acme")
    assert "create schema if not exists kb_acme;" in created
    assert "create table if not exists kb_acme.kbe_migrations" in created
    assert "add column if not exists kb_schema text" in created
    assert "set kb_schema = 'kb_acme' where kb_schema is null" in created
    assert "workspace" not in created
    assert "create table if not exists workspace.kbe_migrations" in pg.tracking_sql("workspace")


def _answers(holders, has_column="1", named=""):
    def answer(argv, stdin):
        if stdin.startswith("select n.nspname"):
            return proc.ProcResult(0, holders, "")
        if "information_schema.columns" in stdin:
            return proc.ProcResult(0, f"{has_column}\n", "")
        if stdin.startswith("select distinct kb_schema"):
            return proc.ProcResult(0, named, "")
        return proc.ProcResult(0, "", "")

    return {"psql": answer}


def test_recorded_schemas_reads_where_the_tracking_table_lives():
    fresh = pg.PsqlExecutor(_psql(FakeRunner(_answers(""))), "kb_acme")
    assert fresh.recorded_schemas() == ()
    elsewhere = pg.PsqlExecutor(_psql(FakeRunner(_answers("workspace\n"))), "kb_acme")
    assert elsewhere.recorded_schemas() == ("workspace",)


def test_recorded_schemas_reads_the_column_too():
    answers = _answers("workspace\n", named="kb_old\nworkspace\n")
    assert pg.PsqlExecutor(_psql(FakeRunner(answers))).recorded_schemas() == ("kb_old", "workspace")
    older = _answers("workspace\n", has_column="0")
    assert pg.PsqlExecutor(_psql(FakeRunner(older))).recorded_schemas() == ("workspace",)


# --- the commands -------------------------------------------------------------


def _setup(tmp_path, monkeypatch, database, more=""):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    _repo(tmp_path)
    runner = FakeRunner({"psql": database})
    ctx, seen = make_context(tmp_path, runner=runner)
    ctx.env_file.write_text(URL_LINE + more)
    return ctx, seen, runner


def test_migrate_command_uses_the_env_file_schema(tmp_path, monkeypatch):
    database = FakeDatabase("kb_acme")
    ctx, seen, runner = _setup(tmp_path, monkeypatch, database, "KB_SCHEMA=kb_acme\n")
    assert cli.main(["db", "migrate"], ctx) == 0
    assert sorted(database.rows) == ["0000_prelude.sql", "0001_first.sql"]
    assert "Schema: kb_acme" in seen
    # Everything sent, except the lookup that asks where an Engine already is.
    sent = "\n".join(
        call["stdin"] for call in runner.calls
        if not call["stdin"].startswith("select n.nspname")
    )
    assert "create schema if not exists kb_acme;" in sent
    assert "workspace" not in sent


def test_migrate_command_takes_the_schema_flag(tmp_path, monkeypatch):
    database = FakeDatabase("kb_acme")
    ctx, _, _ = _setup(tmp_path, monkeypatch, database)
    assert cli.main(["db", "migrate", "--schema", "kb_acme"], ctx) == 0
    assert sorted(database.rows) == ["0000_prelude.sql", "0001_first.sql"]


def test_migrate_command_rejects_bad_and_conflicting_schemas(tmp_path, monkeypatch, capsys):
    database = FakeDatabase()
    ctx, _, runner = _setup(tmp_path, monkeypatch, database, "KB_SCHEMA=kb_acme\n")
    assert cli.main(["db", "migrate", "--schema", "public"], ctx) == 2
    assert cli.main(["db", "migrate", "--schema", "kb_other"], ctx) == 1
    assert "disagrees" in capsys.readouterr().err
    assert runner.calls == []


def test_migrate_command_refuses_a_database_built_under_the_default(tmp_path, monkeypatch, capsys):
    database = FakeDatabase("workspace")
    ctx, _, _ = _setup(tmp_path, monkeypatch, database)
    assert cli.main(["db", "migrate"], ctx) == 0
    before = dict(database.rows)
    assert cli.main(["db", "migrate", "--schema", "kb_acme"], ctx) == 1
    assert 'holds an Engine in the schema "workspace"' in capsys.readouterr().err
    assert database.rows == before


def test_default_migrate_output_is_unchanged(tmp_path, monkeypatch):
    ctx, seen, _ = _setup(tmp_path, monkeypatch, FakeDatabase())
    assert cli.main(["db", "migrate"], ctx) == 0
    assert seen == ["apply 0000_prelude.sql", "apply 0001_first.sql", "Applied 2 migration(s)."]


def test_deploy_functions_tells_the_function_its_schema(tmp_path):
    ctx, seen = make_context(tmp_path)
    ctx.env_file.write_text(f"SUPABASE_PROJECT_REF={REF}\nKB_SCHEMA=kb_acme\n")
    assert cli.main(["db", "deploy-functions", "--dry-run"], ctx) == 0
    assert seen[0] == f"would run: supabase secrets set KB_SCHEMA=kb_acme --project-ref {REF}"
    assert cli.main(["db", "deploy-functions"], ctx) == 0
    assert [call["argv"][:3] for call in ctx.runner.calls] == [
        ["supabase", "secrets", "set"], ["supabase", "functions", "deploy"],
    ]


def test_deploy_functions_stops_when_the_schema_cannot_be_set(tmp_path, capsys):
    runner = FakeRunner({"supabase secrets": proc.ProcResult(1, "", "no access")})
    ctx, _ = make_context(tmp_path, runner=runner)
    ctx.env_file.write_text(f"SUPABASE_PROJECT_REF={REF}\nKB_SCHEMA=kb_acme\n")
    assert cli.main(["db", "deploy-functions"], ctx) == 1
    assert "Nothing was deployed" in capsys.readouterr().err
    assert len(runner.calls) == 1


# --- config store and verify --------------------------------------------------


class _Response:
    status_code = 200

    def json(self):
        return {"owner_email": "o"}


def test_api_store_sends_the_schema_as_the_profile():
    seen = []
    store = config_store.ApiStore(
        url="https://project.example.com", anon_key=FAKE_ANON, jwt_secret=FAKE_SECRET,
        post=lambda url, headers, body: seen.append(headers) or _Response(), schema="kb_acme",
    )
    store.get()
    assert seen[0]["Content-Profile"] == "kb_acme"


def test_db_store_calls_the_functions_in_the_schema():
    runner = FakeRunner({"psql": proc.ProcResult(0, "{}", "")})
    store = config_store.DbStore(_psql(runner), "kb_acme")
    store.get()
    store.apply({"a": 1}, "abc")
    sent = [call["stdin"] for call in runner.calls]
    assert "select kb_acme.engine_config_get();" in sent[0]
    assert "select kb_acme.engine_config_apply(" in sent[1]
    assert all("workspace" not in text for text in sent)


def test_choose_hands_the_schema_to_the_store(monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    values = {"KBE_DATABASE_URL": "postgresql://u:fake-local-pw@localhost/db", "KB_SCHEMA": "kb_acme"}
    assert config_store.choose(values, "db").schema == "kb_acme"
    api = {"SUPABASE_URL": "https://x.example.com", "SUPABASE_ANON_KEY": FAKE_ANON,
           "SUPABASE_JWT_SECRET": FAKE_SECRET, "KB_SCHEMA": "kb_acme"}
    assert config_store.choose(api, "api").schema == "kb_acme"
    with pytest.raises(UsageError):
        config_store.choose({**api, "KB_SCHEMA": "public"}, "api")


def _check(kind, run, **more):
    raw = {"phases": [{"id": "p", "title": "P", "verify": [
        {"id": "c", "description": "d", "kind": kind, "run": run, **more}]}]}
    phase = manifest.parse(raw)[0]
    return phase, phase.checks[0]


def _tools(tmp_path, runner, name):
    conn = pg.connection_vars("postgresql://postgres:fake-local-pw@localhost/postgres")
    psql = pg.Psql(conn=conn, runner=runner, binary="psql")
    return verify.Tools({}, {}, psql, runner, tmp_path, tmp_path / "local.env", schema=name)


def test_verify_sql_checks_are_renamed_for_the_schema(tmp_path):
    runner = FakeRunner({"psql": proc.ProcResult(0, "1\n", "")})
    phase, check = _check("sql", "select count(*) from workspace.documents;",
                          expect={"equals": "1"})
    assert verify.run_check(phase, check, _tools(tmp_path, runner, "kb_acme")).status == "pass"
    assert "from kb_acme.documents" in runner.calls[0]["stdin"]
    verify.run_check(phase, check, _tools(tmp_path, runner, "workspace"))
    assert "from workspace.documents" in runner.calls[1]["stdin"]


def test_verify_fails_a_check_it_cannot_rename(tmp_path):
    runner = FakeRunner()
    phase, check = _check("sql", "select workspace from t;", expect={"equals": "1"})
    result = verify.run_check(phase, check, _tools(tmp_path, runner, "kb_acme"))
    assert result.status == "fail" and runner.calls == []


def test_verify_shell_checks_are_told_the_schema(tmp_path):
    runner = FakeRunner()
    phase, check = _check("shell", "true")
    verify.run_check(phase, check, _tools(tmp_path, runner, "kb_acme"))
    assert runner.calls[0]["extra"]["KB_SCHEMA"] == "kb_acme"


def test_every_sql_check_in_the_real_manifest_can_be_renamed():
    from kbe.schema_rewrite import rewrite_schema
    from kbe.tests.test_verify import REAL_MANIFEST

    checks = [c for p in manifest.load(REAL_MANIFEST) for c in p.checks if c.kind == "sql"]
    assert len(checks) >= 6
    for check in checks:
        renamed = rewrite_schema(check.run, "kb_acme")
        assert "workspace" not in renamed, check.id


def test_the_manifest_checks_that_the_api_serves_the_schema():
    from kbe.tests.test_verify import REAL_MANIFEST

    found = [c for p in manifest.load(REAL_MANIFEST) for c in p.checks
             if c.id == "schema-served-by-api"]
    assert len(found) == 1 and found[0].kind == "shell"
    assert "expose-schema --check" in found[0].run


def test_render_prints_the_sql_for_the_schema(tmp_path):
    ctx, seen = make_context(tmp_path)
    ctx.env_file.write_text("KB_SCHEMA=kb_acme\n")
    path = tmp_path / "x.sql"
    path.write_text("select workspace.f(); -- workspace.f\n")
    assert cli.main(["db", "render", str(path)], ctx) == 0
    assert seen == ["select kb_acme.f(); -- workspace.f\n"]
    assert cli.main(["db", "render", str(tmp_path / "missing.sql")], ctx) == 1


def test_render_is_the_file_itself_for_the_default_schema(tmp_path):
    ctx, seen = make_context(tmp_path)
    path = tmp_path / "x.sql"
    path.write_text("select workspace.f();\n")
    assert cli.main(["db", "render", str(path)], ctx) == 0
    assert seen == ["select workspace.f();\n"]
    assert cli.main(["db", "render", str(path), "--schema", "kb_acme"], ctx) == 0
    assert seen[-1] == "select kb_acme.f();\n"


@pytest.mark.parametrize("bad", ["public", "x; drop schema y", "Bad", ""])
def test_sql_is_never_built_from_an_unchecked_schema_name(bad):
    with pytest.raises(KbeError):
        pg.PsqlExecutor(_psql(FakeRunner()), bad)
    with pytest.raises(KbeError):
        config_store.DbStore(_psql(FakeRunner()), bad)
    with pytest.raises(KbeError):
        pg.tracking_sql(bad)


def test_the_engine_lookup_also_finds_an_untracked_default_schema():
    runner = FakeRunner(_answers("workspace\n"))
    assert pg.PsqlExecutor(_psql(runner), "kb_acme").recorded_schemas() == ("workspace",)
    asked = runner.calls[0]["stdin"]
    assert "kbe_migrations" in asked and "'principals'" in asked and "'access_grants'" in asked
    assert "n.nspname = 'workspace'" in asked
