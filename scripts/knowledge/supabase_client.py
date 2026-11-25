"""Supabase client construction for the knowledge pipeline.

Credentials are read from the workspace `.env` file via `dotenv_values`, which
returns them as a local mapping rather than exporting them into the process
environment. Values are never printed, logged, or included in error messages.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .config import WORKSPACE_ROOT
from .engine_config import ConfigurationError  # noqa: F401 - re-exported


def _read_env() -> dict[str, str | None]:
    env_path = WORKSPACE_ROOT / ".env"
    if not env_path.exists():
        raise ConfigurationError(f"No .env file found at {env_path}.")

    try:
        from knowledge.env_file import read as read_env_file
    except ImportError as error:
        raise ConfigurationError(
            "python-dotenv is not installed in this environment."
        ) from error

    return dict(read_env_file(env_path))


def get_supabase():
    """Build a service-role Supabase client.

    Ingest is a trusted writer and needs the service role. Retrieval does not and
    must go through `workspace.documents_search` with a token hash instead.
    """
    values = _read_env()

    url = values.get("SUPABASE_URL")
    key = values.get("SUPABASE_SERVICE_ROLE_KEY")

    missing = [
        name
        for name, value in (("SUPABASE_URL", url), ("SUPABASE_SERVICE_ROLE_KEY", key))
        if not value
    ]
    if missing:
        raise ConfigurationError(
            f"Missing required keys in .env: {', '.join(missing)}."
        )

    try:
        from supabase import create_client
    except ImportError as error:
        raise ConfigurationError(
            "The `supabase` package is not installed in this environment."
        ) from error

    return create_client(url, key)


def get_supabase_ingest():
    """Build a Supabase client authenticated as the `kb_ingest` role.

    `kb_ingest` holds write grants scoped to the ingest pipeline and nothing
    else (supabase/migrations/0023_kb_ingest_role.sql) -- pullers must never
    hold the service-role key, which can grant itself any access domain.
    """
    return _role_client("kb_ingest")


def _role_client(role: str):
    """Build a client that PostgREST runs as `role`, from the workspace env file."""
    return role_client_from(_read_env(), role)


def role_client_from(values, role: str):
    """Build a client that PostgREST runs as `role`, from a mapping of settings.

    Mints a PostgREST JWT (`role: <role>`, 1y expiry) signed with
    SUPABASE_JWT_SECRET, mirroring `engine/src/supabase.ts::mintKbEngineJwt`.

    Trap: the second positional arg to `create_client` becomes the gateway's
    `apikey` header, validated against known PROJECT keys -- a self-signed
    role JWT there always fails with "Invalid API key" no matter how it is
    signed. The role JWT goes in the `Authorization` bearer header instead;
    `apikey` stays the project anon key.
    """
    import jwt as pyjwt

    url = values.get("SUPABASE_URL")
    jwt_secret = values.get("SUPABASE_JWT_SECRET")
    anon_key = values.get("SUPABASE_ANON_KEY")

    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", url),
            ("SUPABASE_JWT_SECRET", jwt_secret),
            ("SUPABASE_ANON_KEY", anon_key),
        )
        if not value
    ]
    if missing:
        raise ConfigurationError(
            f"Missing required keys in .env: {', '.join(missing)}."
        )

    now = datetime.now(timezone.utc)
    token = pyjwt.encode(
        {
            "role": role,
            "iss": "supabase",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(days=365)).timestamp()),
        },
        jwt_secret,
        algorithm="HS256",
    )

    try:
        from supabase import create_client
        from supabase.client import ClientOptions
    except ImportError as error:
        raise ConfigurationError(
            "The `supabase` package is not installed in this environment."
        ) from error

    return create_client(
        url,
        anon_key,
        options=ClientOptions(
            headers={"Authorization": f"Bearer {token}"},
            auto_refresh_token=False,
            persist_session=False,
        ),
    )


def get_supabase_anon():
    """Build an ANON-key Supabase client, for reaching edge functions only.

    This client never touches `workspace` tables or RPCs directly -- it holds no
    row-level privilege at all. Per-request identity is carried in the
    `Authorization: Bearer <principal token>` header passed to
    `client.functions.invoke(...)`, never in this client's own credentials.
    """
    values = _read_env()

    url = values.get("SUPABASE_URL")
    key = values.get("SUPABASE_ANON_KEY")

    missing = [
        name
        for name, value in (("SUPABASE_URL", url), ("SUPABASE_ANON_KEY", key))
        if not value
    ]
    if missing:
        raise ConfigurationError(
            f"Missing required keys in .env: {', '.join(missing)}."
        )

    try:
        from supabase import create_client
    except ImportError as error:
        raise ConfigurationError(
            "The `supabase` package is not installed in this environment."
        ) from error

    return create_client(url, key)
