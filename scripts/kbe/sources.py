"""`kbe sources` -- connect the sources and check their credentials.

    kbe sources list [--json]
    kbe sources wiki check [--repo OWNER/NAME]
    kbe sources fireflies check
    kbe sources drive check
    kbe sources drive auth --client-secret FILE (--clipboard | --out FILE)
    kbe sources gmail check
    kbe sources gmail auth --client-secret FILE (--clipboard | --out FILE)

A check makes one cheap read with the credential in the local env file and
says pass or fail. It never shows what the source returned.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from . import (
    config_store,
    secrets,
    sources_checks,
    sources_drive,
    sources_gmail,
    sources_state,
    state,
)
from .context import Context
from .errors import KbeError, UsageError

REPO_ANSWER = "wiki_repo"
_REPO = re.compile(r"^[\w.-]+/[\w.-]+$")


def _report(check: sources_checks.Check, ctx: Context) -> int:
    ctx.out(check.line())
    return 0 if check.ok else 1


def _cmd_list(args: argparse.Namespace, ctx: Context) -> int:
    values = secrets.load(ctx.env_file)
    config = config_store.choose(values, "auto", ctx.runner).get()
    enabled = sources_state.enabled_sources(config)
    statuses = sources_state.combine(enabled, sources_state.state_rows(values, ctx.runner))
    if args.json:
        ctx.out(json.dumps([status.as_json() for status in statuses], indent=2))
    else:
        ctx.out(sources_state.render(statuses))
    return 0


def _cmd_wiki_check(args: argparse.Namespace, ctx: Context) -> int:
    repo = args.repo or state.answer(state.load(ctx.state_file), REPO_ANSWER)
    if repo and not _REPO.fullmatch(repo):
        raise UsageError("--repo must be OWNER/NAME, for example acme/knowledge.")
    return _report(sources_checks.check_wiki(secrets.load(ctx.env_file), repo), ctx)


def _cmd_fireflies_check(_args: argparse.Namespace, ctx: Context) -> int:
    return _report(sources_checks.check_fireflies(secrets.load(ctx.env_file)), ctx)


def _cmd_drive_check(_args: argparse.Namespace, ctx: Context) -> int:
    return _report(sources_checks.check_drive(secrets.load(ctx.env_file)), ctx)


def _hand_over(args: argparse.Namespace, ctx: Context, what: str, sign_in, next_steps) -> int:
    """Run a Google sign-in and hand its secrets to the clipboard or a new file."""
    out_file = Path(args.out).expanduser() if args.out else None
    if out_file is not None and out_file.exists():
        raise UsageError(f"{out_file} already exists. It is never replaced; name a new file.")
    ctx.out(f"A browser window opens for the Google sign-in (read-only {what} access).")
    values = sign_in(Path(args.client_secret).expanduser())
    if out_file is not None:
        saved = sources_drive.to_file(out_file, values)
        ctx.out(f"Saved {len(values)} values to {saved} (readable by you only). Remove it once they are set.")
    else:
        sources_drive.to_clipboard(ctx, values)
    for line in next_steps(list(values)):
        ctx.out(line)
    return 0


def _cmd_drive_auth(args: argparse.Namespace, ctx: Context) -> int:
    return _hand_over(args, ctx, "Drive", sources_drive.sign_in, sources_drive.next_steps)


def _cmd_gmail_auth(args: argparse.Namespace, ctx: Context) -> int:
    return _hand_over(args, ctx, "Gmail", sources_gmail.sign_in, sources_gmail.next_steps)


def _cmd_gmail_check(_args: argparse.Namespace, ctx: Context) -> int:
    values = secrets.load(ctx.env_file)
    try:
        config = config_store.choose(values, "auto", ctx.runner).get()
    except KbeError:
        # No database to ask: the sign-in itself can still be checked.
        config = None
    settings = sources_gmail.settings_from(config)
    return _report(sources_gmail.check_gmail(values, settings), ctx)


def _add_check(commands: argparse._SubParsersAction, what: str, func) -> argparse.ArgumentParser:
    check = commands.add_parser(
        "check",
        help=f"make one read with the configured {what} credential",
        description=f"Make one cheap read with the {what} credential in the local env "
        "file and report ok or FAILED. Exit code 1 on failure. Nothing the source "
        "returns is shown.",
    )
    check.set_defaults(func=func)
    return check


def _add_auth(commands: argparse._SubParsersAction, help_text: str, description: str, func) -> None:
    auth = commands.add_parser("auth", help=help_text, description=description)
    auth.add_argument(
        "--client-secret", required=True, metavar="FILE",
        help="the OAuth client JSON downloaded from the Google Cloud console",
    )
    where = auth.add_mutually_exclusive_group(required=True)
    where.add_argument(
        "--clipboard", action="store_true",
        help="copy each value to the clipboard in turn, then clear it",
    )
    where.add_argument(
        "--out", metavar="FILE",
        help="write NAME=value lines to a new file (mode 0600; an existing file is never replaced)",
    )
    auth.set_defaults(func=func)


def _register_drive(kinds: argparse._SubParsersAction) -> None:
    drive = kinds.add_parser(
        "drive",
        help="sign in to Google Drive (read-only) and check the stored token",
        description="Google Drive. `auth` is the one-time sign-in on your own machine; "
        "`check` proves the stored token still works.",
    )
    commands = drive.add_subparsers(dest="command", required=True, metavar="<command>")
    _add_auth(
        commands,
        "one-time Google sign-in; hands you the two app secrets",
        "Open a browser sign-in for read-only Drive access, using your own "
        "OAuth client file. The two resulting values (DRIVE_TOKEN_JSON_B64 and "
        "DRIVE_TOKEN_CLIENT_JSON_B64) are secrets: they go to the clipboard one at a "
        "time, or into a new file only you can read. They are never printed or stored "
        "by this tool.",
        _cmd_drive_auth,
    )
    _add_check(commands, "Drive", _cmd_drive_check)


def _register_gmail(kinds: argparse._SubParsersAction) -> None:
    gmail = kinds.add_parser(
        "gmail",
        help="sign in to Gmail (read-only) and check the stored sign-in",
        description="Gmail, an optional source that is off unless the config turns it on "
        "(sources.gmail.enabled). Only threads carrying a label named <prefix><topic> are "
        "ever read. `auth` is the one-time sign-in on your own machine; `check` proves "
        "the stored sign-in works and is for the mailbox the config names.",
    )
    commands = gmail.add_subparsers(dest="command", required=True, metavar="<command>")
    _add_auth(
        commands,
        "one-time Google sign-in; hands you the one app secret",
        "Open a browser sign-in for read-only Gmail access, using your own OAuth "
        "client file. Sign in as the mailbox the config names. The resulting value "
        "(GMAIL_TOKEN_JSON_B64) is a secret: it goes to the clipboard, or into a new "
        "file only you can read. It is never printed or stored by this tool.",
        _cmd_gmail_auth,
    )
    check = commands.add_parser(
        "check",
        help="prove the stored Gmail sign-in works, for the right mailbox",
        description="Ask Gmail whose mailbox the stored sign-in is for and list its "
        "labels. Reports ok or FAILED (exit code 1), and how many labels start with "
        "the tag prefix. No thread is listed and no mail is read; label names and the "
        "address Gmail returns are never shown.",
    )
    check.set_defaults(func=_cmd_gmail_check)


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "sources",
        help="connect the sources, check their credentials, see their last runs",
        description="The sources an Engine reads: the knowledge repo (wiki), Google "
        "Drive, Fireflies and Gmail. Credentials are read from the local env file and "
        "are never printed.",
    )
    kinds = parser.add_subparsers(dest="source", required=True, metavar="<source|list>")

    listing = kinds.add_parser(
        "list",
        help="the enabled sources and each one's last run",
        description="Show which sources the applied config turns on and when each last "
        "ran: ok, failing (and how many runs in a row) or never run. Stored error text "
        "is not shown.",
    )
    listing.add_argument("--json", action="store_true", help="machine-readable output")
    listing.set_defaults(func=_cmd_list)

    wiki = kinds.add_parser(
        "wiki",
        help="check the token for the knowledge repo",
        description="The knowledge repo. `check` proves the GitHub token can read it "
        "and that it holds .kb-engine/engine.yaml.",
    )
    wiki_commands = wiki.add_subparsers(dest="command", required=True, metavar="<command>")
    _add_check(wiki_commands, "GitHub", _cmd_wiki_check).add_argument(
        "--repo", metavar="OWNER/NAME",
        help="the knowledge repo (default: the one recorded by `kbe repo init` or `kbe config apply`)",
    )

    fireflies = kinds.add_parser(
        "fireflies",
        help="check the Fireflies key",
        description="Fireflies. `check` proves the API key can list meetings.",
    )
    fireflies_commands = fireflies.add_subparsers(dest="command", required=True, metavar="<command>")
    _add_check(fireflies_commands, "Fireflies", _cmd_fireflies_check)

    _register_drive(kinds)
    _register_gmail(kinds)
