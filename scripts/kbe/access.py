"""`kbe access` -- the one-time setup code and the sign-in settings.

    kbe access init    (--clipboard | --out FILE | --show) [--dry-run] [--yes]
    kbe access reopen  (--clipboard | --out FILE | --show) [--dry-run] [--yes]
    kbe access status  [--json] [--via auto|api|db]
    kbe access adopt   --team-domain URL --aud AUD --host HOST
                       [--status-aud AUD] [--level owner|people|domain]
                       [--dry-run] [--yes] [--via auto|api|db]
    kbe access setup   (access_setup.py: sign-in set up with one command)

`setup` is the usual way: it makes the code, sets it on the app and uses it
itself, so nobody handles it. `init` and `reopen` are for the setup page in a
browser, where a person types the code.

THE SETUP CODE. `init` and `reopen` make a long random code and store only
its hash (lower-case hex SHA-256 of the UTF-8 code -- the form
engine_setup_reopen() takes and the setup page checks against). The code is
handed over once, for the human to save as the app secret SETUP_CODE: to the
clipboard (--clipboard), to a new owner-only file (--out FILE), or printed
(--show, for a person in their own terminal). With none of the three the
command refuses before it changes anything. The code is never written to the
state file or a log.

The sign-in settings are not secret (a team domain, application AUD tags, a
hostname, the chosen level). `adopt` stores them for a deployment whose
Cloudflare applications were made by hand.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets as stdlib_secrets
from typing import Any, Mapping

from . import config_store, secret_out, secrets, state
from .context import Context
from .errors import KbeError, UsageError

PHASE = "access_setup"
LEVELS = ("owner", "people", "domain")
SECRET_NAME = "SETUP_CODE"
_CODE_BYTES = 32
_TEAM_DOMAIN = re.compile(r"https://[a-z0-9-]+\.cloudflareaccess\.com/?")
_HOSTNAME = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")
_AUD = re.compile(r"[A-Za-z0-9_-]{8,128}")
_SHOWN = ("team_domain", "host", "resource_url", "level")
_MISSING_FUNCTION = ("does not exist", "Could not find the function")


def new_code() -> str:
    """A fresh setup code: 43 URL-safe characters from 32 random bytes."""
    return stdlib_secrets.token_urlsafe(_CODE_BYTES)


def code_hash(code: str) -> str:
    """What the database stores: hex SHA-256 of the UTF-8 code."""
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _store(args: argparse.Namespace, ctx: Context) -> config_store.ConfigStore:
    return config_store.choose(secrets.load(ctx.env_file), args.via, ctx.runner)


def read_status(store: config_store.ConfigStore) -> Mapping[str, Any]:
    """Where setup stands. Raises with what to do when the database is too old."""
    try:
        found = store.call("engine_access_status")
    except KbeError as error:
        if any(text in str(error) for text in _MISSING_FUNCTION):
            raise KbeError(
                "This database does not have the access functions yet. "
                "Run: python -m kbe db migrate"
            ) from error
        raise
    if not isinstance(found, Mapping):
        raise KbeError(
            "The database has no Engine settings yet. Run: python -m kbe db migrate"
        )
    return found


def has_sign_in(status: Mapping[str, Any]) -> bool:
    access = status.get("access")
    return isinstance(access, Mapping) and all(
        access.get(key) for key in ("team_domain", "aud", "host")
    )


def _where_to_open(ctx: Context, reopened: bool) -> list[str]:
    """Which address the setup page must be opened on."""
    answers = state.load(ctx.state_file)
    own = state.answer(answers, "do_default_hostname") or "<the app's own address>"
    if not reopened:
        return [
            f"2. Open https://{own}/setup -- exactly that address, the app's own, not your "
            "hostname (the page points your hostname at the address it was opened on) -- "
            "and enter the same code there.",
        ]
    host = state.answer(answers, "engine_host") or "<your hostname>"
    return [
        f"2. Open https://{host}/setup (it is behind sign-in now) and enter the same code. "
        f"Where the page asks for the app's own address, give: {own}",
    ]


def _steps(ctx: Context, reopened: bool) -> list[str]:
    """What to do with the code. Holds no secret."""
    return [
        f"1. In the DigitalOcean dashboard, open the app's service and set the secret "
        f"{SECRET_NAME} to this code (Encrypt), then let the app redeploy.",
        *_where_to_open(ctx, reopened),
        f"3. When setup is complete, remove {SECRET_NAME} from the app.",
        "Do not paste the code into a chat or a ticket. If it is lost, or the "
        "page is locked after wrong codes, run: python -m kbe access reopen",
    ]


def _show_code(ctx: Context, code: str) -> None:
    """The one place the setup code is ever printed, and only with --show."""
    for line in (
        "",
        "Setup code (shown once -- it is not saved anywhere on this machine):",
        "",
        f"    {code}",
        "",
    ):
        ctx.out(line)


def _open_setup(
    args: argparse.Namespace, ctx: Context, question: str, reopened: bool = False
) -> int:
    store = _store(args, ctx)
    ctx.out(f"Using {store.describe()}.")
    if args.dry_run:
        ctx.out("Dry run: a new setup code would be made and its hash stored. Nothing was changed.")
        return 0
    delivery = secret_out.choose(args, what="setup code")
    if not args.yes and not ctx.confirm(question):
        raise KbeError("Not changed. Re-run with --yes to go ahead without being asked.")
    code = new_code()
    store.call("engine_setup_reopen", {"p_code_hash": code_hash(code)})
    current = state.load(ctx.state_file)
    state.save(ctx.state_file, state.with_phase(current, PHASE, "pending"))
    try:
        sent = delivery.send(ctx, {SECRET_NAME: code}, show=lambda c: _show_code(c, code))
    except KbeError as error:
        raise KbeError(
            f"{error} The new code was stored but could not be handed over; "
            "run: python -m kbe access reopen"
        ) from error
    for line in (*sent, *_steps(ctx, reopened)):
        ctx.out(line)
    return 0


def _cmd_init(args: argparse.Namespace, ctx: Context) -> int:
    status = read_status(_store(args, ctx))
    if status.get("setup_state") == "complete" or has_sign_in(status):
        raise KbeError(
            "Sign-in is already set up for this Engine. To run setup again with a "
            "new code, use: python -m kbe access reopen"
        )
    if status.get("setup_code_set"):
        raise KbeError(
            "A setup code is already set. If it was lost, replace it with: "
            "python -m kbe access reopen"
        )
    return _open_setup(args, ctx, "Make a setup code and open the setup page?")


def _cmd_reopen(args: argparse.Namespace, ctx: Context) -> int:
    status = read_status(_store(args, ctx))
    if has_sign_in(status):
        ctx.out("The sign-in settings stored now stay in force until a new setup completes.")
    if status.get("setup_code_set"):
        ctx.out("The setup code set before stops working.")
    return _open_setup(
        args, ctx, "Make a new setup code and reopen the setup page?", has_sign_in(status)
    )


def describe_status(status: Mapping[str, Any]) -> list[str]:
    """Plain lines for `kbe access status`. No secret is in a status."""
    access = status.get("access") if isinstance(status.get("access"), Mapping) else {}
    lines = [
        f"setup:            {status.get('setup_state', 'unknown')}",
        f"setup code:       {'set' if status.get('setup_code_set') else 'not set'}",
        f"sign-in settings: {'present' if has_sign_in(status) else 'missing'}",
        f"admin pages app:  {'present' if access.get('status_aud') else 'missing'}",
    ]
    lines.extend(f"{key + ':':<18}{access[key]}" for key in _SHOWN if access.get(key))
    if status.get("setup_opened_at") and status.get("setup_state") == "open":
        lines.append(f"{'opened at:':<18}{status['setup_opened_at']}")
    if not has_sign_in(status):
        lines.append("Nothing is indexed until sign-in is set up.")
    return lines


def _cmd_status(args: argparse.Namespace, ctx: Context) -> int:
    status = read_status(_store(args, ctx))
    if args.json:
        ctx.out(json.dumps(status, indent=2, sort_keys=True))
    else:
        for line in describe_status(status):
            ctx.out(line)
    return 0


def build_access(args: argparse.Namespace) -> dict[str, str]:
    """The settings to store, checked before the database sees them."""
    host = (args.host or "").strip().lower()
    team = (args.team_domain or "").strip().rstrip("/")
    problems = []
    if _TEAM_DOMAIN.fullmatch(team) is None:
        problems.append("--team-domain must be https://<team>.cloudflareaccess.com")
    if _HOSTNAME.fullmatch(host) is None:
        problems.append("--host must be a bare hostname such as engine.example.com")
    for flag, value in (("--aud", args.aud), ("--status-aud", args.status_aud)):
        if value is not None and _AUD.fullmatch(value) is None:
            problems.append(f"{flag} must be the application's AUD tag")
    if args.status_aud is not None and args.status_aud == args.aud:
        problems.append("--status-aud must differ from --aud (two separate applications)")
    if problems:
        raise UsageError("; ".join(problems) + ".")
    access = {
        "team_domain": team, "aud": args.aud, "host": host,
        "resource_url": f"https://{host}/mcp",
    }
    optional = {"status_aud": args.status_aud, "level": args.level}
    return {**access, **{key: value for key, value in optional.items() if value}}


def _changes(before: Any, after: Mapping[str, str]) -> list[str]:
    old = before if isinstance(before, Mapping) else {}
    keys = sorted(set(old) | set(after))
    return [
        f"  {key}: {old.get(key, '(not set)')} -> {after.get(key, '(removed)')}"
        for key in keys if old.get(key) != after.get(key)
    ]


def _cmd_adopt(args: argparse.Namespace, ctx: Context) -> int:
    access = build_access(args)
    store = _store(args, ctx)
    ctx.out(f"Using {store.describe()}.")
    status = read_status(store)
    changes = _changes(status.get("access"), access)
    if not changes and status.get("setup_state") == "complete":
        ctx.out("No changes: these sign-in settings are already stored and setup is complete.")
        return 0
    ctx.out("Sign-in settings to store (none of these is a secret):")
    for line in changes or ["  (the same settings; setup would be marked complete)"]:
        ctx.out(line)
    if args.dry_run:
        ctx.out("Dry run: nothing was changed.")
        return 0
    question = "Store these settings and mark setup complete? The service will use them for sign-in."
    if not args.yes and not ctx.confirm(question):
        raise KbeError("Not changed. Re-run with --yes to go ahead without being asked.")
    store.call("engine_access_adopt", {"p_access": access})
    current = state.with_answer(state.load(ctx.state_file), "engine_host", access["host"])
    state.save(ctx.state_file, state.with_phase(current, PHASE, "done"))
    ctx.out("Stored. Setup is complete; the pullers will ingest on their next run.")
    return 0


def _common(parser: argparse.ArgumentParser, *, changes: bool) -> None:
    parser.add_argument(
        "--via", choices=("auto", "api", "db"), default="auto",
        help="how to reach the database: the REST API as the pullers do (api), "
        "KBE_DATABASE_URL (db), or whichever is configured (auto, the default)",
    )
    if changes:
        parser.add_argument("--dry-run", action="store_true", help="say what would happen only")
        parser.add_argument("--yes", action="store_true", help="go ahead without asking")


def _add_adopt(commands: argparse._SubParsersAction) -> None:
    adopt = commands.add_parser(
        "adopt",
        help="store sign-in settings that were made by hand",
        description="For a deployment whose Cloudflare Access applications were created "
        "by hand. Stores their non-secret values (team domain, AUD tags, hostname, "
        "level) as the Engine's sign-in settings and marks setup complete. Takes no "
        "secret: no API token and no setup code.",
    )
    adopt.add_argument("--team-domain", required=True, metavar="URL",
                       help="https://<team>.cloudflareaccess.com")
    adopt.add_argument("--aud", required=True, help="AUD tag of the hostname application")
    adopt.add_argument("--status-aud", help="AUD tag of the admin pages application")
    adopt.add_argument("--host", required=True, help="the Engine's public hostname")
    adopt.add_argument("--level", choices=LEVELS, help="who may sign in: owner, people or domain")
    _common(adopt, changes=True)
    adopt.set_defaults(func=_cmd_adopt)


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "access",
        help="the one-time setup code and the sign-in settings",
        description="Set up Cloudflare sign-in with one command (`setup`), open the setup "
        "page with a one-time code instead, see where setup stands, or store sign-in "
        "settings that were made by hand. Nothing is indexed until sign-in is set up.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")

    # Imported here: access_setup uses this module's helpers.
    from . import access_setup

    access_setup.add_parser(commands, _common)

    init = commands.add_parser(
        "init",
        help="make the one-time setup code and open the setup page",
        description="Makes a long random setup code, stores only its hash in the "
        f"database, and hands the code over once so you can save it as the app secret "
        f"{SECRET_NAME}: --clipboard, --out FILE or --show. With none of them the "
        "command refuses.",
    )
    _common(init, changes=True)
    secret_out.add_flags(init, what="setup code")
    init.set_defaults(func=_cmd_init)

    reopen = commands.add_parser(
        "reopen",
        help="make a new setup code and reopen the setup page",
        description="Replaces the setup code and reopens the setup page, also after a "
        "lockout. Sign-in settings already stored stay in force until the new setup "
        "completes. The new code is handed over once: --clipboard, --out FILE or --show.",
    )
    _common(reopen, changes=True)
    secret_out.add_flags(reopen, what="setup code")
    reopen.set_defaults(func=_cmd_reopen)

    status = commands.add_parser(
        "status",
        help="where setup stands",
        description="Shows the setup state, whether a setup code is set, the level, the "
        "hostname and whether sign-in settings are present. Read from the database; "
        "shows no secret.",
    )
    status.add_argument("--json", action="store_true", help="print the status as JSON")
    _common(status, changes=False)
    status.set_defaults(func=_cmd_status)

    _add_adopt(commands)
