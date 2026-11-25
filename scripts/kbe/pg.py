"""Talking to Postgres through `psql`.

The database URL comes from the local env file (KBE_DATABASE_URL). It is
split into the PG* variables libpq reads and handed to `psql` through the
child's environment -- never as a command-line argument, where `ps` would
show the password. SQL goes in on standard input for the same reason.
"""

from __future__ import annotations

import glob
import os
import shutil
from dataclasses import dataclass, field
from typing import Mapping, Sequence
from urllib.parse import parse_qsl, unquote, urlsplit

from knowledge.kb_schema import DEFAULT_SCHEMA, validate

from . import proc, secrets
from .errors import KbeError
from .migrations import Migration
from .schema_rewrite import rewrite_schema

DATABASE_URL_KEY = "KBE_DATABASE_URL"
PSQL_OVERRIDE_VAR = "KBE_PSQL"
TRACKING_NAME = "kbe_migrations"
_SEPARATOR = "\x1f"
_QUERY_OPTIONS = {
    "sslmode": "PGSSLMODE",
    "sslrootcert": "PGSSLROOTCERT",
    "connect_timeout": "PGCONNECT_TIMEOUT",
    "options": "PGOPTIONS",
    "application_name": "PGAPPNAME",
}
_PSQL_GLOBS = (
    "/opt/homebrew/opt/postgresql@*/bin/psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/usr/local/opt/postgresql@*/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
    "/usr/lib/postgresql/*/bin/psql",
)



def tracking_table(schema: str) -> str:
    """The table that remembers which migrations ran."""
    try:
        return f"{validate(schema)}.{TRACKING_NAME}"
    except ValueError as error:
        raise KbeError(str(error)) from error


def tracking_sql(schema: str) -> str:
    """Create the tracking table, or bring an older one up to date.

    `kb_schema` records which schema the migrations were applied to. A table
    from before that column existed lives in the schema it tracked, so its
    rows are filled in with that name.
    """
    table = tracking_table(schema)
    named = quote_literal(schema)
    return f"""
create schema if not exists {schema};
create table if not exists {table} (
    filename   text        primary key,
    checksum   text        not null,
    applied_at timestamptz not null default now()
);
alter table {table} add column if not exists kb_schema text;
update {table} set kb_schema = {named} where kb_schema is null;
alter table {table} alter column kb_schema set not null;
comment on table {table} is
    'Which migration files `kbe db migrate` has applied. Written by the CLI only.';
alter table {table} enable row level security;
revoke all on {table} from public;
do $$
declare
    v_role text;
begin
    foreach v_role in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = v_role) then
            execute format('revoke all on {table} from %I', v_role);
        end if;
    end loop;
end $$;
"""


def connection_vars(url: str) -> dict[str, str]:
    """Split a postgres:// URL into PG* variables. Never echoes the URL."""
    bad = KbeError(
        f"{DATABASE_URL_KEY} is not a usable database URL. Expected "
        "postgresql://user:password@host:5432/dbname"
    )
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError as error:
        raise bad from error
    if parts.scheme not in ("postgres", "postgresql") or not parts.hostname:
        raise bad
    found = {
        "PGHOST": parts.hostname,
        "PGPORT": str(port or 5432),
        "PGUSER": unquote(parts.username or ""),
        "PGPASSWORD": unquote(parts.password or ""),
        "PGDATABASE": unquote(parts.path.lstrip("/")) or "postgres",
        "PGCONNECT_TIMEOUT": "15",
    }
    for name, value in parse_qsl(parts.query):
        if name not in _QUERY_OPTIONS:
            raise KbeError(f'{DATABASE_URL_KEY} has an option this tool does not know: "{name}".')
        found = {**found, _QUERY_OPTIONS[name]: value}
    return {name: value for name, value in found.items() if value}


def find_psql() -> str:
    """Path to `psql`: KBE_PSQL, then PATH, then the usual install folders."""
    override = os.environ.get(PSQL_OVERRIDE_VAR)
    if override:
        return override
    on_path = shutil.which("psql")
    if on_path:
        return on_path
    for pattern in _PSQL_GLOBS:
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[-1]
    raise KbeError(
        "psql is not installed. Install the Postgres client "
        "(macOS: brew install libpq; Debian/Ubuntu: apt install postgresql-client)."
    )


def quote_literal(text: str) -> str:
    """A SQL string literal. Only for values this tool produced or checked."""
    if "\x00" in text:
        raise KbeError("A value contains a NUL character and cannot be sent to the database.")
    return "'" + text.replace("'", "''") + "'"


@dataclass(frozen=True)
class Psql:
    """One database, reached with `psql`."""

    conn: Mapping[str, str] = field(repr=False)
    runner: proc.Runner = proc.run
    binary: str = "psql"

    def script(self, sql: str, *, tuples: bool = False, timeout: float = 600) -> proc.ProcResult:
        """Run SQL in one transaction; stop at the first error."""
        argv = [
            self.binary, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1",
            "--single-transaction", "--file", "-",
        ]
        if tuples:
            argv = [*argv, "--tuples-only", "--no-align", "--field-separator", _SEPARATOR]
        result = self.runner(argv, extra=dict(self.conn), stdin=sql, timeout=timeout)
        return proc.ProcResult(result.code, result.stdout, self.clean(result.stderr))

    def clean(self, text: str) -> str:
        return secrets.redact(text, {"password": self.conn.get("PGPASSWORD", "")}).strip()

    def rows(self, sql: str) -> list[tuple[str, ...]]:
        """Rows of a query as text. Raises with psql's own (redacted) message."""
        result = self.script(sql, tuples=True)
        if not result.ok:
            raise KbeError(f"The database refused a query:\n{result.stderr}")
        lines = [line for line in result.stdout.splitlines() if line != ""]
        return [tuple(line.split(_SEPARATOR)) for line in lines]


