"""psql plumbing: the URL never reaches a command line, errors are redacted."""

from __future__ import annotations

import pytest

from kbe import migrations as mig
from kbe import pg, proc
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner

PW = "fake-local-pw-123"
URL = f"postgresql://postgres:{PW}@db.example.com:6543/postgres?sslmode=require"


def _psql(runner):
    return pg.Psql(conn=pg.connection_vars(URL), runner=runner, binary="psql")


def test_connection_vars_splits_the_url():
    assert pg.connection_vars(URL) == {
        "PGHOST": "db.example.com",
        "PGPORT": "6543",
        "PGUSER": "postgres",
        "PGPASSWORD": PW,
        "PGDATABASE": "postgres",
        "PGCONNECT_TIMEOUT": "15",
        "PGSSLMODE": "require",
    }


def test_connection_vars_defaults_and_percent_encoding():
    found = pg.connection_vars("postgres://us%40er:p%2Fw@localhost")
    assert found["PGUSER"] == "us@er"
    assert found["PGPASSWORD"] == "p/w"
    assert found["PGPORT"] == "5432"
    assert found["PGDATABASE"] == "postgres"


@pytest.mark.parametrize(
    "bad",
    ["", "mysql://u:p@h/db", "postgresql:///nohost", f"postgresql://u:{PW}@h:notaport/db"],
)
def test_bad_urls_are_refused_without_echoing_them(bad):
    with pytest.raises(KbeError) as caught:
        pg.connection_vars(bad)
    assert PW not in str(caught.value)


def test_unknown_url_option_is_named_but_not_its_value():
    with pytest.raises(KbeError) as caught:
        pg.connection_vars(f"postgresql://u:{PW}@h/db?weird={PW}")
    assert '"weird"' in str(caught.value)
    assert PW not in str(caught.value)


def test_script_passes_credentials_by_environment_and_sql_by_stdin():
    runner = FakeRunner()
    _psql(runner).script("select 1;")
    call = runner.calls[0]
    assert PW not in " ".join(call["argv"])
    assert "db.example.com" not in " ".join(call["argv"])
    assert call["extra"]["PGPASSWORD"] == PW
    assert call["stdin"] == "select 1;"
    assert "--single-transaction" in call["argv"]
    assert "ON_ERROR_STOP=1" in call["argv"]


def test_errors_from_psql_are_redacted():
    runner = FakeRunner({"psql": proc.ProcResult(2, "", f"FATAL: bad password {PW}\n")})
    result = _psql(runner).script("select 1;")
    assert PW not in result.stderr
    with pytest.raises(KbeError) as caught:
        _psql(runner).rows("select 1;")
    assert PW not in str(caught.value)


def test_rows_splits_fields_and_drops_blank_lines():
    runner = FakeRunner({"psql": proc.ProcResult(0, "a\x1fb\n\nc\x1fd\n", "")})
    assert _psql(runner).rows("select 1;") == [("a", "b"), ("c", "d")]
    assert "--tuples-only" in runner.calls[0]["argv"]


def test_find_psql_prefers_the_override(monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "/custom/psql")
    assert pg.find_psql() == "/custom/psql"


def test_find_psql_falls_back_then_gives_install_advice(monkeypatch):
    monkeypatch.delenv(pg.PSQL_OVERRIDE_VAR, raising=False)
    monkeypatch.setattr(pg.shutil, "which", lambda _name: "/usr/bin/psql")
    assert pg.find_psql() == "/usr/bin/psql"
    monkeypatch.setattr(pg.shutil, "which", lambda _name: None)
    monkeypatch.setattr(pg.glob, "glob", lambda pattern: ["/opt/x/psql"] if "libpq" in pattern else [])
    assert pg.find_psql() == "/opt/x/psql"
    monkeypatch.setattr(pg.glob, "glob", lambda _pattern: [])
    with pytest.raises(KbeError, match="psql is not installed"):
        pg.find_psql()


def test_connect_needs_the_database_url(monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    with pytest.raises(KbeError, match="KBE_DATABASE_URL"):
        pg.connect({})
    assert pg.connect({"KBE_DATABASE_URL": URL}).conn["PGHOST"] == "db.example.com"


def test_quote_literal():
    assert pg.quote_literal("it's") == "'it''s'"
    with pytest.raises(KbeError):
        pg.quote_literal("a\x00b")


def test_psql_repr_hides_the_connection():
    assert PW not in repr(_psql(FakeRunner()))


@pytest.fixture
def one(tmp_path):
    path = tmp_path / "0001_first.sql"
    path.write_text("create table t (id int);")
    return mig.discover(tmp_path)[0]


def test_executor_reads_tracking_state():
    answers = {"psql": lambda argv, stdin: proc.ProcResult(
        0, "t\n" if "to_regclass" in stdin else "0001_a.sql\x1fabc\n", "")}
    executor = pg.PsqlExecutor(_psql(FakeRunner(answers)))
    assert executor.tracking_exists() is True
    assert executor.applied() == {"0001_a.sql": "abc"}


def test_executor_apply_runs_file_and_record_together(one):
    runner = FakeRunner()
    pg.PsqlExecutor(_psql(runner)).apply(one)
    assert len(runner.calls) == 1
    sent = runner.calls[0]["stdin"]
    assert sent.startswith("create table t (id int);")
    assert "insert into workspace.kbe_migrations" in sent
    assert f"'{one.checksum}'" in sent and "'0001_first.sql'" in sent


def test_executor_apply_failure_names_the_file(one):
    runner = FakeRunner({"psql": proc.ProcResult(3, "", "ERROR: relation exists")})
    with pytest.raises(KbeError) as caught:
        pg.PsqlExecutor(_psql(runner)).apply(one)
    assert "0001_first.sql failed and was rolled back" in str(caught.value)
    assert "relation exists" in str(caught.value)


def test_executor_record_and_ensure(one):
    runner = FakeRunner()
    executor = pg.PsqlExecutor(_psql(runner))
    executor.record(())
    assert runner.calls == []
    executor.record((one,))
    assert "on conflict (filename) do update" in runner.calls[0]["stdin"]
    executor.ensure_tracking()
    created = runner.calls[1]["stdin"]
    assert "create table if not exists workspace.kbe_migrations" in created
    assert "enable row level security" in created

    broken = pg.PsqlExecutor(_psql(FakeRunner({"psql": proc.ProcResult(3, "", "nope")})))
    with pytest.raises(KbeError, match="Could not create"):
        broken.ensure_tracking()
    with pytest.raises(KbeError, match="Could not record"):
        broken.record((one,))
