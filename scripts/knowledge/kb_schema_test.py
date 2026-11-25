"""KB_SCHEMA: one validated setting names the Postgres schema everywhere."""

from __future__ import annotations

import pytest

from knowledge import kb_schema


@pytest.mark.parametrize("name", ["workspace", "kb_acme", "_x", "a", "a" * 63, "kb2"])
def test_accepts_plain_identifiers(name):
    assert kb_schema.validate(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "", " ", "Workspace", "kb-acme", "1kb", "kb acme", "a" * 64, "kb;drop", 'kb"x',
        "kb.x", "kb$", " workspace", "workspace\n",
    ],
)
def test_rejects_anything_that_is_not_a_plain_identifier(name):
    with pytest.raises(kb_schema.SchemaNameError):
        kb_schema.validate(name)


@pytest.mark.parametrize(
    "name",
    [
        "public", "auth", "storage", "extensions", "graphql", "graphql_public", "realtime",
        "vault", "pgsodium", "supabase_migrations", "information_schema", "pg_catalog",
        "pg_temp", "pg_anything",
    ],
)
def test_rejects_reserved_schemas(name):
    with pytest.raises(kb_schema.SchemaNameError):
        kb_schema.validate(name)


def test_non_string_is_rejected():
    with pytest.raises(kb_schema.SchemaNameError):
        kb_schema.validate(None)  # type: ignore[arg-type]


def test_resolve_defaults_to_workspace():
    assert kb_schema.resolve({}, {}) == "workspace"


def test_resolve_reads_the_env_file_value():
    assert kb_schema.resolve({"KB_SCHEMA": "kb_acme"}, {}) == "kb_acme"


def test_resolve_reads_the_process_value():
    assert kb_schema.resolve({}, {"KB_SCHEMA": "kb_acme"}) == "kb_acme"


def test_resolve_refuses_two_different_values():
    with pytest.raises(kb_schema.SchemaNameError, match="two different"):
        kb_schema.resolve({"KB_SCHEMA": "kb_a"}, {"KB_SCHEMA": "kb_b"})


def test_resolve_never_falls_back_on_a_bad_value():
    with pytest.raises(kb_schema.SchemaNameError):
        kb_schema.resolve({"KB_SCHEMA": "public"}, {})
    with pytest.raises(kb_schema.SchemaNameError):
        kb_schema.resolve({}, {"KB_SCHEMA": "Bad Name"})


def test_empty_value_means_unset():
    assert kb_schema.resolve({"KB_SCHEMA": ""}, {"KB_SCHEMA": ""}) == "workspace"


class _Client:
    def __init__(self):
        self.seen = []

    def schema(self, name):
        self.seen.append(name)
        return ("scoped", name)


def test_db_scopes_a_client_to_the_configured_schema(monkeypatch):
    monkeypatch.setattr(kb_schema, "schema_name", lambda: "kb_acme")
    client = _Client()
    assert kb_schema.db(client) == ("scoped", "kb_acme")
    assert client.seen == ["kb_acme"]


def test_qualified_names_use_the_configured_schema(monkeypatch):
    monkeypatch.setattr(kb_schema, "schema_name", lambda: "kb_acme")
    assert kb_schema.qualified("documents") == "kb_acme.documents"


@pytest.mark.parametrize("name", ["user", "table", "select", "order", "group", "default", "end"])
def test_rejects_sql_reserved_words(name):
    with pytest.raises(kb_schema.SchemaNameError, match="reserved word"):
        kb_schema.validate(name)


@pytest.mark.parametrize("name", ["users", "kb_user", "workspace", "knowledge", "_user"])
def test_a_name_that_only_contains_a_reserved_word_is_fine(name):
    assert kb_schema.validate(name) == name


def _ts_set(path, constant):
    """The string members of `new Set([...])` assigned to `constant` in a TS file."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    text = (root / path).read_text(encoding="utf-8")
    body = re.search(rf"{constant}[^=]*=\s*new Set\(\[(.*?)\]\)", text, re.S).group(1)
    return frozenset(re.findall(r'"([a-z_]+)"', body))


def test_the_three_copies_of_the_rule_hold_the_same_names():
    service = "engine/src/kb-schema.ts"
    function = "supabase/functions/embed/index.ts"
    assert _ts_set(service, "SQL_RESERVED_WORDS") == kb_schema.SQL_RESERVED_WORDS
    assert _ts_set(function, "KB_SCHEMA_SQL_RESERVED_WORDS") == kb_schema.SQL_RESERVED_WORDS
    assert _ts_set(service, "RESERVED") == kb_schema._RESERVED
    assert _ts_set(function, "KB_SCHEMA_RESERVED") == kb_schema._RESERVED