def connect(values: Mapping[str, str], runner: proc.Runner = proc.run) -> Psql:
    """A Psql for the database named in the local env file."""
    url = secrets.require(values, DATABASE_URL_KEY)[DATABASE_URL_KEY]
    return Psql(conn=connection_vars(url), runner=runner, binary=find_psql())


def _record_sql(migration: Migration, schema: str) -> str:
    """Remember one file. The checksum is of the file as written, not as renamed."""
    return (
        f"insert into {tracking_table(schema)} (filename, checksum, kb_schema) values "
        f"({quote_literal(migration.filename)}, {quote_literal(migration.checksum)}, "
        f"{quote_literal(schema)}) "
        "on conflict (filename) do update set checksum = excluded.checksum, "
        "kb_schema = excluded.kb_schema, applied_at = now();\n"
    )


# Schemas that hold a tracking table, plus the default schema when it holds an
# Engine built without this tool (its two access tables side by side). Only
# the default schema can: nothing else writes these tables under another name.
_ENGINE_SCHEMAS_SQL = (
    "select n.nspname from pg_namespace n where exists (select 1 from pg_class c "
    f"where c.relnamespace = n.oid and c.relname = '{TRACKING_NAME}' "
    f"and c.relkind in ('r', 'p')) or (n.nspname = '{DEFAULT_SCHEMA}' "
    "and exists (select 1 from pg_class c "
    "where c.relnamespace = n.oid and c.relname = 'principals' and c.relkind in ('r', 'p')) "
    "and exists (select 1 from pg_class c where c.relnamespace = n.oid "
    "and c.relname = 'access_grants' and c.relkind in ('r', 'p'))) order by 1;"
)


@dataclass(frozen=True)
class PsqlExecutor:
    """What `kbe db migrate` and `kbe db adopt` need from a database."""

    psql: Psql
    schema: str = DEFAULT_SCHEMA

    def __post_init__(self) -> None:
        # The name goes into SQL text; never build one from an unchecked value.
        tracking_table(self.schema)

    @property
    def table(self) -> str:
        return tracking_table(self.schema)

    def tracking_exists(self) -> bool:
        rows = self.psql.rows(f"select to_regclass('{self.table}') is not null;")
        return bool(rows) and rows[0][0] == "t"

    def schema_exists(self) -> bool:
        rows = self.psql.rows(f"select to_regnamespace('{self.schema}') is not null;")
        return bool(rows) and rows[0][0] == "t"

    def _has_schema_column(self) -> bool:
        rows = self.psql.rows(
            "select count(*) from information_schema.columns where table_schema = "
            f"'{self.schema}' and table_name = '{TRACKING_NAME}' and column_name = 'kb_schema';"
        )
        return bool(rows) and rows[0][0] == "1"

    def recorded_schemas(self) -> tuple[str, ...]:
        """Every schema this database has an Engine in, tracked or not."""
        holders = {row[0] for row in self.psql.rows(_ENGINE_SCHEMAS_SQL)}
        if self.schema not in holders or not self._has_schema_column():
            return tuple(sorted(holders))
        named = self.psql.rows(f"select distinct kb_schema from {self.table} order by 1;")
        return tuple(sorted(holders | {row[0] for row in named if row[0]}))

    def applied(self) -> dict[str, str]:
        rows = self.psql.rows(f"select filename, checksum from {self.table} order by 1;")
        return {row[0]: row[1] for row in rows}

    def ensure_tracking(self) -> None:
        result = self.psql.script(tracking_sql(self.schema))
        if not result.ok:
            raise KbeError(f"Could not create {self.table}:\n{result.stderr}")

    def _body(self, migration: Migration) -> str:
        """The file's SQL for this schema. Unchanged for the default schema."""
        try:
            written = migration.path.read_text(encoding="utf-8")
        except OSError as error:
            raise KbeError(f"Could not read {migration.filename}: {error.strerror}.") from error
        try:
            return rewrite_schema(written, self.schema)
        except KbeError as error:
            raise KbeError(f"{migration.filename} cannot be applied. {error}") from error

    def prepare(self, migrations: Sequence[Migration]) -> None:
        """Check every file can be applied to this schema, before any is run."""
        for migration in migrations:
            self._body(migration)

    def apply(self, migration: Migration) -> None:
        """Run one file and record it, in the same transaction."""
        body = self._body(migration)
        result = self.psql.script(f"{body}\n;\n{_record_sql(migration, self.schema)}")
        if not result.ok:
            raise KbeError(
                f"{migration.filename} failed and was rolled back. Nothing after it "
                f"was run.\n{result.stderr}"
            )

    def record(self, migrations: Sequence[Migration]) -> None:
        """Record files as applied without running them (all or nothing)."""
        if not migrations:
            return
        result = self.psql.script("".join(_record_sql(m, self.schema) for m in migrations))
        if not result.ok:
            raise KbeError(f"Could not record migrations:\n{result.stderr}")
