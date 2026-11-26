"""Read the Engine's nightly backup (engine/src/backup/render.ts) back into pages.

`kbe pages import FOLDER --owner EMAIL --from-backup` restores ONE person's
pages from a checkout of the backup repository. Unlike a wiki import it takes
the header the backup wrote as the page itself, so a page comes back as it was:

  key         the `key` line, as written (never re-derived)
  owner       only files whose `owner` is --owner; every other person's page is
              skipped and listed, and can never stand in for the owner's
  fields      every frontmatter key that is not a header line, with the
              backup's `field_<name>` spelling turned back into `<name>`; the
              identity hints the backup adds (`email`, `domain`,
              `fireflies_id`, when they only repeat the key or a source) are
              dropped again
  related     [[Title]] links turned back into the keys of the pages they name
  sources     as written (objects stay objects)
  status, template, generated, verified, aliases, tags, description: as written
  body        exactly: the one newline the backup adds at the end is taken off,
              and the backup's file name in a split part's "Continued from /
              in [[...]]" line is turned back into the part's key
  dates       created / updated (the backup keeps the day only)
  topics      only with --keep-topics (each page's own) or --topic; without
              either the pages are the owner's alone

Not in the backup, so never restored: page history (log.md is a list of
titles), the reviewed date, other people's pages (restore each person in a
separate run), and everything that is not a page.

Each page is sent with `restore: true`, which tells page_import (migration
0078) to look for the key only, never to match the page to another by name or
address: two pages with one title (two "Weekly sync" meetings) both come back.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from .errors import KbeError
from .pages_import import (
    STATUSES, Drawer, Plan, Planned, _dates, _link_target, _text, load_drawers, markdown_files,
    part_key_for,
)
from .pages_import_combine import MAX_BODY
from .pages_import_split import relink, split_pages

# The header lines render.ts writes (its HEADER_KEYS); everything else is a field.
HEADER = frozenset({
    "title", "aliases", "description", "type", "key", "owner", "topics", "template", "status",
    "reviewed", "created", "updated", "tags", "related", "sources", "generated", "verified",
})
_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n(.*)\Z", re.S)
_BOOL_12 = re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$")


def _loader() -> type:
    """A safe loader that reads scalars as YAML 1.2 does, as the backup wrote
    them: `yes` stays a string and `2026-01-05` stays text, so a field comes
    back as the same value, not as a boolean or a date."""
    import yaml

    class Loader(yaml.SafeLoader):
        pass

    Loader.yaml_implicit_resolvers = {
        first: [(tag, regexp) for tag, regexp in resolvers
                if tag not in ("tag:yaml.org,2002:timestamp", "tag:yaml.org,2002:bool")]
        for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }
    Loader.add_implicit_resolver("tag:yaml.org,2002:bool", _BOOL_12, list("tTfF"))
    return Loader


def read_backup_file(text: str) -> tuple[dict[str, Any], str] | None:
    """(frontmatter, body) of one backup file, or None when it has no header."""
    import yaml

    match = _FRONTMATTER.match(text)
    if not match:
        return None
    try:
        loaded = yaml.load(match.group(1), Loader=_loader())  # noqa: S506 - a SafeLoader subclass
    except yaml.YAMLError:
        return None
    if not isinstance(loaded, dict):
        return None
    body = match.group(2)
    body = body[1:] if body.startswith("\n") else body  # the blank line after the header
    body = body[:-1] if body.endswith("\n") else body  # the newline the backup adds
    return {str(k): v for k, v in loaded.items()}, body


def _plain(value: Any) -> Any:
    """JSON-safe, as it was stored."""
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def _strings(value: Any) -> list[str]:
    return [_text(v) for v in value if _text(v)] if isinstance(value, list) else []


def _fireflies_ids(sources: Iterable[Any]) -> set[str]:
    return {str(s.get("source_id")) for s in sources
            if isinstance(s, dict) and s.get("source") == "fireflies" and s.get("source_id")}


def _fields(fm: Mapping[str, Any], key: str, sources: list[Any]) -> dict[str, Any]:
    hints = {"email": key, "domain": key}
    out: dict[str, Any] = {}
    for name, value in fm.items():
        if name in HEADER:
            continue
        if name in hints and _text(value).lower() == hints[name]:
            continue
        if name == "fireflies_id" and _text(value) in _fireflies_ids(sources):
            continue
        real = name[len("field_"):] if name.startswith("field_") and name[len("field_"):] in HEADER else name
        out[real] = _plain(value)
    return out


def _names(files: Iterable[tuple[str, dict[str, Any], str]]) -> dict[str, list[tuple[str, str]]]:
    """Vault name (file name, title, alias), lower case -> [(owner, key)]."""
    names: dict[str, list[tuple[str, str]]] = {}
    for rel, fm, _ in files:
        owner, key = _text(fm.get("owner")).lower(), _text(fm.get("key")).lower()
        if not key:
            continue
        for name in [Path(rel).stem, _text(fm.get("title")), *_strings(fm.get("aliases"))]:
            if name:
                names.setdefault(name.lower(), []).append((owner, key))
    return names


def _related(fm: Mapping[str, Any], owner: str, names: Mapping[str, list[tuple[str, str]]]) -> list[str]:
    out: list[str] = []
    for item in _strings(fm.get("related")):
        found = names.get(_link_target(item).lower(), [])
        mine = [k for o, k in found if o == owner]
        value = (mine or [k for _, k in found] or [item])[0]
        if value not in out:
            out.append(value)
    return out


def _owners_key(names: Mapping[str, list[tuple[str, str]]], owner: str, name: str) -> str | None:
    """The key of the page a backup file name stands for, the owner's first."""
    found = names.get(name.lower(), [])
    mine = [k for o, k in found if o == owner]
    return (mine or [k for _, k in found] or [None])[0]


