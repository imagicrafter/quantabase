"""Steps of `kbe pages import` that work on planned pages, not files.

    combine      two pages become one: the kept page's body and the other's
                 under its own heading (a --map merge_into, or two files for
                 one meeting id)
    attendees    a meeting's attendees that match a person page in the same
                 import become `related` links; the rest go to the database,
                 which looks for the owner's existing person pages and keeps
                 any it cannot find as the field `attendees`

Pure functions: each returns new pages and never changes its input.
"""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Any, Iterable, Mapping

# The database refuses a longer page body (page_write, migration 0051). A body
# over it is split into linked parts (pages_import_split.py), never cut.
MAX_BODY = 200_000


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^0-9a-z]+", " ", text.lower())).strip()


def _union(first: Iterable[Any], second: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for item in [*first, *second]:
        if item not in out:
            out.append(item)
    return out


def _earliest(a: str | None, b: str | None) -> str | None:
    return min((d for d in (a, b) if d), default=None)


def _latest(a: str | None, b: str | None) -> str | None:
    return max((d for d in (a, b) if d), default=None)


def stamp(page: Mapping[str, Any]) -> str:
    """How new a page is: updated, else created, else its date field."""
    fields = page.get("fields") or {}
    return str(page.get("updated") or page.get("created") or fields.get("date") or "")


def merge_pages(keep, other, *, as_note: bool):
    """`keep` with `other` added. as_note: the other is a note under the kept
    body (two files for one meeting); else both bodies sit under headings
    (a page that already holds a merge only gets the new section)."""
    a, b = keep.page, other.page
    other_title = b["title"]
    origin = f"_From `{other.path}`" + (f", {stamp(b)[:10]}" if stamp(b) else "") + "._"
    section = f"## {'Note: ' if as_note else ''}{other_title}\n\n{origin}\n\n{b['body'].strip()}\n"
    if as_note or keep.merged:
        body = f"{a['body'].rstrip()}\n\n{section}"
    else:
        body = f"## {a['title']}\n\n_From `{keep.path}`._\n\n{a['body'].strip()}\n\n{section}"
    aliases = [x for x in _union(a["aliases"], [other_title, *b["aliases"]]) if x != a["title"]]
    page = {
        **a,
        "aliases": aliases,
        "description": a.get("description") or b.get("description"),
        "tags": _union(a["tags"], b["tags"]),
        "related": _union(a["related"], b["related"]),
        "sources": _union(a["sources"], b["sources"]),
        "fields": {**b["fields"], **a["fields"]},
        "attendees": _union(a.get("attendees", []), b.get("attendees", [])),
        "body": body,
    }
    created = _earliest(a.get("created"), b.get("created"))
    updated = _latest(a.get("updated"), b.get("updated"))
    page = {k: v for k, v in page.items() if k not in ("created", "updated", "attendees")} | (
        {"created": created, "updated": updated} if created or updated else {}) | (
        {"attendees": page["attendees"]} if page["attendees"] else {})
    return replace(keep, page=page, notes=keep.notes + other.notes,
                   merged=keep.merged + (other.path,) + other.merged)


def _people_index(pages: Iterable[Any]) -> tuple[dict[str, str], dict[str, set[str]]]:
    """(address -> key, name -> keys) over the people pages of an import."""
    by_email: dict[str, str] = {}
    by_name: dict[str, set[str]] = {}
    for planned in pages:
        page = planned.page
        if page["drawer"] != "people":
            continue
        key = page["key"]
        for address in [key, *(page["fields"].get("emails") or [])]:
            if "@" in address:
                by_email.setdefault(address.lower(), key)
        names = [page["title"], *page["aliases"]]
        if ":" in key:
            names.append(key.split(":", 1)[1])
        for name in names:
            if _norm(name):
                by_name.setdefault(_norm(name), set()).add(key)
    return by_email, by_name


def resolve_attendees(pages: list[Any]) -> tuple[list[Any], list[tuple[str, str, str]]]:
    """(pages, lines). A meeting's attendee found among the import's people
    pages becomes a related link; the rest stay in `attendees` for the
    database to look up. Each line is (path, attendee, key or "")."""
    by_email, by_name = _people_index(pages)
    out: list[Any] = []
    lines: list[tuple[str, str, str]] = []
    for planned in pages:
        attendees = planned.page.get("attendees") or []
        if not attendees:
            out.append(planned)
            continue
        linked: list[str] = []
        left: list[str] = []
        for name in attendees:
            key = by_email.get(name.lower())
            if key is None:
                keys = by_name.get(_norm(name), set())
                key = next(iter(keys)) if len(keys) == 1 else None
            lines.append((planned.path, name, key or ""))
            if key and key not in linked:
                linked.append(key)
            elif not key and name not in left:
                left.append(name)
        page = {k: v for k, v in planned.page.items() if k != "attendees"}
        page["related"] = _union(page["related"], linked)
        if left:
            page["attendees"] = left
        out.append(replace(planned, page=page))
    return out, lines
