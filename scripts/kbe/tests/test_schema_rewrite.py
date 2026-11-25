"""The schema rename applied to migration SQL: exact, and it refuses to guess."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from kbe.schema_rewrite import SchemaRewriteError, rewrite_schema, scan

ROOT = Path(__file__).resolve().parents[3]
SQL_FILES = sorted(
    [*(ROOT / "supabase" / "migrations").glob("*.sql"), *(ROOT / "supabase" / "tests").glob("*.sql")]
)
IDS = [path.name for path in SQL_FILES]


def to_acme(sql: str) -> str:
    return rewrite_schema(sql, "kb_acme")


@pytest.mark.parametrize(
    ("written", "expected"),
    [
        ("select * from workspace.documents;", "select * from kb_acme.documents;"),
        ('select * from "workspace".documents;', 'select * from "kb_acme".documents;'),
        ('select * from workspace."Documents";', 'select * from kb_acme."Documents";'),
        ("select workspace.f(1), count(workspace.t.*);", "select kb_acme.f(1), count(kb_acme.t.*);"),
        ("create schema workspace;", "create schema kb_acme;"),
        ("create schema if not exists workspace;", "create schema if not exists kb_acme;"),
        ("CREATE SCHEMA IF NOT EXISTS workspace;", "CREATE SCHEMA IF NOT EXISTS kb_acme;"),
        ("grant usage on schema workspace to kb_engine;", "grant usage on schema kb_acme to kb_engine;"),
        (
            "alter default privileges in schema workspace revoke all on functions from public;",
            "alter default privileges in schema kb_acme revoke all on functions from public;",
        ),
        ("comment on schema workspace is 'the index';", "comment on schema kb_acme is 'the index';"),
        ("set search_path = workspace, pg_temp", "set search_path = kb_acme, pg_temp"),
        ("set search_path = workspace, public, pg_temp", "set search_path = kb_acme, public, pg_temp"),
        ("set search_path to public, workspace;", "set search_path to public, kb_acme;"),
        ('set search_path = "public", workspace', 'set search_path = "public", kb_acme'),
        ("where table_schema = 'workspace' and x", "where table_schema = 'kb_acme' and x"),
        ("where n.nspname = 'workspace'", "where n.nspname = 'kb_acme'"),
        ("p.pronamespace = 'workspace'::regnamespace", "p.pronamespace = 'kb_acme'::regnamespace"),
        ("select to_regclass('workspace.x');", "select to_regclass('kb_acme.x');"),
        ("conrelid = 'workspace.principals'::regclass", "conrelid = 'kb_acme.principals'::regclass"),
        (
            "execute format('%I.%I', 'workspace', v_name);",
            "execute format('%I.%I', 'kb_acme', v_name);",
        ),
        (
            "select has_function_privilege('anon', 'workspace.f(text, jsonb)', 'execute');",
            "select has_function_privilege('anon', 'kb_acme.f(text, jsonb)', 'execute');",
        ),
        (
            "execute 'select workspace.f(''a'') where s = ''workspace''::regnamespace';",
            "execute 'select kb_acme.f(''a'') where s = ''kb_acme''::regnamespace';",
        ),
        (
            "create policy p on workspace.documents using (workspace.can_read(domains));",
            "create policy p on kb_acme.documents using (kb_acme.can_read(domains));",
        ),
        (
            "create trigger t before insert on workspace.issues "
            "for each row execute function workspace.touch();",
            "create trigger t before insert on kb_acme.issues "
            "for each row execute function kb_acme.touch();",
        ),
        ("select Workspace.f();", "select kb_acme.f();"),
        ("select to_regnamespace('workspace');", "select to_regnamespace('kb_acme');"),
        (
            "select has_schema_privilege('kb_engine', 'workspace', 'usage');",
            "select has_schema_privilege('kb_engine', 'kb_acme', 'usage');",
        ),
        (
            "select has_schema_privilege('workspace', 'usage');",
            "select has_schema_privilege('kb_acme', 'usage');",
        ),
        ("select format('%I.%I', 'workspace', 't');", "select format('%I.%I', 'kb_acme', 't');"),
        ("alter table public.t set schema workspace;", "alter table public.t set schema kb_acme;"),
        ("drop schema if exists workspace;", "drop schema if exists kb_acme;"),
        ("select 'workspace.seq'::regclass;", "select 'kb_acme.seq'::regclass;"),
        (
            "select pg_get_serial_sequence('workspace.t', 'id');",
            "select pg_get_serial_sequence('kb_acme.t', 'id');",
        ),
        (
            "select 'see'\n  'workspace.documents for more';",
            "select 'see'\n  'kb_acme.documents for more';",
        ),
    ],
)
def test_renames_every_supported_form(written, expected):
    assert to_acme(written) == expected


@pytest.mark.parametrize(
    "written",
    [
        "select * from workspace_tasks;",
        "select myworkspace.x, workspaces.y, my_workspace from t;",
        "select workspace_id, workspace$x from public.t;",
        "select 'workspace_tasks', 'myworkspace.x';",
        "-- lives in workspace.documents; schema workspace\nselect 1;",
        "/* workspace.documents /* nested workspace */ still */ select 1;",
        'select "workspace_tasks", "Workspace" from t;',
    ],
)
def test_leaves_partial_words_and_comments_alone(written):
    assert to_acme(written) == written


@pytest.mark.parametrize(
    "written",
    [
        "select workspace from t;",
        "select t.workspace.x from t;",
        "select 'workspace';",
        "select 'ask the workspace administrator';",
        "insert into t (kind) values ('workspace');",
        'select "workspace" from t;',
        "grant usage on schema public, workspace to x;",
        "select $$workspace$$;",
        # A value or a setting that only looks like a schema name.
        "select current_setting('workspace.principal', true);",
        "select set_config('workspace.principal', 'x', true);",
        "set workspace.principal = 'x';",
        "set local workspace.principal = 'x';",
        "insert into workspace.scopes values ('workspace.admin');",
        "select format('select %L', 'workspace');",
        "select format('%I is %L', 'workspace', 'x');",
        "select has_schema_privilege('workspace', 'kb', 'usage');",
        "select * from t where my_schema = 'workspace';",
        "select * from x where table_schema = 'WORKSPACE';",
        "select 'Workspace.documents';",
        "select schema workspace from t;",
        # Spellings this tool does not decode.
        'create table U&"\\0077orkspace".t ();',
        "select U&'\\0077orkspace'::regnamespace;",
        "select 'work'\n'space'::regnamespace;",
        "select 'select * from work'\n  'space.t';",
    ],
)
def test_refuses_what_it_cannot_classify(written):
    with pytest.raises(SchemaRewriteError):
        to_acme(written)


def test_function_bodies_are_rewritten_and_their_comments_kept():
    written = (
        "create function workspace.f() returns int language plpgsql\n"
        "set search_path = workspace, pg_temp as $fn$\n"
        "begin\n"
        "  -- reads workspace.documents\n"
        "  execute $q$select 1 from workspace.documents$q$;\n"
        "  return (select count(*) from workspace.documents where note = 'it''s');\n"
        "end $fn$;\n"
        "do $$ begin perform workspace.f(); end $$;\n"
    )
    assert to_acme(written) == (
        "create function kb_acme.f() returns int language plpgsql\n"
        "set search_path = kb_acme, pg_temp as $fn$\n"
        "begin\n"
        "  -- reads workspace.documents\n"
        "  execute $q$select 1 from kb_acme.documents$q$;\n"
        "  return (select count(*) from kb_acme.documents where note = 'it''s');\n"
        "end $fn$;\n"
        "do $$ begin perform kb_acme.f(); end $$;\n"
    )


def test_escape_strings_and_dollar_parameters_do_not_confuse_the_scanner():
    written = "select E'it\\'s workspace.x', $1, a$b from workspace.t where p like '\\_a%';"
    assert to_acme(written) == (
        "select E'it\\'s kb_acme.x', $1, a$b from kb_acme.t where p like '\\_a%';"
    )


@pytest.mark.parametrize("written", ["select 'open", "select $a$ open", "/* open", 'select "open'])
def test_unclosed_quotes_are_refused(written):
    with pytest.raises(SchemaRewriteError):
        to_acme(written + " workspace.x")


@pytest.mark.parametrize("target", ["public", "pg_catalog", "Bad", "a;b", ""])
def test_refuses_a_bad_target(target):
    with pytest.raises(SchemaRewriteError):
        rewrite_schema("select 1;", target)


def test_a_target_that_contains_the_written_name_is_not_rewritten_twice():
    assert rewrite_schema("select workspace.f();", "workspace_2") == "select workspace_2.f();"


def test_there_are_files_to_check():
    assert len(SQL_FILES) > 30


@pytest.mark.parametrize("path", SQL_FILES, ids=IDS)
def test_default_schema_leaves_every_file_byte_identical(path):
    raw = path.read_bytes()
    assert rewrite_schema(raw.decode("utf-8"), "workspace").encode("utf-8") == raw


@pytest.mark.parametrize("path", SQL_FILES, ids=IDS)
def test_scanner_gives_every_file_back_unchanged(path):
    sql = path.read_text(encoding="utf-8")
    assert "".join(segment.text for segment in scan(sql)) == sql


@pytest.mark.parametrize("path", SQL_FILES, ids=IDS)
def test_every_file_can_be_renamed_and_renamed_back(path):
    sql = path.read_text(encoding="utf-8")
    renamed = to_acme(sql)
    assert rewrite_schema(renamed, "workspace", source="kb_acme") == sql


def _live(sql: str) -> str:
    """The SQL with every comment removed, function bodies included."""
    parts = []
    for segment in scan(sql):
        if segment.kind == "comment":
            continue
        parts.append(_live(segment.body) if segment.kind == "dollar" else segment.text)
    return "".join(parts)


@pytest.mark.parametrize("path", SQL_FILES, ids=IDS)
def test_no_reference_to_the_written_schema_survives_outside_comments(path):
    renamed = to_acme(path.read_text(encoding="utf-8"))
    assert re.search(r"(?<![A-Za-z0-9_$])workspace(?![A-Za-z0-9_$])", _live(renamed), re.I) is None


def test_a_non_ascii_dollar_tag_does_not_hide_what_follows():
    written = "comment on table workspace.a is $\u00e9$ /* $\u00e9$;\ncreate table workspace.b ();\n-- */\n"
    assert to_acme(written) == (
        "comment on table kb_acme.a is $\u00e9$ /* $\u00e9$;\ncreate table kb_acme.b ();\n-- */\n"
    )


def test_a_non_ascii_letter_is_part_of_a_name():
    written = "select \u00e9workspace.x, workspace\u00e9.y from workspace.t;"
    assert to_acme(written) == "select \u00e9workspace.x, workspace\u00e9.y from kb_acme.t;"