def _page(rel: str, fm: Mapping[str, Any], body: str, drawer: Drawer, owner: str,
          names: Mapping[str, list[tuple[str, str]]], topics: list[str] | None) -> Planned:
    key = _text(fm.get("key")).lower()
    sources = _plain(fm.get("sources")) if isinstance(fm.get("sources"), list) else []
    status = _text(fm.get("status")).lower()
    dates, notes = _dates(fm)
    page: dict[str, Any] = {
        "key": key,
        "drawer": drawer.id,
        "title": _text(fm.get("title")) or Path(rel).stem,
        "aliases": _strings(fm.get("aliases")),
        "description": _text(fm.get("description")) or None,
        "status": status if status in STATUSES else "unreviewed",
        "tags": _strings(fm.get("tags")),
        "related": _related(fm, owner, names),
        "sources": sources,
        "generated": _plain(fm.get("generated")) or {"by": "kbe pages import", "at": date.today().isoformat()},
        "verified": [v for v in _plain(fm.get("verified")) or [] if isinstance(v, (str, dict))]
        if isinstance(fm.get("verified"), list) else [],
        "fields": _fields(fm, key, sources),
        "topics": sorted({t.lower() for t in _strings(fm.get("topics"))}) if topics is None else list(topics),
        "body": relink(body, lambda name: _owners_key(names, owner, name)),
        "restore": True,
        **({"template": _text(fm.get("template"))} if _text(fm.get("template")) else {}),
        **dates,
    }
    return Planned(rel, page, tuple(notes))


def _read(folder: Path, skip: Iterable[str], result: Plan) -> list[tuple[str, dict[str, Any], str]]:
    out = []
    for path in markdown_files(folder, skip):
        rel = path.relative_to(folder).as_posix()
        try:
            parsed = read_backup_file(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            parsed = None
        if parsed is None:
            result.skipped.append((rel, "not a backup page: no readable header"))
            continue
        out.append((rel, *parsed))
    return out


def _count(result: Plan, name: str) -> None:
    result.dropped_keys[name] = result.dropped_keys.get(name, 0) + 1


def plan_backup(folder: Path, *, owner: str, topics: Iterable[str] = (), keep_topics: bool = False,
                skip: Iterable[str] = (), drawers: Mapping[str, Drawer] | None = None) -> Plan:
    """What a restore of `folder` for `owner` would do. Reads files only."""
    if not folder.is_dir():
        raise KbeError(f"{folder} is not a folder.")
    known = dict(drawers or load_drawers())
    me = owner.strip().lower()
    chosen = sorted({t.strip().lower() for t in topics if t.strip()})
    page_topics = None if keep_topics and not chosen else chosen
    result = Plan()
    files = _read(folder, skip, result)
    names = _names(files)
    by_key: dict[str, Planned] = {}
    for rel, fm, body in files:
        key, who, kind = _text(fm.get("key")), _text(fm.get("owner")).lower(), _text(fm.get("type"))
        if not key or not who:
            result.skipped.append((rel, "not a backup page: no key or owner"))
        elif who != me:
            result.skipped.append((rel, f"another person's page ({who})"))
        elif kind not in known:
            result.skipped.append((rel, f'no drawer "{kind}"'))
        elif key.lower() in by_key:
            result.skipped.append((rel, f"same key {key.lower()} as {by_key[key.lower()].path}"))
        else:
            by_key[key.lower()] = _page(rel, fm, body, known[kind], me, names, page_topics)
            if fm.get("reviewed"):
                _count(result, "reviewed")
            if page_topics is not None and _strings(fm.get("topics")):
                _count(result, "topics")
    result.pages, result.splits = split_pages(by_key.values(), part_key_for(known), limit=MAX_BODY)
    return result
