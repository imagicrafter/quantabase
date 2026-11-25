"""`kbe tokens mint` -- a new bearer token for one principal, never printed.

    kbe tokens mint (--embed | --handle HANDLE | --email EMAIL)
                    [--write-env] [--clipboard | --out FILE] [--dry-run] [--yes]

The token is made here. Only its SHA-256 goes to the database (over the
direct connection, KBE_DATABASE_URL); the token itself goes where you say and
nowhere else:

    --write-env   into the local env file, as KNOWLEDGE_TOKEN_<HANDLE>
                  (and KNOWLEDGE_EMBED_TOKEN for --embed)
    --clipboard   onto the clipboard, to paste into the hosting dashboard
    --out FILE    into a new file only its owner can read

At least one is required; there is no flag that prints it. Minting REPLACES
the principal's token: the old one stops working everywhere it was pasted.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import secrets as stdlib_secrets
from pathlib import Path
from typing import Mapping

from knowledge.mint_token import env_key

from . import pg, schema as kb, secret_out, secrets
from .context import Context
from .errors import KbeError, UsageError

EMBED_HANDLE = "kb-engine"
EMBED_ENV_NAME = "KNOWLEDGE_EMBED_TOKEN"
_TOKEN_BYTES = 32
_HANDLE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,62}")
_EMAIL = re.compile(r"[^@\s']+@[^@\s']+\.[^@\s']+")


def token_hash(token: str) -> str:
    """Hex SHA-256 of the token: what the database stores and compares."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def env_name(handle: str) -> str:
    """The env-file name a principal's token is kept under (one rule, shared)."""
    return env_key(handle)


def _who(args: argparse.Namespace) -> tuple[str, str]:
    """(column, value) naming the principal, checked before it reaches SQL."""
    if args.embed:
        return "handle", EMBED_HANDLE
    if args.handle:
        if _HANDLE.fullmatch(args.handle) is None:
            raise UsageError("--handle must be letters, digits, '.', '_' or '-'.")
        return "handle", args.handle
    email = (args.email or "").strip().lower()
    if _EMAIL.fullmatch(email) is None:
        raise UsageError("--email must be an email address.")
    return "email", email


def _find(psql: pg.Psql, schema: str, column: str, value: str) -> tuple[str, str]:
    """The active principal's (handle, role). Raises when there is none."""
    match = "handle =" if column == "handle" else "lower(email) ="
    rows = psql.rows(
        f"select handle, role from {schema}.principals "
        f"where {match} {pg.quote_literal(value)} and active;"
    )
    if len(rows) != 1:
        raise KbeError(
            f"No active person or service has that {column}. See: python -m kbe people list"
        )
    return rows[0][0], rows[0][1]


def write_env(path: Path, values: Mapping[str, str]) -> None:
    """Set NAME=value lines in the env file, keeping every other line as it is."""
    try:
        existing = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    except OSError as error:
        raise KbeError(f"Could not read {path}: {error.strerror}.") from error
    prefixes = tuple(f"{name}=" for name in values)
    kept = [line for line in existing if not line.startswith(prefixes)]
    text = "\n".join([*kept, *(f"{name}={value}" for name, value in values.items())]) + "\n"
    _replace_owner_only(path, text)


def _replace_owner_only(path: Path, text: str) -> None:
    """Put `text` at `path` in one step, readable by its owner only.

    The text is written to a new 0600 file beside `path`, which then takes
    its place. So the file is never half-written, a file other people could
    read becomes owner-only, and a link at `path` is replaced, not followed.
    """
    part = path.with_name(f".{path.name}.{stdlib_secrets.token_hex(6)}.part")
    try:
        descriptor = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(part, path)
    except OSError as error:
        try:
            part.unlink()
        except OSError:
            pass
        raise KbeError(f"Could not write {path}: {error.strerror}.") from error


def _delivery(args: argparse.Namespace) -> secret_out.Delivery | None:
    if args.clipboard or args.out:
        return secret_out.choose(args, what="token")
    if not args.write_env:
        raise UsageError(
            "Say where the token should go: --write-env (the local env file), "
            "--clipboard, or --out FILE. It is never printed."
        )
    return None


def _store_hash(psql: pg.Psql, schema: str, handle: str, token: str) -> None:
    done = psql.script(
        f"update {schema}.principals set token_hash = {pg.quote_literal(token_hash(token))} "
        f"where handle = {pg.quote_literal(handle)} and active;"
    )
    if not done.ok:
        raise KbeError(f"The token could not be stored:\n{done.stderr}")


def _hand_over(args, ctx: Context, delivery, handle: str, token: str) -> None:
    names = [env_name(handle), *([EMBED_ENV_NAME] if handle == EMBED_HANDLE else [])]
    if args.write_env:
        write_env(ctx.env_file, {name: token for name in names})
        ctx.out(f"Written to your local env file as {', '.join(names)}.")
    if delivery is not None:
        for line in delivery.send(ctx, {names[-1]: token}):
            ctx.out(line)


def _cmd_mint(args: argparse.Namespace, ctx: Context) -> int:
    column, value = _who(args)
    delivery = _delivery(args)
    values = secrets.load(ctx.env_file)
    psql, schema = pg.connect(values, ctx.runner), kb.chosen(values)
    handle, role = _find(psql, schema, column, value)
    ctx.out(f"A new token for {handle} ({role}). Its current token, if any, stops working.")
    if args.dry_run:
        ctx.out("Dry run: nothing was changed.")
        return 0
    if not args.yes and not ctx.confirm(f"Replace the token of {handle}?"):
        raise KbeError("Not changed. Re-run with --yes to go ahead without being asked.")
    token = stdlib_secrets.token_urlsafe(_TOKEN_BYTES)
    _store_hash(psql, schema, handle, token)
    try:
        _hand_over(args, ctx, delivery, handle, token)
    except KbeError as error:
        raise KbeError(
            f"{error} The new token was stored but could not be handed over; run the "
            "command again for another."
        ) from error
    if handle == EMBED_HANDLE:
        ctx.out("The same value is EMBED_TOKEN on the service and KNOWLEDGE_EMBED_TOKEN "
                "on every job in the hosting dashboard.")
    return 0


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "tokens",
        help="make a new token for a person or the service, without printing it",
        description="Bearer tokens for the token path: the service's embed token and a "
        "person's own token for local search and checks. A token is never printed.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    mint = commands.add_parser(
        "mint",
        help="replace one principal's token",
        description="Makes a new random token, stores only its SHA-256 in the database "
        "(needs KBE_DATABASE_URL), and puts the token where you say: --write-env, "
        "--clipboard or --out FILE. There is no way to print it. The old token of that "
        "principal stops working.",
    )
    who = mint.add_mutually_exclusive_group(required=True)
    who.add_argument("--embed", action="store_true",
                     help=f"the service's embed-only principal ({EMBED_HANDLE})")
    who.add_argument("--handle", help="a principal's handle (see `kbe people list --json`)")
    who.add_argument("--email", help="a person's sign-in address")
    mint.add_argument("--write-env", action="store_true",
                      help="write the token into the local env file")
    secret_out.add_flags(mint, what="token", show=False)
    mint.add_argument("--dry-run", action="store_true", help="say what would happen only")
    mint.add_argument("--yes", action="store_true", help="go ahead without asking")
    mint.set_defaults(func=_cmd_mint)
