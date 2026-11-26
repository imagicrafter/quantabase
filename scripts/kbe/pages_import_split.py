"""Split a page body that is over the database's limit into linked parts.

The database refuses a page body over MAX_BODY characters (page_write,
migration 0051). An import never cuts text to fit: a longer body becomes
parts of at most PART_SIZE characters each, cut at line ends (a single line
longer than a part is the only thing ever cut inside a line).

    part 1      the page itself: its key, title, aliases, fields, sources
    parts 2..n  "<title> (part N)", a key of their own from the drawer's key
                rule (the caller's `key_for`; for a meeting, never the
                meeting id), the same status, dates, tags, topics and
                `date` field, an import source, and nothing to match on
                (no aliases, addresses or domains), so the database can
                never take a part for part 1 or for another page

Each part but the first starts with "> Continued from [[key|title]]" and
each but the last ends with "> Continued in [[key|title]]". The link names
the key, so it resolves exactly in the database, the app and the backup.
`join_parts` takes the link lines off and gives the original back exactly.

Pure functions: each returns new values and never changes its input.
"""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Any, Callable, Iterable, Sequence

from .pages_import_combine import MAX_BODY

# Characters of body per part. Leaves 10,000 under MAX_BODY for the two link
# lines (each at most ~530: a 200-character key and a 300-character title).
PART_SIZE = 190_000
MAX_TITLE = 300
MAX_KEY = 200
_SEP = "\n\n"
_HEAD = re.compile(r"\A> Continued from \[\[[^\]\n]*\]\]\n\n")
_TAIL = re.compile(r"\n\n> Continued in \[\[[^\]\n]*\]\]\Z")
_LINK = re.compile(r"\A(> Continued (?:from|in) \[\[)([^\]|\n]+)(\|[^\]\n]*\]\])\Z")
_UNSAFE = re.compile(r"[\[\]|\r\n]+")

KeyFor = Callable[[dict[str, Any], str], str]


def _lines(text: str) -> list[str]:
    """The text's lines, each with its own "\\n" (the last may have none)."""
    return [line for line in re.split(r"(?<=\n)", text) if line]


def _pieces(line: str, size: int) -> list[str]:
    return [line[i:i + size] for i in range(0, len(line), size)] or [line]


def split_text(text: str, size: int = PART_SIZE) -> tuple[str, ...]:
    """`text` in pieces of at most `size` characters, cut at line ends."""
    if len(text) <= size:
        return (text,)
    out: list[str] = []
    current: list[str] = []
    length = 0
    for piece in (p for line in _lines(text) for p in _pieces(line, size)):
        if length + len(piece) > size and current:
            out.append("".join(current))
            current, length = [], 0
        current.append(piece)
        length += len(piece)
    return tuple(out + ["".join(current)])


def part_title(title: str, number: int) -> str:
    suffix = f" (part {number})"
    return title[: MAX_TITLE - len(suffix)].rstrip() + suffix


def link_line(direction: str, key: str, title: str) -> str:
    """"> Continued from|in [[key|title]]", the title made safe inside a link."""
    shown = re.sub(r"\s+", " ", _UNSAFE.sub(" ", title)).strip() or key
    return f"> Continued {direction} [[{key}|{shown}]]"


def join_parts(bodies: Sequence[str]) -> str:
    """The original body: the parts joined, without their link lines."""
    last = len(bodies) - 1
    out = []
    for i, body in enumerate(bodies):
        text = _HEAD.sub("", body, count=1) if i > 0 else body
        out.append(_TAIL.sub("", text, count=1) if i < last else text)
    return "".join(out)


def relink(body: str, resolve: Callable[[str], str | None]) -> str:
    """The body with the target of its first and last continuation line set
    back to a key (`resolve` maps a backup file name to a key, or None)."""
    lines = body.split("\n")
    ends = sorted({0, len(lines) - 1})

    def fix(line: str) -> str:
        match = _LINK.match(line)
        key = resolve(match.group(2).strip()) if match else None
        return f"{match.group(1)}{key}{match.group(3)}" if match and key else line

    return "\n".join(fix(line) if i in ends else line for i, line in enumerate(lines))


