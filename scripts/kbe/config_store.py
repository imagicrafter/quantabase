"""Reading and applying the Engine config in the database.

Both ways in act as the `kb_ingest` role -- the same identity the pullers use
-- and call only the two functions that role is granted
(supabase/migrations/0029_engine_settings.sql):

    engine_config_get()
    engine_config_apply(config, hash)

in the Engine's schema (KB_SCHEMA; see schema.py).

  ApiStore  through the project's REST API with a short-lived kb_ingest JWT,
            exactly as the pullers connect. Needs SUPABASE_URL,
            SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET.
  DbStore   through KBE_DATABASE_URL with `set local role kb_ingest`. For a
            database with no REST API in front of it (local, CI), and for
            setup before the API keys are in hand. A login that may not take
            that role runs the two functions as itself, and says so.
"""

from __future__ import annotations

import json
import re
import secrets as stdlib_secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Protocol

from . import pg, proc, schema as kb, secrets
from .errors import KbeError, UsageError

INGEST_ROLE = "kb_ingest"
API_KEYS = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET")
_TOKEN_MINUTES = 5
_NO_SET_ROLE = "permission denied to set role"
_IDENTIFIER = re.compile(r"[a-z_][a-z0-9_]{0,62}")


class ConfigStore(Protocol):
    def describe(self) -> str: ...
    def get(self) -> Mapping[str, Any] | None: ...
    def apply(self, config: Mapping[str, Any], digest: str) -> Mapping[str, Any]: ...
    def call(self, function: str, args: Mapping[str, Any] | None = None) -> Any: ...


def _identifier(name: str) -> str:
    """A function or argument name that is safe to put into SQL text or a URL."""
    if not isinstance(name, str) or _IDENTIFIER.fullmatch(name) is None:
        raise KbeError(f"Not a usable database name: {name!r}.")
    return name


def _mint_ingest_jwt(jwt_secret: str) -> str:
    try:
        import jwt as pyjwt
    except ImportError as error:
        raise KbeError(
            "PyJWT is not installed. Run: pip install -r pullers/requirements.txt"
        ) from error
    now = datetime.now(timezone.utc)
    claims = {
        "role": INGEST_ROLE,
        "iss": "supabase",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=_TOKEN_MINUTES)).timestamp()),
    }
    return pyjwt.encode(claims, jwt_secret, algorithm="HS256")


def _default_post(url: str, headers: Mapping[str, str], body: Mapping[str, Any]):
    import requests

    return requests.post(url, headers=dict(headers), json=dict(body), timeout=30)


@dataclass(frozen=True)
class ApiStore:
    """The config functions over the REST API, as kb_ingest."""

    url: str
    anon_key: str = field(repr=False)
    jwt_secret: str = field(repr=False)
    post: Callable[..., Any] = _default_post
    schema: str = kb.DEFAULT_SCHEMA

    def describe(self) -> str:
        return f"the REST API as {INGEST_ROLE}"

    def _call(self, function: str, body: Mapping[str, Any]) -> Any:
        hidden = {"a": self.anon_key, "j": self.jwt_secret}
        headers = {
            # The gateway wants a project key here; the role token goes below.
            "apikey": self.anon_key,
            "Authorization": f"Bearer {_mint_ingest_jwt(self.jwt_secret)}",
            "Content-Profile": self.schema,
            "Content-Type": "application/json",
        }
        try:
            response = self.post(f"{self.url.rstrip('/')}/rest/v1/rpc/{function}", headers, body)
        except Exception as error:  # noqa: BLE001 - any transport failure
            raise KbeError(
                f"Could not reach the database API ({type(error).__name__}). "
                "Check SUPABASE_URL and your connection."
            ) from error
        if response.status_code >= 400:
            try:
                reason = str(response.json().get("message", ""))
            except (ValueError, AttributeError):
                reason = ""
            detail = secrets.redact(reason, hidden) or f"HTTP {response.status_code}"
            raise KbeError(f"The database refused {self.schema}.{function}: {detail}")
        # A function that returns void answers 2xx with no body (or 204). The
        # call succeeded; there is simply nothing to read.
        body = getattr(response, "text", None)
        if response.status_code == 204 or (isinstance(body, str) and not body.strip()):
            return None
        try:
            return response.json()
        except ValueError as error:
            raise KbeError(f"{self.schema}.{function} returned something unreadable.") from error

    def call(self, function: str, args: Mapping[str, Any] | None = None) -> Any:
        """Run one function in the Engine's schema and return what it returns."""
        named = {_identifier(key): value for key, value in (args or {}).items()}
        return self._call(_identifier(function), named)

    def get(self) -> Mapping[str, Any] | None:
        found = self._call("engine_config_get", {})
        return found if isinstance(found, Mapping) and found else None

    def apply(self, config: Mapping[str, Any], digest: str) -> Mapping[str, Any]:
        result = self._call("engine_config_apply", {"p_config": config, "p_hash": digest})
        return result if isinstance(result, Mapping) else {}


