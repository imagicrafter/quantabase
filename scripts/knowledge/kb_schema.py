"""The one place that knows which Postgres schema holds the knowledge index.

A deployment picks its schema with `KB_SCHEMA` (default `workspace`). It is
read from the same local env file as the other settings, or from the process
environment (how a hosted job or a test passes it). The name is validated
before anything uses it: a bad value stops the program, it is never replaced
by the default.

Product code never writes the schema name. It calls:

    db(client)            the client scoped to the schema
    qualified("table")    "<schema>.table", for messages
    schema_name()         the bare name
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

SCHEMA_ENV_VAR = "KB_SCHEMA"
DEFAULT_SCHEMA = "workspace"
_NAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")
_RESERVED = frozenset(
    {
        "public", "auth", "storage", "extensions", "graphql", "graphql_public", "realtime",
        "vault", "pgsodium", "supabase_migrations", "information_schema",
    }
)
_RESERVED_PREFIX = "pg_"
# PostgreSQL's reserved key words (the "reserved" and "reserved, can be
# function or type" rows of the SQL key words table). One of these as a schema
# name would have to be quoted everywhere, and this code writes the name
# unquoted. A fixed list, the same in engine/src/kb-schema.ts and the embed
# function; a test compares the three.
SQL_RESERVED_WORDS = frozenset(
    {
        "all", "analyse", "analyze", "and", "any", "array", "as", "asc",
        "asymmetric", "authorization", "binary", "both", "case", "cast", "check", "collate",
        "collation", "column", "concurrently", "constraint", "create", "cross", "current_catalog", "current_date",
        "current_role", "current_schema", "current_time", "current_timestamp", "current_user", "default", "deferrable", "desc",
        "distinct", "do", "else", "end", "except", "false", "fetch", "for",
        "foreign", "freeze", "from", "full", "grant", "group", "having", "ilike",
        "in", "initially", "inner", "intersect", "into", "is", "isnull", "join",
        "lateral", "leading", "left", "like", "limit", "localtime", "localtimestamp", "natural",
        "not", "notnull", "null", "offset", "on", "only", "or", "order",
        "outer", "overlaps", "placing", "primary", "references", "returning", "right", "select",
        "session_user", "similar", "some", "symmetric", "system_user", "table", "tablesample", "then",
        "to", "trailing", "true", "union", "unique", "user", "using", "variadic",
        "verbose", "when", "where", "window", "with",
    }
)
_ENV_FILE = Path(__file__).resolve().parent.parent.parent / ".env"


class SchemaNameError(ValueError):
    """KB_SCHEMA is not a name this program will use."""


def validate(name: str) -> str:
    """`name` if it is a usable schema name; raises otherwise."""
    if not isinstance(name, str) or _NAME.fullmatch(name) is None:
        raise SchemaNameError(
            f"{SCHEMA_ENV_VAR} must be 1-63 characters: lowercase letters, digits and "
            "underscores, not starting with a digit."
        )
    if name in _RESERVED or name.startswith(_RESERVED_PREFIX):
        raise SchemaNameError(
            f'{SCHEMA_ENV_VAR} cannot be "{name}": that schema belongs to Postgres or Supabase.'
        )
    if name in SQL_RESERVED_WORDS:
        raise SchemaNameError(
            f'{SCHEMA_ENV_VAR} cannot be "{name}": that is a reserved word in SQL.'
        )
    return name


def resolve(file_values: Mapping[str, Any], process_values: Mapping[str, Any]) -> str:
    """The schema named by the env file and/or the process environment."""
    from_file = file_values.get(SCHEMA_ENV_VAR) or ""
    from_process = process_values.get(SCHEMA_ENV_VAR) or ""
    if from_file and from_process and from_file != from_process:
        raise SchemaNameError(
            f"{SCHEMA_ENV_VAR} is set to two different values (the local env file and "
            "the process environment). Make them the same or remove one."
        )
    return validate(from_file or from_process or DEFAULT_SCHEMA)


def _file_values(path: Path) -> Mapping[str, Any]:
    if not path.is_file():
        return {}
    from knowledge.env_file import read as read_env_file

    return dict(read_env_file(path))


@lru_cache(maxsize=1)
def schema_name() -> str:
    """The configured schema. Read once per process."""
    return resolve(_file_values(_ENV_FILE), os.environ)


def db(client: Any) -> Any:
    """`client`, scoped to the configured schema."""
    return client.schema(schema_name())


def qualified(name: str) -> str:
    """`<schema>.<name>`, for messages shown to a person."""
    return f"{schema_name()}.{name}"
