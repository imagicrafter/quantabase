"""`kbe people` -- add people and grant topics during setup.

    kbe people list       [--as EMAIL] [--json]
    kbe people add EMAIL --name NAME [--role reader|reviewer|administrator] [--admin-ack]
    kbe people grant EMAIL TOPIC [--sensitive-ack]
    kbe people revoke EMAIL TOPIC
    kbe people deactivate EMAIL
    kbe people reactivate EMAIL
        (each change also takes --as EMAIL, --dry-run and --yes)

Thin wrappers over the admin functions the connector's tools use
(supabase/migrations/0033_admin_tools.sql). Every change is two steps, as it
is there: the database returns a preview of exactly what will change and a
one-time confirmation code; after a yes, the same arguments and the code are
sent back to apply it. The database re-checks that `--as` (default: the owner
in the local state file) is an active administrator. The code is used and
never shown.

These functions are granted to the service's role only, so this group uses
the direct connection (KBE_DATABASE_URL) as its own login.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from . import config_store, pg, schema as kb, secrets, state
from .context import Context
from .errors import KbeError, UsageError

ROLES = ("reader", "reviewer", "administrator")


@dataclass(frozen=True)
class Action:
    """One admin change: its two functions and how to build their arguments."""

    preview: str
    apply: str
    arguments: Callable[[argparse.Namespace], dict[str, Any]]


def _add_args(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "p_new_email": args.email, "p_display_name": args.name, "p_role": args.role,
        "p_admin_ack": bool(args.admin_ack),
    }


def _grant_args(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "p_person_email": args.email, "p_topic": args.topic,
        "p_sensitive_ack": bool(args.sensitive_ack),
    }


def _revoke_args(args: argparse.Namespace) -> dict[str, Any]:
    return {"p_person_email": args.email, "p_topic": args.topic}


def _deactivate_args(args: argparse.Namespace) -> dict[str, Any]:
    return {"p_person_email": args.email}


ACTIONS: Mapping[str, Action] = {
    "add": Action("admin_person_add_preview", "admin_person_add_apply", _add_args),
    "grant": Action("admin_grant_preview", "admin_grant_apply", _grant_args),
    "revoke": Action("admin_revoke_preview", "admin_revoke_apply", _revoke_args),
    "deactivate": Action(
        "admin_person_deactivate_preview", "admin_person_deactivate_apply", _deactivate_args
    ),
    "reactivate": Action(
        "admin_person_reactivate_preview", "admin_person_reactivate_apply", _deactivate_args
    ),
}


def store(ctx: Context) -> config_store.DbStore:
    values = secrets.load(ctx.env_file)
    return config_store.DbStore(pg.connect(values, ctx.runner), kb.chosen(values), role=None)


def administrator(args: argparse.Namespace, ctx: Context) -> str:
    """Whose authority the change is made under."""
    email = args.acting_as or state.answer(state.load(ctx.state_file), "owner_email")
    if not email:
        raise UsageError(
            "Say which administrator is making the change with --as EMAIL "
            "(the owner's email is remembered after `kbe config apply`)."
        )
    return str(email)


def change(
    store: config_store.ConfigStore,
    action: Action,
    administrator: str,
    arguments: Mapping[str, Any],
    ctx: Context,
    *,
    dry_run: bool = False,
    yes: bool = False,
) -> bool:
    """Preview, confirm, apply. True when the database was changed."""
    named = {"p_email": administrator, **arguments}
    preview = store.call(action.preview, named)
    if not isinstance(preview, Mapping) or not preview.get("confirm_code"):
        raise KbeError("The database returned no preview for this change.")
    ctx.out(str(preview.get("preview") or "").strip())
    if dry_run:
        ctx.out("Dry run: nothing was changed.")
        return False
    if not yes and not ctx.confirm("Make this change?"):
        raise KbeError("Not changed. Re-run with --yes to apply without being asked.")
    result = store.call(action.apply, {**named, "p_code": preview["confirm_code"]})
    summary = result.get("summary") if isinstance(result, Mapping) else None
    ctx.out(f"Done. {summary or ''}".strip())
    return True


def _cmd_change(args: argparse.Namespace, ctx: Context) -> int:
    action = ACTIONS[args.command]
    change(
        store(ctx), action, administrator(args, ctx), action.arguments(args), ctx,
        dry_run=args.dry_run, yes=args.yes,
    )
    return 0


def _person_line(person: Mapping[str, Any]) -> str:
    topics = ", ".join(person.get("topics") or []) or "no topics"
    state_word = "" if person.get("active") else " (inactive)"
    return (
        f"{person.get('email') or person.get('handle')}  "
        f"{person.get('role')}{state_word}  [{topics}]"
    )


def _cmd_list(args: argparse.Namespace, ctx: Context) -> int:
    people = store(ctx).call("admin_people_list", {"p_email": administrator(args, ctx)})
    listed = people if isinstance(people, list) else []
    if args.json:
        ctx.out(json.dumps(listed, indent=2))
        return 0
    if not listed:
        ctx.out("No people yet.")
    for person in listed:
        ctx.out(_person_line(person))
    return 0


def _as_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--as", dest="acting_as", metavar="EMAIL",
        help="the administrator making the change (default: the owner in local state)",
    )


def _change_parser(
    commands: argparse._SubParsersAction, name: str, text: str, detail: str
) -> argparse.ArgumentParser:
    parser = commands.add_parser(
        name, help=text,
        description=f"{detail} Shows the database's own preview of the change, asks "
        "for a yes, then applies exactly that change.",
    )
    parser.add_argument("email", help="the person's email address")
    _as_flag(parser)
    parser.add_argument("--dry-run", action="store_true", help="show the preview only")
    parser.add_argument("--yes", action="store_true", help="apply without asking")
    parser.set_defaults(func=_cmd_change)
    return parser


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "people",
        help="list people, add them and grant topics",
        description="The same people and topic changes the connector's admin tools "
        "make, for use during setup. Each change is previewed by the database and "
        "applied only after a yes. Uses the direct database connection "
        "(KBE_DATABASE_URL).",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")

    listing = commands.add_parser(
        "list", help="everyone, their role and their topics",
        description="Lists every person, whether they are active, their role and the "
        "topics they are granted. Needs an administrator's email (--as, or the owner "
        "remembered in local state).",
    )
    _as_flag(listing)
    listing.add_argument("--json", action="store_true", help="print the list as JSON")
    listing.set_defaults(func=_cmd_list)

    add = _change_parser(commands, "add", "add a person", "Adds a person by email.")
    add.add_argument("--name", required=True, help="the name shown for this person")
    add.add_argument("--role", choices=ROLES, default="reader", help="default: reader")
    add.add_argument("--admin-ack", action="store_true",
                     help="needed to add an administrator")

    grant = _change_parser(commands, "grant", "grant a person a topic",
                           "Lets a person see one topic.")
    grant.add_argument("topic", help="topic id from the Engine config")
    grant.add_argument("--sensitive-ack", action="store_true",
                       help="needed to grant a sensitive topic")

    revoke = _change_parser(commands, "revoke", "take a topic away from a person",
                            "Removes one topic from a person.")
    revoke.add_argument("topic", help="topic id from the Engine config")

    _change_parser(commands, "deactivate", "switch a person off",
                   "Deactivates a person: they can no longer sign in to the Engine.")
    _change_parser(commands, "reactivate", "switch a deactivated person back on",
                   "Reactivates a person: their role and the topics still listed for "
                   "them take effect again. This widens access; read the preview.")
