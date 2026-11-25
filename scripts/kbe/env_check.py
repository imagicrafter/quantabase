"""`kbe env check` -- the shape of each line of the local env file.

    kbe env check

For every name in the env file, and every name the example file has that the
env file lacks, it says one of: set, empty, still the example placeholder,
wrapped in <...>, not in the file. It shows names only: never a value, never
a length. Use it after filling the file in, in place of opening the file.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Mapping

from . import secrets
from .context import Context
from .errors import KbeError

EXAMPLE_NAME = ".env" + ".example"

SET = "set"
EMPTY = "empty"
PLACEHOLDER = "still the example placeholder"
WRAPPED = "wrapped in <...> (remove the brackets)"
ABSENT = "not in the file"

NOW, LATER, OPTIONAL = "now", "later", "optional"
_TITLES = (
    (NOW, "Needed now"),
    (LATER, "Filled in by a later step"),
    (OPTIONAL, "Optional"),
)

# When each name is needed during setup. The one table; a name that is not
# here is optional. The reference for every name is docs/configuration.md.
WHEN: Mapping[str, tuple[str, str]] = {
    "SUPABASE_URL": (NOW, ""),
    "SUPABASE_ANON_KEY": (NOW, ""),
    "SUPABASE_JWT_SECRET": (NOW, ""),
    "KBE_DATABASE_URL": (NOW, ""),
    "KNOWLEDGE_EMBED_URL": (NOW, ""),
    "KNOWLEDGE_EMBED_TOKEN": (LATER, "written by `kbe tokens mint --embed --write-env`"),
    "DO_INFERENCE_KEY": (LATER, "when the summary model runs on DigitalOcean"),
    "ANTHROPIC_API_KEY": (LATER, "only when the summary model runs on Anthropic"),
    "GITHUB_TOKEN": (LATER, "the wiki source"),
    "FIREFLIES_API_KEY": (LATER, "the meetings source"),
    "DRIVE_TOKEN_JSON_B64": (LATER, "from `kbe sources drive auth`"),
    "DRIVE_TOKEN_CLIENT_JSON_B64": (LATER, "from `kbe sources drive auth`"),
    "GMAIL_TOKEN_JSON_B64": (LATER, "from `kbe sources gmail auth`, only when Gmail is on"),
}
_PERSON_TOKEN_PREFIX = "KNOWLEDGE_TOKEN_"


def when(name: str) -> tuple[str, str]:
    """(now | later | optional, a short note) for one name."""
    if name.startswith(_PERSON_TOKEN_PREFIX):
        return LATER, "written by `kbe tokens mint --write-env`"
    return WHEN.get(name, (OPTIONAL, ""))


def status(value: str | None, example: str | None) -> str:
    """What one line holds, without saying anything about the value itself."""
    text = (value or "").strip()
    if not text:
        return EMPTY
    if text.startswith("<") and text.endswith(">"):
        return PLACEHOLDER if example is not None and text == example.strip() else WRAPPED
    return SET


def hint(name: str, value: str) -> str:
    """A light check of a set value's shape. Says what is missing, never what is there."""
    text = value.strip()
    if name == "SUPABASE_ACCESS_TOKEN" and not text.startswith("sbp_"):
        return "does not start with sbp_"
    if name == "KBE_DATABASE_URL":
        return "" if text.startswith("postgres") else "does not start with postgres"
    if name.endswith("_URL") and not text.startswith(("http", "postgres")):
        return "does not start with http"
    return ""


def read(path: Path) -> dict[str, str | None]:
    """Every `NAME=` line that is on, as written: placeholders and empties included."""
    try:
        from dotenv import dotenv_values
    except ImportError as error:
        raise KbeError(
            "python-dotenv is not installed. Run: pip install -r pullers/requirements.txt"
        ) from error
    try:
        return dict(dotenv_values(path))
    except OSError as error:
        raise KbeError(f"Could not read {path}: {error.strerror}.") from error


def _is_problem(group: str, found: str, note: str) -> bool:
    """A needed-now line must be right; a wrapped value is a mistake wherever it is."""
    return found == WRAPPED or (group == NOW and (found != SET or bool(note)))


def report(
    local: Mapping[str, str | None], example: Mapping[str, str | None],
) -> tuple[list[str], list[str]]:
    """(the lines to show, the names that need fixing). Names only."""
    names = [*local, *(name for name in example if name not in local)]
    width = max((len(name) for name in names), default=0)
    lines: list[str] = []
    problems: list[str] = []
    for group, title in _TITLES:
        rows: list[str] = []
        for name in names:
            if when(name)[0] != group:
                continue
            found = status(local[name], example.get(name)) if name in local else ABSENT
            note = hint(name, local[name] or "") if found == SET else ""
            detail = f"{found}; {note}, check it" if note else found
            source = when(name)[1]
            suffix = f"  ({source})" if source and found != SET else ""
            rows.append(f"  {name.ljust(width)}  {detail}{suffix}")
            if _is_problem(group, found, note):
                problems.append(name)
        if rows:
            lines.extend([title, *rows])
    return lines, problems


def _cmd_check(_args: argparse.Namespace, ctx: Context) -> int:
    if not ctx.env_file.is_file():
        secrets.load(ctx.env_file)  # raises the one message for a missing file
    example_file = ctx.root / EXAMPLE_NAME
    example = read(example_file) if example_file.is_file() else {}
    lines, problems = report(read(ctx.env_file), example)
    ctx.out(f"{ctx.env_file}, line by line. Values are never shown.")
    for line in lines:
        ctx.out(line)
    if not problems:
        ctx.out("Nothing to fix: every value needed now is set.")
        return 0
    ctx.out(f"To fix in {ctx.env_file.name}: {', '.join(problems)}.")
    ctx.out("Replace the whole <...> with the real value, brackets included. "
            "A value wrapped in <...> counts as not filled in.")
    return 1


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "env", help="check the local env file without showing a value",
        description="The local env file holds this Engine's credentials. These commands "
        "look at it for you and never show a value.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    check = commands.add_parser(
        "check", help="say which lines are set, empty or still a placeholder",
        description="For every name in the local env file, and every name the example "
        "file has that yours lacks: set, empty, still the example placeholder, wrapped in "
        "<...>, or not in the file. Grouped by what is needed now, what a later step fills "
        "in, and what is optional. Names only: no value and no length is shown. Exits "
        "non-zero when a value needed now is missing or has the wrong shape, or when any "
        "value is still wrapped in <...>.",
    )
    check.set_defaults(func=_cmd_check)
