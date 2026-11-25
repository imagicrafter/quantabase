"""`kbe deploy secrets push` -- set the app's secrets from the local env file.

    kbe deploy secrets push [--app-id ID] [--setup-code-from-clipboard] [--dry-run] [--yes]

Without `--yes` it only says what it would do, one line per secret, by name.
No value and no length is ever shown. With `--yes` the live spec is sent back
with the new values in it; everything else in it is left exactly as it was.

DigitalOcean does not reveal whether a secret already holds a value, so the
push sets every secret it has a local value for, every time. Setting one to
the value it already has changes nothing: it is safe to run again.
"""

from __future__ import annotations

import argparse
import re
from typing import Callable, Mapping, Sequence

from . import deploy_doctl, deploy_render, deploy_secrets, proc, secrets
from .context import Context
from .deploy_secrets import Item
from .errors import KbeError, UsageError

SETUP_CODE = "SETUP_CODE"
_CODE_SHAPE = re.compile(r"[A-Za-z0-9_-]{32,256}")
_LABELS = {
    deploy_secrets.SET: "will set",
    deploy_secrets.SKIP: "no local value, left as it is",
}
_CANNOT_TELL = (
    "DigitalOcean does not reveal whether a secret already holds a value, so every secret "
    "with a local value is set, each time. It is safe to run again."
)
_NOT_A_CODE = (
    "The clipboard does not hold a setup code (32 to 256 letters, digits, - or _), so "
    "nothing was changed. Run `python -m kbe access init --clipboard --yes`, then this "
    "command again straight away."
)


def _from_clipboard(ctx: Context, values: Mapping[str, str]) -> str:
    """The setup code on the clipboard, or a refusal that shows none of it."""
    result = ctx.runner(["pbpaste"], timeout=15)
    if result.code == proc.NOT_FOUND:
        raise KbeError(
            "pbpaste was not found, so the clipboard cannot be read on this machine. "
            f"Enter {SETUP_CODE} in the DigitalOcean dashboard instead."
        )
    if not result.ok:
        raise KbeError("pbpaste could not read the clipboard.")
    code = result.stdout.strip()
    if not _CODE_SHAPE.fullmatch(code):
        raise UsageError(_NOT_A_CODE)
    same = sorted(name for name, value in values.items() if value == code)
    if same:
        raise UsageError(
            f"The clipboard holds the value of {', '.join(same)} from your env file, not the "
            "setup code, so nothing was changed. Run `python -m kbe access init --clipboard "
            "--yes`, then this command again straight away."
        )
    return code


def _note(item: Item, from_clipboard: bool) -> str:
    if item.action != deploy_secrets.SET:
        return ""
    if item.key == SETUP_CODE and from_clipboard:
        return "  (from the clipboard)"
    local = deploy_secrets.local_name(item.key)
    return f"  ({local} in your env file)" if local != item.key else ""


def _preview(items: Sequence[Item], from_clipboard: bool) -> list[str]:
    lines: list[str] = []
    last = None
    for item in items:
        if item.component != last:
            lines.append(f"  {item.component}")
            last = item.component
        lines.append(f"    {item.key}  {_LABELS[item.action]}{_note(item, from_clipboard)}")
    return lines


def _skipped(items: Sequence[Item]) -> list[str]:
    """What to do about each secret that has no local value, once per name."""
    names = list(dict.fromkeys(i.key for i in items if i.action == deploy_secrets.SKIP))
    if not names:
        return []
    lines = ["No local value for these, so they are left as they are. If one still needs "
             "a value, put it in your env file and run this again, or enter it in the "
             "DigitalOcean dashboard as Encrypted:"]
    for key in names:
        local = deploy_secrets.local_name(key)
        if key == SETUP_CODE:
            where = ("it is never kept in the env file. `python -m kbe access setup` sets "
                     "it by itself. For the setup page instead: right after `python -m kbe "
                     "access init --clipboard`, run this with --setup-code-from-clipboard")
        else:
            where = deploy_render.secret_source(key)
        name = key if local == key else f"{key} ({local} in your env file)"
        lines.append(f"  {name}  <- {where}")
    return lines


def _count(items: Sequence[Item], *actions: str) -> int:
    return sum(1 for item in items if item.action in actions)


def run(args: argparse.Namespace, ctx: Context, app_id: str) -> int:
    values = secrets.load(ctx.env_file)
    live = deploy_doctl.Doctl(ctx.runner, values).live_spec(app_id)
    read_clipboard = bool(args.setup_code_from_clipboard) and deploy_secrets.declares(
        live, SETUP_CODE)
    local = {**values, **({SETUP_CODE: _from_clipboard(ctx, values)} if read_clipboard else {})}
    items = deploy_secrets.plan(live, local)
    if not items:
        ctx.out("The live app declares no secrets. Nothing to set.")
        return 0

    changing = _count(items, deploy_secrets.SET)
    ctx.out(f"Secrets of app {app_id}, from {ctx.env_file} (values are never shown):")
    for line in _preview(items, read_clipboard):
        ctx.out(line)
    ctx.out(f"{changing} to set, {_count(items, deploy_secrets.SKIP)} with no local value.")
    ctx.out(_CANNOT_TELL)
    for line in _skipped(items):
        ctx.out(line)
    if not changing:
        ctx.out("Nothing to set: no secret of this app has a value in your env file.")
        return 0
    ctx.out("Setting them starts a new deployment of the app. Nothing else in the app changes.")
    if args.dry_run or not args.yes:
        ctx.out("Nothing was changed. Re-run with --yes to set them.")
        return 0

    spec = deploy_render.dump(deploy_secrets.updated(live, local))
    app = deploy_doctl.Doctl(ctx.runner, local).update(app_id, spec)
    ctx.out(f"Set {changing} secret value{'' if changing == 1 else 's'} on app {app.id}. "
            "A new deployment has started.")
    ctx.out("Follow it with: python -m kbe deploy status")
    return 0


def add_parser(
    commands: argparse._SubParsersAction, func: Callable[[argparse.Namespace, Context], int],
) -> None:
    group = commands.add_parser(
        "secrets", help="set the app's secrets from the local env file",
        description="The app's secret values. `push` sets them from the local env file, "
        "so nobody types them into the dashboard.",
    )
    push = group.add_subparsers(dest="secrets_command", required=True, metavar="<command>").add_parser(
        "push", help="set the app's secrets from the local env file",
        description="Reads the live app spec and, for every variable declared as a secret "
        "(app-wide, the service and each job), takes the value of the same name from the "
        "local env file. EMBED_TOKEN on the service is KNOWLEDGE_EMBED_TOKEN locally. "
        "Without --yes it only lists what it would do, by name: no value and no length is "
        "shown. DigitalOcean does not reveal whether a secret already holds a value, so "
        "every secret that has a local value is set, each time; one with no local value is "
        "left as it is. Safe to run again. Nothing but secret values is changed. Setting "
        "them starts a new deployment.",
    )
    push.add_argument("--app-id", metavar="ID",
                      help="the app to act on (default: the one this tool created)")
    push.add_argument("--setup-code-from-clipboard", action="store_true",
                      help="take SETUP_CODE from the clipboard (macOS), right after "
                      "`kbe access init --clipboard`; refused unless it looks like a setup code")
    push.add_argument("--dry-run", action="store_true", help="show what would happen only")
    push.add_argument("--yes", action="store_true", help="set them (the default only previews)")
    push.set_defaults(func=func)
