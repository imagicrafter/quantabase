"""`kbe db expose-schema` -- let the project's REST API serve the schema.

A Supabase project only answers REST calls for the schemas on its "exposed
schemas" list. The service and the jobs reach the database through that API,
so the chosen schema (KB_SCHEMA) has to be on the list.

    kbe db expose-schema [--project-ref REF] [--dry-run]
    kbe db expose-schema --check

With SUPABASE_ACCESS_TOKEN in the local env file this reads the project's
API settings, adds the schema (never removing one that is there), and writes
them back. Without it, it prints the dashboard steps. `--check` asks the REST
API for the stored config under the schema and fails if it is not served.
"""

from __future__ import annotations

import argparse
from typing import Any, Callable, Mapping

from . import config_store, schema, secrets, state
from .context import Context
from .errors import KbeError

TOKEN_KEY = "SUPABASE_ACCESS_TOKEN"
API_URL = "https://api.supabase.com/v1/projects/{ref}/postgrest"
SETTING = "db_schema"
_TIMEOUT_SECONDS = 30

Request = Callable[[str, str, Mapping[str, str], Mapping[str, Any] | None], Any]
ProjectRef = Callable[[str | None, Mapping, Mapping[str, str]], str]


def _default_request(
    method: str, url: str, headers: Mapping[str, str], body: Mapping[str, Any] | None
) -> Any:
    import requests

    return requests.request(
        method, url, headers=dict(headers), json=None if body is None else dict(body),
        timeout=_TIMEOUT_SECONDS,
    )


# Tests replace this; nothing here calls the real API in a test run.
request: Request = _default_request


def parse_schemas(current: str) -> tuple[str, ...]:
    """The list as the API returns it (`public, graphql_public`) -> names."""
    return tuple(name.strip() for name in current.split(",") if name.strip())


def with_schema(current: str, name: str) -> str | None:
    """The list with `name` added at the end, or None when it is there already."""
    listed = parse_schemas(current)
    if name in listed:
        return None
    return ",".join((*listed, name))


def dashboard_steps(name: str, ref: str | None) -> list[str]:
    where = (
        f"https://supabase.com/dashboard/project/{ref}/settings/api" if ref
        else "your project in the Supabase dashboard"
    )
    return [
        f'To let the REST API serve the schema "{name}":',
        f"  1. Open {where}",
        "  2. Go to Project Settings, then Data API.",
        f'  3. Under "Exposed schemas", add {name}. Leave the others as they are.',
        "  4. Save.",
        "Then run: python -m kbe db expose-schema --check",
    ]


def _call(method: str, ref: str, token: str, body: Mapping[str, Any] | None) -> Mapping[str, Any]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        response = request(method, API_URL.format(ref=ref), headers, body)
    except Exception as error:  # noqa: BLE001 - any transport failure
        raise KbeError(
            f"Could not reach the Supabase Management API ({type(error).__name__})."
        ) from error
    if response.status_code >= 400:
        raise KbeError(
            f"The Supabase Management API refused the request (HTTP {response.status_code}). "
            f"Check {TOKEN_KEY} and the project ref."
        )
    try:
        found = response.json()
    except ValueError as error:
        raise KbeError("The Supabase Management API returned something unreadable.") from error
    if not isinstance(found, Mapping) or not isinstance(found.get(SETTING), str):
        raise KbeError(f"The Supabase Management API returned no {SETTING} setting.")
    return found


def expose(name: str, ref: str, token: str, out: Callable[[str], None], dry_run: bool) -> int:
    """Add `name` to the project's exposed schemas through the Management API."""
    current = _call("GET", ref, token, None)[SETTING]
    wanted = with_schema(current, name)
    if wanted is None:
        out(f'The schema "{name}" is already exposed ({current}).')
        return 0
    if dry_run:
        out(f"would change the exposed schemas from [{current}] to [{wanted}]")
        return 0
    saved = _call("PATCH", ref, token, {SETTING: wanted})[SETTING]
    missing = [item for item in parse_schemas(wanted) if item not in parse_schemas(saved)]
    if missing:
        raise KbeError(
            f"The project did not keep the change: {', '.join(missing)} not in [{saved}]."
        )
    out(f"Exposed schemas are now [{saved}].")
    return 0


def check(values: Mapping[str, str], name: str, out: Callable[[str], None]) -> int:
    """Read the stored config through the REST API under `name`."""
    found = secrets.require(values, *config_store.API_KEYS)
    store = config_store.ApiStore(
        url=found["SUPABASE_URL"], anon_key=found["SUPABASE_ANON_KEY"],
        jwt_secret=found["SUPABASE_JWT_SECRET"], schema=name,
        post=config_store._default_post,  # looked up now, so a test can replace it
    )
    try:
        store.get()
    except KbeError as error:
        raise KbeError(
            f'The REST API did not answer for the schema "{name}". If it says the '
            "schema must be one of a list, run `kbe db expose-schema`. "
            f"{error}"
        ) from error
    out(f'The schema "{name}" is served by the REST API.')
    return 0


def _run(args: argparse.Namespace, ctx: Context, project_ref: ProjectRef) -> int:
    values = secrets.load_optional(ctx.env_file)
    name = schema.chosen(values)
    if args.check:
        return check(values, name, ctx.out)
    token = values.get(TOKEN_KEY)
    if not token:
        try:
            ref: str | None = project_ref(args.project_ref, state.load(ctx.state_file), values)
        except KbeError:
            ref = None
        for line in dashboard_steps(name, ref):
            ctx.out(line)
        return 0
    ref = project_ref(args.project_ref, state.load(ctx.state_file), values)
    return expose(name, ref, token, ctx.out, args.dry_run)


def register(commands: argparse._SubParsersAction, project_ref: ProjectRef) -> None:
    parser = commands.add_parser(
        "expose-schema",
        help="let the project's REST API serve the Engine's schema",
        description="Add the Engine's schema (KB_SCHEMA in your local env file) to "
        "the project's exposed schemas, keeping every schema already listed. Uses "
        f"the Supabase Management API when {TOKEN_KEY} is set; otherwise prints "
        "the dashboard steps.",
    )
    parser.add_argument("--project-ref", metavar="REF", help="Supabase project ref")
    parser.add_argument("--dry-run", action="store_true",
                        help="show the change; write nothing")
    parser.add_argument("--check", action="store_true",
                        help="only test that the REST API serves the schema")
    parser.set_defaults(func=lambda args, ctx: _run(args, ctx, project_ref))
