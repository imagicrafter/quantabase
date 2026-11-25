"""Which schema a `kbe` command works on.

One setting, KB_SCHEMA, in the local env file (or the process environment).
`kbe db migrate --schema` may name it for a first run, but never disagree
with a value that is already set: the service and the jobs read KB_SCHEMA,
so a database built under another name would simply look empty to them.
"""

from __future__ import annotations

import os
from typing import Mapping

from knowledge.kb_schema import (  # noqa: F401 - re-exported for the commands
    DEFAULT_SCHEMA,
    SCHEMA_ENV_VAR,
    SchemaNameError,
    resolve,
    validate,
)

from .errors import KbeError, UsageError


def chosen(values: Mapping[str, str], explicit: str | None = None) -> str:
    """The validated schema name for this run. Never falls back on a bad value."""
    try:
        configured = resolve(values, os.environ)
        if explicit is None:
            return configured
        asked = validate(explicit)
    except SchemaNameError as error:
        raise UsageError(str(error)) from error
    is_set = bool(values.get(SCHEMA_ENV_VAR) or os.environ.get(SCHEMA_ENV_VAR))
    if is_set and asked != configured:
        raise KbeError(
            f"--schema {asked} disagrees with {SCHEMA_ENV_VAR}={configured}. The service "
            f"and the jobs use {SCHEMA_ENV_VAR}; change it there instead."
        )
    return asked
