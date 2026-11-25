"""`kbe pages import` -- file an existing Markdown wiki as one person's pages.

    kbe pages import FOLDER --owner EMAIL [--map FILE] [--topic T ...] [--skip DIR ...] [--json]
    kbe pages import FOLDER --owner EMAIL [--map FILE] --apply [--yes]

One-time, for moving an existing OKF / Obsidian wiki into the Engine. The
mapping is in pages_import.py. Without --apply nothing leaves this machine: the
command reads the folder and prints what it would file, under which drawer and
key, and what it would skip and why. With --apply (after a yes) each page is
saved through `page_import` over the direct database connection
(KBE_DATABASE_URL). A key the person already holds is left alone and reported,
so a second run only adds what is new. A page that matches one the person
already has (a known address or domain, or the same name in the same drawer:
the curator's matching, migration 0067) is reported as matched and not made.
People and organisations are saved first, so a meeting's attendees can link
to them; a link to a page that matched an existing one follows it to that page.

Pages get only the topics named with --topic, and only ones the person
already holds; without --topic they are the owner's alone.

`--from-backup` restores a checkout of the Engine's nightly backup instead
(pages_import_backup.py): each page keeps its key, fields and sources, only the
--owner's pages are filed, and with `--keep-topics` each page keeps its own
topics. A plain import of a backup folder is refused.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from . import config_store, pg, schema as kb, secrets
from .context import Context
from .errors import KbeError, UsageError
from .pages_import import Plan, plan
from .pages_import_backup import plan_backup

_SHOW = 15


def _store(ctx: Context) -> config_store.ConfigStore:
    values = secrets.load(ctx.env_file)
    return config_store.DbStore(pg.connect(values, ctx.runner), kb.chosen(values), role=None)


RESTORE_MIGRATION = "0078"


def _topics_line(topics: list[str], keep_topics: bool) -> str:
    if topics:
        return "Topics: " + ", ".join(topics)
    if keep_topics:
        return "Topics: each page's own, from the backup (only topics the person holds are accepted)"
    return "Topics: none (pages stay the owner's alone)"


def report(result: Plan, owner: str, topics: list[str], keep_topics: bool = False) -> list[str]:
    """The dry-run report, as lines."""
    lines = [f"Would file {len(result.pages)} pages for {owner}; skip {len(result.skipped)} files."]
    lines.append(_topics_line(topics, keep_topics))
    for drawer, count in result.by_drawer().items():
        lines.append(f"  {drawer:<14} {count}")
    noted = [p for p in result.pages if p.notes]
    if noted:
        lines.append(f"Keys or fields to check later ({len(noted)}):")
        lines += [f"  {p.path}: {p.page['key']} ({'; '.join(p.notes)})" for p in noted[:_SHOW]]
        if len(noted) > _SHOW:
            lines.append(f"  ... and {len(noted) - _SHOW} more (--json lists all)")
    if result.skipped:
        lines.append("Skipped:")
        lines += [f"  {path}: {why}" for path, why in result.skipped[:_SHOW]]
        if len(result.skipped) > _SHOW:
            lines.append(f"  ... and {len(result.skipped) - _SHOW} more (--json lists all)")
    if result.dropped_keys:
        dropped = sorted(result.dropped_keys.items(), key=lambda kv: (-kv[1], kv[0]))
        lines.append("Frontmatter keys not carried over: "
                     + ", ".join(f"{k} ({n})" for k, n in dropped[:20]))
    if result.map_lines:
        lines.append("Map:")
        lines += result.map_lines
    if result.combined:
        lines.append(f"Combined into another page ({len(result.combined)}):")
        lines += [f"  {path} -> {into} ({why})" for path, into, why in result.combined[:_SHOW]]
        if len(result.combined) > _SHOW:
            lines.append(f"  ... and {len(result.combined) - _SHOW} more (--json lists all)")
    if result.attendees:
        linked = sum(1 for _, _, key in result.attendees if key)
        lines.append(f"Meeting attendees: {linked} link to a person page in this import; "
                     f"{len(result.attendees) - linked} are looked up among your existing person "
                     "pages when saved, and kept as the field attendees if none matches.")
    dated = sum(1 for p in result.pages if p.page.get("updated"))
    lines.append(f"Dates: {dated} pages keep their created/updated dates; the rest are dated today.")
    return lines


def _as_json(result: Plan) -> str:
    return json.dumps({
        "pages": [{"path": p.path, "drawer": p.page["drawer"], "key": p.page["key"],
                   "title": p.page["title"], "created": p.page.get("created"),
                   "updated": p.page.get("updated"), "merged": list(p.merged),
                   "notes": list(p.notes)} for p in result.pages],
        "skipped": [{"path": path, "reason": why} for path, why in result.skipped],
        "combined": [{"path": path, "into": into, "reason": why} for path, into, why in result.combined],
        "attendees": [{"path": path, "attendee": name, "links_to": key or None}
                      for path, name, key in result.attendees],
        "map": result.map_lines,
        "dropped_frontmatter_keys": result.dropped_keys,
    }, indent=2, ensure_ascii=False)


_FIRST = {"people": 0, "organisations": 1}


def _order(result: Plan) -> list[Any]:
    """People, then organisations, then the rest: links can then find them."""
    return sorted(result.pages, key=lambda p: _FIRST.get(p.page["drawer"], 2))


def apply(store: config_store.ConfigStore, result: Plan, owner: str, ctx: Context,
          restore: bool = False) -> dict[str, int]:
    """Save every planned page. A page the database refuses is reported and skipped.
    A restore stops at once if the database does not know restore mode (before
    migration 0078 it would match pages by name and drop some)."""
    counts = {"created": 0, "exists": 0, "matched": 0, "refused": 0}
    moved: dict[str, str] = {}
    for planned in _order(result):
        page = {**planned.page, "related": [moved.get(r, r) for r in planned.page["related"]]}
        try:
            answer: Any = store.call("page_import", {"p_owner_email": owner, "p_page": page})
        except KbeError as error:
            counts["refused"] += 1
            reason = str(error).strip().splitlines()[-1][:200]
            ctx.out(f"  refused {planned.path}: {reason}")
            continue
        if restore and not (isinstance(answer, dict) and answer.get("restore") is True):
            raise KbeError(f"This database cannot restore a backup yet: apply migration "
                           f"{RESTORE_MIGRATION} (Database screen or `kbe db migrate`), then run "
                           "the restore again. Pages already filed are kept.")
        status = answer.get("status") if isinstance(answer, dict) else None
        if status == "matched":
            counts["matched"] += 1
            moved[planned.page["key"]] = str(answer.get("key"))
            ctx.out(f"  matched {planned.path}: {planned.page['key']} is your page "
                    f"{answer.get('key')} ({answer.get('how')})")
            continue
        counts["created" if status == "created" else "exists"] += 1
    return counts


def _cmd_import(args: argparse.Namespace, ctx: Context) -> int:
    owner = (args.owner or "").strip().lower()
    if "@" not in owner:
        raise UsageError("--owner must be the email of the person the pages are for.")
    topics = sorted({t.strip().lower() for t in args.topic or [] if t.strip()})
    if args.keep_topics and not args.from_backup:
        raise UsageError("--keep-topics needs --from-backup.")
    if args.from_backup and args.map:
        raise UsageError("--map is for a wiki import; a backup is restored as it is.")
    folder = Path(args.folder).expanduser()
    if args.from_backup:
        result = plan_backup(folder, owner=owner, topics=topics, keep_topics=args.keep_topics,
                             skip=args.skip or [])
    else:
        map_file = Path(args.map).expanduser() if args.map else None
        result = plan(folder, topics=topics, skip=args.skip or [], map_file=map_file)
    if args.json:
        ctx.out(_as_json(result))
    else:
        for line in report(result, owner, topics, args.keep_topics):
            ctx.out(line)
    if not args.apply:
        ctx.out("Dry run: nothing was saved. Add --apply to file these pages.")
        return 0
    if not result.pages:
        ctx.out("Nothing to file.")
        return 0
    if not args.yes and not ctx.confirm(f"File {len(result.pages)} pages for {owner}?"):
        raise KbeError("Not imported. Re-run with --yes to import without being asked.")
    counts = apply(_store(ctx), result, owner, ctx, restore=args.from_backup)
    ctx.out(f"Done: {counts['created']} created, {counts['exists']} already there "
            f"(left alone), {counts['matched']} matched an existing page (left alone), "
            f"{counts['refused']} refused.")
    return 1 if counts["refused"] else 0


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "pages", help="import an existing Markdown wiki as pages",
        description="Pages live in the database. `import` files an existing OKF or Obsidian "
        "wiki folder as one person's pages: a dry-run report first, then --apply.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    imp = commands.add_parser(
        "import", help="file a Markdown wiki folder as one person's pages",
        description="Reads FOLDER (frontmatter -> header, type -> drawer, related and "
        "[[links]] -> links, keys from the entity templates' rules). Without --apply it "
        "only prints what it would do. A key the person already holds is never changed.",
    )
    imp.add_argument("folder", help="the wiki folder (a vault or a knowledge repo checkout)")
    imp.add_argument("--owner", required=True, metavar="EMAIL",
                     help="the active person the pages are for")
    imp.add_argument("--map", metavar="FILE",
                     help="a YAML file that refiles files (drawer, key, aliases), merges two "
                     "files into one page (merge_into) and adds pages with no file (create)")
    imp.add_argument("--topic", action="append", metavar="TOPIC",
                     help="file every page under this topic (repeat for more; the person "
                     "must hold it). Without it the pages are the owner's alone.")
    imp.add_argument("--skip", action="append", metavar="DIR",
                     help="also skip folders with this name (templates, sources and "
                     "dot-folders are always skipped)")
    imp.add_argument("--from-backup", action="store_true",
                     help="FOLDER is a checkout of the Engine's nightly backup: restore the "
                     "--owner's pages with their own keys, fields and sources (other people's "
                     "pages are skipped; needs migration 0078)")
    imp.add_argument("--keep-topics", action="store_true",
                     help="with --from-backup: each page keeps its own topics from the backup "
                     "(the person must hold them)")
    imp.add_argument("--json", action="store_true", help="print the plan as JSON")
    imp.add_argument("--apply", action="store_true", help="save the pages (asks first)")
    imp.add_argument("--yes", action="store_true", help="with --apply: do not ask")
    imp.set_defaults(func=_cmd_import)
