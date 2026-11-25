"""A database client that acts as `kb_ingest`, built from the local env file.

    client(secrets.load(ctx.env_file))

Both the credentials and the schema come from the SAME mapping, so
`--env-file` decides everything. Shared code scopes a client with
`knowledge.kb_schema.db(client)`, which reads the repo's own env file; the
wrapper returned here ignores the name it is asked for and always answers
with the schema this env file chose.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from . import schema as kb, secrets
from .errors import KbeError

INGEST_ROLE = "kb_ingest"
API_KEYS = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET")


@dataclass(frozen=True)
class SchemaPinned:
    """A client whose `.schema()` always returns one fixed schema."""

    inner: Any = field(repr=False)
    schema_name: str = kb.DEFAULT_SCHEMA

    def schema(self, _name: str | None = None) -> Any:
        return self.inner.schema(self.schema_name)


def _build(values: Mapping[str, str], role: str) -> Any:
    from knowledge.supabase_client import role_client_from

    return role_client_from(values, role)


def client(
    values: Mapping[str, str], build: Callable[[Mapping[str, str], str], Any] | None = None
) -> SchemaPinned:
    """The kb_ingest client for the project and schema this env file names."""
    found = secrets.require(values, *API_KEYS)
    name = kb.chosen(values)
    try:
        inner = (build or _build)(found, INGEST_ROLE)
    except KbeError:
        raise
    except Exception as error:  # noqa: BLE001 - never echo a credential
        raise KbeError(
            f"Could not build the database client ({type(error).__name__}). "
            "Check SUPABASE_URL and the keys next to it in your local env file."
        ) from error
    return SchemaPinned(inner=inner, schema_name=name)