def _unique(wanted: str, taken: set[str], limit: int) -> str:
    """`wanted` (cut to `limit`), or `wanted` with -2, -3 ... when taken."""
    first = wanted[:limit]
    if first.lower() not in taken:
        return first
    number = 2
    while f"{wanted[: limit - len(str(number)) - 1]}-{number}".lower() in taken:
        number += 1
    return f"{wanted[: limit - len(str(number)) - 1]}-{number}"


def _name(title: str) -> str:
    """How the database compares names (0067's _name_norm)."""
    return re.sub(r"\s+", " ", re.sub(r"[\W_]+", " ", title.lower())).strip()


def _unique_title(title: str, taken: set[str]) -> str:
    if _name(title) not in taken:
        return title
    number = 2
    while _name(f"{title} ({number})") in taken:
        number += 1
    return f"{title[: MAX_TITLE - len(str(number)) - 3]} ({number})"


def _part_page(first: dict[str, Any], path: str, key: str, title: str) -> dict[str, Any]:
    fields = first.get("fields") or {}
    page = {
        "key": key, "drawer": first["drawer"], "title": title, "aliases": [],
        "description": None, "status": first["status"], "tags": list(first["tags"]),
        "related": [], "sources": [{"source": "import", "source_id": path}],
        "generated": first.get("generated"), "verified": [],
        "fields": {"date": fields["date"]} if fields.get("date") else {},
        "topics": list(first["topics"]),
    }
    carried = {k: first[k] for k in ("created", "updated", "template", "restore") if first.get(k)}
    return {**page, **carried}


def _names_for(planned: Any, count: int, key_for: KeyFor, keys: set[str],
               titles: set[str]) -> list[tuple[str, str]]:
    """(key, title) of every part; part 1 is the page's own."""
    page = planned.page
    out = [(page["key"], page["title"])]
    for number in range(2, count + 1):
        title = _unique_title(part_title(page["title"], number), titles)
        key = _unique(key_for(page, title), keys, MAX_KEY)
        keys.add(key.lower())
        titles.add(_name(title))
        out.append((key, title))
    return out


def _bodies(chunks: Sequence[str], names: Sequence[tuple[str, str]]) -> list[str]:
    last = len(chunks) - 1
    return [
        (link_line("from", *names[i - 1]) + _SEP if i > 0 else "")
        + chunk
        + (_SEP + link_line("in", *names[i + 1]) if i < last else "")
        for i, chunk in enumerate(chunks)
    ]


def split_page(planned: Any, key_for: KeyFor, keys: set[str], titles: set[str], *,
               limit: int = MAX_BODY, size: int = PART_SIZE) -> tuple[Any, ...]:
    """The page, or its parts when the body is over `limit`. `keys` and
    `titles` (taken so far, lower case / name form) are added to."""
    body = planned.page["body"]
    if len(body) <= limit:
        return (planned,)
    chunks = split_text(body, size)
    names = _names_for(planned, len(chunks), key_for, keys, titles)
    bodies = _bodies(chunks, names)
    first = replace(planned, page={**planned.page, "body": bodies[0]})
    rest = tuple(
        replace(planned, path=f"{planned.path} (part {i})", notes=(), merged=(),
                page={**_part_page(planned.page, planned.path, key, title), "body": text})
        for i, ((key, title), text) in enumerate(zip(names[1:], bodies[1:]), start=2)
    )
    return (first, *rest)


def split_pages(pages: Iterable[Any], key_for: KeyFor, *, limit: int = MAX_BODY,
                size: int = PART_SIZE) -> tuple[list[Any], list[tuple[str, int]]]:
    """(pages, splits): every page over `limit` as linked parts, and one
    (path, number of parts) per page split."""
    given = list(pages)
    keys = {p.page["key"].lower() for p in given}
    titles = {_name(p.page["title"]) for p in given}
    out: list[Any] = []
    splits: list[tuple[str, int]] = []
    for planned in given:
        parts = split_page(planned, key_for, keys, titles, limit=limit, size=size)
        out.extend(parts)
        if len(parts) > 1:
            splits.append((planned.path, len(parts)))
    return out, splits
