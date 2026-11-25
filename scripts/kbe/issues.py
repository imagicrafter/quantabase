"""`kbe issues` -- read the Engine's issue log.

    kbe issues list [--all] [--as EMAIL] [--json]
    kbe issues show ID [--as EMAIL] [--json]

Read-only. The issue log holds what went wrong with a source, a config or a
tag, and what people reported through the connector. It never holds document
text or titles. Both commands call administrator-only database functions
(0044_issues_admin_read.sql): the database re-checks that `--as` (default:
the owner in the local state file) is an active administrator.

Uses the direct connection (KBE_DATABASE_URL), as `kbe people` does.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from typing import Any, Mapping

from . import people
from .context import Context
from .errors import KbeError, UsageError

_UUID = re.compile(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
_DETAIL_FIELDS = (
    "status", "category", "source", "error_class", "reported_by", "occurrences",
    "opened_at", "last_seen_at", "closed_at", "pr_url", "proof",
)


def printable(value: Any, *, lines: bool = False) -> str:
    """`value` as text that is safe to print.

    Issue titles and details are written by people and by failing programs.
    Control and formatting characters are dropped, so text in an issue can
    never move the cursor, write the clipboard or hide what is on screen.
    With `lines`, line breaks are kept; otherwise the text stays on one line.
    """
    text = str(value).replace("\r\n", "\n")
    kept = "\n\t" if lines else ""
    cleaned = "".join(
        ch if ch in kept or unicodedata.category(ch) not in ("Cc", "Cf", "Zl", "Zp") else " "
        for ch in text
    )
    return cleaned if lines else " ".join(cleaned.split())


def issue_line(issue: Mapping[str, Any]) -> str:
    """One issue on one line: id, state, where it came from, its title."""
    seen = issue.get("occurrences") or 1
    times = f"  x{seen}" if seen > 1 else ""
    fields = (issue.get("id"), issue.get("status"), issue.get("category"),
              issue.get("source") or "-", issue.get("title"))
    return "  ".join(printable(field) for field in fields) + times


def issue_detail_lines(issue: Mapping[str, Any]) -> list[str]:
    """Everything stored about one issue, a field per line."""
    lines = [printable(issue.get("title") or ""), f"{'id:':<14}{printable(issue.get('id'))}"]
    lines.extend(
        f"{name.replace('_', ' ') + ':':<14}{printable(issue[name])}"
        for name in _DETAIL_FIELDS if issue.get(name) not in (None, "")
    )
    if issue.get("detail"):
        lines.extend(["", printable(issue["detail"], lines=True)])
    return lines


def _cmd_list(args: argparse.Namespace, ctx: Context) -> int:
    found = people.store(ctx).call(
        "issues_list",
        {"p_email": people.administrator(args, ctx), "p_include_closed": bool(args.all)},
    )
    listed = found if isinstance(found, list) else []
    if args.json:
        ctx.out(json.dumps(listed, indent=2))
        return 0
    if not listed:
        ctx.out("No issues." if args.all else "No open issues.")
    for issue in listed:
        ctx.out(issue_line(issue))
    return 0


def _cmd_show(args: argparse.Namespace, ctx: Context) -> int:
    if _UUID.fullmatch(args.id) is None:
        raise UsageError("ID must be an issue id as `kbe issues list` shows it.")
    found = people.store(ctx).call(
        "issue_detail", {"p_email": people.administrator(args, ctx), "p_id": args.id.lower()},
    )
    if not isinstance(found, Mapping):
        raise KbeError("There is no issue with that id.")
    if args.json:
        ctx.out(json.dumps(found, indent=2))
        return 0
    for line in issue_detail_lines(found):
        ctx.out(line)
    return 0


def _flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--as", dest="acting_as", metavar="EMAIL",
        help="the administrator asking (default: the owner in local state)",
    )
    parser.add_argument("--json", action="store_true", help="print the result as JSON")


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "issues",
        help="read the issue log",
        description="What went wrong with a source, the config or a tag, and what "
        "people reported. Read-only; administrators only. Uses the direct database "
        "connection (KBE_DATABASE_URL).",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    listing = commands.add_parser(
        "list", help="the open issues, newest first",
        description="Lists the open issues, newest first: id, state, category, source "
        "and title. --all also lists the closed ones (the newest 200 in all).",
    )
    listing.add_argument("--all", action="store_true", help="include closed issues")
    _flags(listing)
    listing.set_defaults(func=_cmd_list)
    show = commands.add_parser(
        "show", help="one issue with its detail",
        description="Shows everything stored about one issue. An issue holds a short "
        "redacted message, never document text.",
    )
    show.add_argument("id", metavar="ID", help="the issue id from `kbe issues list`")
    _flags(show)
    show.set_defaults(func=_cmd_show)