def _dollar_quote(text: str) -> str:
    """Dollar-quote JSON with a tag that cannot appear inside it."""
    for _ in range(5):
        tag = f"$kbe_{stdlib_secrets.token_hex(8)}$"
        if tag not in text:
            return f"{tag}{text}{tag}"
    raise KbeError("Could not quote the config for the database.")


def _sql_value(value: Any) -> str:
    """One function argument as SQL text."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (Mapping, list, tuple)):
        return f"{_dollar_quote(json.dumps(value, ensure_ascii=False))}::jsonb"
    if isinstance(value, str):
        return pg.quote_literal(value)
    raise KbeError(f"A {type(value).__name__} cannot be sent to a database function.")


@dataclass(frozen=True)
class DbStore:
    """The config functions over a direct connection, as kb_ingest.

    `role=None` runs as the login itself, for the functions only the service's
    role is granted (the people commands): the login owns the database.
    """

    psql: pg.Psql
    schema: str = kb.DEFAULT_SCHEMA
    role: str | None = INGEST_ROLE

    def __post_init__(self) -> None:
        # The name goes into SQL text; never build one from an unchecked value.
        pg.tracking_table(self.schema)

    def _run(self, statement: str) -> proc.ProcResult:
        """As kb_ingest; if this login may not become it, as the login itself.

        The fallback is for a login that owns the database but was never made
        a member of kb_ingest (a local or CI Postgres). It can already do
        everything kb_ingest can, so nothing is widened.
        """
        if self.role is None:
            return self.psql.script(statement, tuples=True)
        as_role = self.psql.script(f"set local role {self.role};\n{statement}", tuples=True)
        if as_role.ok or _NO_SET_ROLE not in as_role.stderr:
            return as_role
        return self.psql.script(statement, tuples=True)

    def describe(self) -> str:
        if self.role is None:
            return "a direct database connection as its own login"
        probe = self.psql.script(f"set local role {INGEST_ROLE};\nselect 1;", tuples=True)
        if probe.ok:
            return f"a direct database connection as {INGEST_ROLE}"
        if _NO_SET_ROLE in probe.stderr:
            return (
                "a direct database connection as its own login "
                f"(this login may not act as {INGEST_ROLE})"
            )
        raise KbeError(f"Could not reach the database:\n{probe.stderr}")

    def _json(self, statement: str, what: str) -> Any:
        result = self._run(statement)
        if not result.ok:
            raise KbeError(f"The database refused {self.schema}.{what}:\n{result.stderr}")
        text = result.stdout.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError as error:
            raise KbeError(f"{self.schema}.{what} returned something unreadable.") from error

    def call(self, function: str, args: Mapping[str, Any] | None = None) -> Any:
        """Run one function in the Engine's schema and return what it returns."""
        name = _identifier(function)
        named = ", ".join(
            f"{_identifier(key)} => {_sql_value(value)}" for key, value in (args or {}).items()
        )
        return self._json(f"select {self.schema}.{name}({named});", name)

    def get(self) -> Mapping[str, Any] | None:
        found = self._json(f"select {self.schema}.engine_config_get();", "engine_config_get")
        return found if isinstance(found, Mapping) and found else None

    def apply(self, config: Mapping[str, Any], digest: str) -> Mapping[str, Any]:
        payload = _dollar_quote(json.dumps(config, ensure_ascii=False))
        statement = (
            f"select {self.schema}.engine_config_apply({payload}::jsonb, "
            f"{pg.quote_literal(digest)});"
        )
        result = self._json(statement, "engine_config_apply")
        return result if isinstance(result, Mapping) else {}


def choose(values: Mapping[str, str], via: str, runner: proc.Runner = proc.run) -> ConfigStore:
    """`api`, `db`, or `auto`: the API when its three keys are set, else the URL."""
    has_api = all(values.get(key) for key in API_KEYS)
    name = kb.chosen(values)
    if via not in ("auto", "api", "db"):
        raise UsageError("--via must be auto, api or db.")
    if via == "api" or (via == "auto" and has_api):
        found = secrets.require(values, *API_KEYS)
        return ApiStore(
            url=found["SUPABASE_URL"],
            anon_key=found["SUPABASE_ANON_KEY"],
            jwt_secret=found["SUPABASE_JWT_SECRET"],
            schema=name,
        )
    if via == "auto" and not values.get(pg.DATABASE_URL_KEY):
        raise KbeError(
            "No way to reach the database. Set SUPABASE_URL, SUPABASE_ANON_KEY and "
            f"SUPABASE_JWT_SECRET, or {pg.DATABASE_URL_KEY}, in your local env file."
        )
    return DbStore(pg.connect(values, runner), name)
