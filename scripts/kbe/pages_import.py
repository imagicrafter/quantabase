"""Read an existing Markdown wiki (OKF / Obsidian vault) into Engine pages.

No I/O but reading the folder and the entity templates. `plan(folder, ...)`
returns one `Planned` page per file it can file, and the reasons it skipped
the rest; `pages.py` prints the report and, after a yes, saves each page with
`page_import` (supabase/migrations/0056_backup_import.sql).

Mapping, per file:
  drawer      the frontmatter `type` (person -> people, meeting -> meetings,
              ...), else the folder name; a file that maps to no drawer in
              any template is skipped and listed
  key         by the drawer's key rule in engine/templates/entities:
                email      `email` in the frontmatter, else person:<slug>
                domain     `domain` / `website` / `url`, else org:<slug>
                source_id  meeting:<fireflies_id / meeting_id / id>, else
                           meeting:<date>-<slug>
                slug       the rule's own prefix + a slug of the title
              (a fallback key is reported, so it can be fixed later)
  header      title, aliases, description (or `summary`), status, tags,
              related (titles from [[links]]), sources (plus the meeting's
              fireflies_id), and the drawer's own fields (any template's;
              company/org -> organisation)
  dates       created / updated (else timestamp, modified, last_updated)
              become the page's own dates (page_import, migration 0074)
  attendees   a meeting's attendees: a person page in this import -> a
              link; the rest are looked up by the database (0074)
  body        everything after the frontmatter, unchanged ([[links]] are
              resolved to keys by the database when each page is saved);
              over the database's 200,000 characters it is split into
              linked parts, never shortened (pages_import_split.py)
Two files for one meeting id become one page: the newer, with the other as a
note section (split afterwards, if that makes it too long). An optional map (pages_import_map.py) refiles files, merges two
files into one page and adds pages with no file. Other frontmatter keys are
dropped and counted in the report. Topics are only those given with --topic:
nothing is shared by an import unless asked.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from .errors import KbeError
from . import pages_import_map as import_map
from .pages_import_combine import MAX_BODY, merge_pages, resolve_attendees, stamp
from .pages_import_split import MAX_TITLE, KeyFor, split_pages

TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "engine" / "templates" / "entities"
SKIP_DIRS = frozenset({"templates", "sources", "excalidraw", "diagrams", "attachments", "assets"})
SKIP_FILES = frozenset({"index.md", "log.md", "readme.md", "claude.md", "agents.md"})
MAX_DESCRIPTION = 500
STATUSES = ("draft", "unreviewed", "current")

# Frontmatter `type` (or folder name) -> drawer id.
TYPE_TO_DRAWER = {
    "person": "people", "people": "people", "contact": "people",
    "organisation": "organisations", "organization": "organisations",
    "organisations": "organisations", "organizations": "organisations",
    "company": "organisations", "companies": "organisations", "org": "organisations",
    "project": "projects", "projects": "projects",
    "meeting": "meetings", "meetings": "meetings",
    "decision": "decisions", "decisions": "decisions", "adr": "decisions",
    "concept": "concepts", "concepts": "concepts", "reference": "concepts", "note": "concepts",
    "research": "research",
    "playbook": "playbooks", "playbooks": "playbooks", "runbook": "playbooks",
    "retrospective": "playbooks", "incident": "playbooks", "guide": "playbooks",
    "deal": "deals", "deals": "deals", "offer": "offers", "offers": "offers",
    "property": "properties", "properties": "properties", "site": "sites", "sites": "sites",
    "vendor": "vendors", "vendors": "vendors", "program": "programs", "programs": "programs",
}
FALLBACK_PREFIX = {"email": "person", "domain": "org", "source_id": "meeting"}
_EMAIL = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}")
_DOMAIN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}")
_PREFIX = re.compile(r'^"?([a-z][a-z-]*):')
_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.S)
_LINK = re.compile(r"^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$")


@dataclass(frozen=True)
class Drawer:
    id: str
    key_kind: str
    prefix: str | None
    fields: tuple[str, ...]


@dataclass(frozen=True)
class Planned:
    path: str
    page: dict[str, Any]
    notes: tuple[str, ...] = ()
    merged: tuple[str, ...] = ()


@dataclass
class Plan:
    pages: list[Planned] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    dropped_keys: dict[str, int] = field(default_factory=dict)
    map_lines: list[str] = field(default_factory=list)
    combined: list[tuple[str, str, str]] = field(default_factory=list)
    attendees: list[tuple[str, str, str]] = field(default_factory=list)
    splits: list[tuple[str, int]] = field(default_factory=list)

    def by_drawer(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for p in self.pages:
            counts[p.page["drawer"]] = counts.get(p.page["drawer"], 0) + 1
        return dict(sorted(counts.items()))


def load_drawers(directory: Path = TEMPLATES_DIR) -> dict[str, Drawer]:
    """Every drawer in every template. The first template naming a drawer
    gives its key rule (base first); its fields are those of every template."""
    import yaml

    files = sorted(directory.glob("*.yaml"), key=lambda p: (p.stem != "base", p.stem))
    if not files:
        raise KbeError(f"No entity templates found in {directory}.")
    drawers: dict[str, Drawer] = {}
    for path in files:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for d in loaded.get("drawers") or []:
            rule = d.get("key_rule") or {}
            prefix = _PREFIX.match(str(rule.get("text") or ""))
            names = tuple(str(f["name"]) for f in d.get("fields") or [])
            known = drawers.get(d["id"])
            drawers[d["id"]] = Drawer(
                id=d["id"], key_kind=str(rule.get("kind") or "slug"),
                prefix=prefix.group(1) if prefix else None, fields=names,
            ) if known is None else Drawer(
                id=known.id, key_kind=known.key_kind, prefix=known.prefix,
                fields=known.fields + tuple(n for n in names if n not in known.fields),
            )
    return drawers


def slug(text: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return out[:150].strip("-") or "untitled"


def _text(value: Any) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return "" if value is None else str(value).strip()


def _list(value: Any) -> list[str]:
    if value is None:
        return []
    items = value if isinstance(value, list) else re.split(r"[,\s]+", str(value))
    return [t for t in (_text(v) for v in items) if t]


def _link_target(text: str) -> str:
    match = _LINK.match(text.strip())
    return (match.group(1) if match else text).strip()


def split_frontmatter(text: str) -> tuple[dict[str, Any], str, str | None]:
    """(frontmatter, body, problem). A file with no frontmatter has an empty one."""
    import yaml

    match = _FRONTMATTER.match(text)
    if not match:
        return {}, text, None
    try:
        loaded = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return {}, text, "the frontmatter is not valid YAML"
    if loaded is None:
        loaded = {}
    if not isinstance(loaded, dict):
        return {}, text, "the frontmatter is not a mapping"
    return {str(k): v for k, v in loaded.items()}, match.group(2), None


def _drawer_for(fm: Mapping[str, Any], rel: Path, drawers: Mapping[str, Drawer]) -> str | None:
    for raw in (_text(fm.get("type")).lower(), rel.parts[0].lower() if len(rel.parts) > 1 else ""):
        drawer = TYPE_TO_DRAWER.get(raw, raw if raw in drawers else None)
        if drawer in drawers:
            return drawer
    return None


def _emails(fm: Mapping[str, Any]) -> list[str]:
    found: list[str] = []
    for name in ("email", "emails", "email_address"):
        for value in _list(fm.get(name)):
            if _EMAIL.fullmatch(value.lower()) and value.lower() not in found:
                found.append(value.lower())
    return found


def _domains(fm: Mapping[str, Any]) -> list[str]:
    found: list[str] = []
    for name in ("domain", "domains", "website", "url", "web"):
        for value in _list(fm.get(name)):
            host = re.sub(r"^[a-z]+://", "", value.lower()).split("/")[0].removeprefix("www.")
            if _DOMAIN.fullmatch(host) and host not in found:
                found.append(host)
    return found


def _first_email(fm: Mapping[str, Any]) -> str | None:
    return next(iter(_emails(fm)), None)


def _first_domain(fm: Mapping[str, Any]) -> str | None:
    return next(iter(_domains(fm)), None)


def _identities(drawer: Drawer, fm: Mapping[str, Any]) -> dict[str, list[str]]:
    """Every other address (people) or domain (organisations): the page's identities,
    which the database matches on so a second page is never made for them (0067)."""
    if drawer.key_kind == "email":
        more = _emails(fm)[1:]
        return {"emails": more} if more else {}
    if drawer.key_kind == "domain":
        more = _domains(fm)[1:]
        return {"domains": more} if more else {}
    return {}


def derive_key(drawer: Drawer, fm: Mapping[str, Any], title: str) -> tuple[str, str | None]:
    """(key, note). The note says when the template's rule could not be met."""
    if drawer.key_kind == "email":
        found = _first_email(fm)
        if found:
            return found, None
        return f"person:{slug(title)}", "no email in the frontmatter: key person:<name> used"
    if drawer.key_kind == "domain":
        found = _first_domain(fm)
        if found:
            return found, None
        return f"org:{slug(title)}", "no domain in the frontmatter: key org:<name> used"
    if drawer.key_kind == "source_id":
        for name in ("fireflies_id", "meeting_id", "source_id", "id"):
            value = _text(fm.get(name))
            if value:
                return f"{drawer.prefix or 'meeting'}:{slug(value)}", None
        when = _text(fm.get("date"))[:10]
        stem = f"{when}-{slug(title)}" if when else slug(title)
        return f"{drawer.prefix or 'meeting'}:{stem}", "no meeting id: key from date and title"
    return f"{drawer.prefix or drawer.id.rstrip('s')}:{slug(title)}", None


def part_key_for(drawers: Mapping[str, Drawer]) -> KeyFor:
    """The key of a page's part 2..n, by its drawer's rule for a page with
    only that title (and, for a meeting, its date): never part 1's meeting
    id, address or domain, so a part can never become part 1."""
    def key_for(page: Mapping[str, Any], title: str) -> str:
        drawer = drawers[page["drawer"]]
        when = _text((page.get("fields") or {}).get("date")) or _text(page.get("created"))
        fm = {"date": when} if drawer.key_kind == "source_id" and when else {}
        return derive_key(drawer, fm, title)[0]
    return key_for


HEADER_KEYS = frozenset({
    "title", "aliases", "description", "type", "status", "tags", "related", "sources", "verified",
    "email", "emails", "email_address", "domain", "domains", "website", "url", "web",
    "created", "date_created", "updated", "modified", "last_updated", "timestamp",
})
CREATED_KEYS = ("created", "date_created", "timestamp")
UPDATED_KEYS = ("updated", "modified", "last_updated", "timestamp")
MEETING_ID_KEYS = ("fireflies_id", "meeting_id", "source_id", "id")
# A template field -> other frontmatter names that mean the same.
FIELD_ALIASES = {"organisation": ("organization", "company", "org")}


def _when(value: Any) -> datetime | None:
    """A frontmatter date or time, in UTC (a date is its midnight UTC)."""
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, date):
        moment = datetime(value.year, value.month, value.day)
    else:
        text = _text(value)
        try:
            moment = datetime.fromisoformat(text.replace("Z", "+00:00")) if text else None
        except ValueError:
            moment = None
    if moment is None:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


def _dates(fm: Mapping[str, Any]) -> tuple[dict[str, str], list[str]]:
    """({created, updated} as ISO times, notes). One date found stands for both."""
    notes: list[str] = []
    now = datetime.now(timezone.utc)
    found = {}
    for name, keys in (("created", CREATED_KEYS), ("updated", UPDATED_KEYS)):
        moment = next((m for m in (_when(fm.get(k)) for k in keys) if m), None)
        if moment and moment > now:
            notes.append(f"{name} date is in the future: not kept")
            moment = None
        if moment:
            found[name] = moment
    if not found:
        return {}, notes
    created = found.get("created") or found["updated"]
    updated = found.get("updated") or created
    if created > updated:
        notes.append("created is later than updated: the later date is used for both")
        updated = created
    return {"created": created.isoformat(), "updated": updated.isoformat()}, notes


def _attendees(value: Any) -> list[str]:
    """Names or addresses, from a list or a comma/semicolon separated string."""
    items = value if isinstance(value, list) else re.split(r"[,;]", _text(value))
    out: list[str] = []
    for item in items:
        name = _link_target(_text(item))[:300]
        if name and name not in out:
            out.append(name)
    return out


def _field_value(fm: Mapping[str, Any], name: str) -> tuple[str | None, Any]:
    """The frontmatter value for a template field. `field_<name>` first (the
    backup's spelling when a field shares a header line's name); a `status`
    that is a page status is the page's, never the field's."""
    for source in (f"field_{name}", name, *FIELD_ALIASES.get(name, ())):
        value = fm.get(source)
        if value is None or value == "" or value == []:
            continue
        if source == "status" and _text(value).lower() in STATUSES:
            continue
        return source, value
    return None, None


def _fields(drawer: Drawer, fm: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in drawer.fields:
        _, value = _field_value(fm, name)
        if value is None:
            continue
        out[name] = _text(value) if not isinstance(value, (int, float, bool)) else value
    return out


def used_keys(drawer: Drawer, fm: Mapping[str, Any]) -> set[str]:
    """The frontmatter keys a page carries over (the rest are reported)."""
    used = set(HEADER_KEYS) | set(drawer.fields)
    used |= {s for s in (_field_value(fm, n)[0] for n in drawer.fields) if s}
    if not _text(fm.get("description")) and _text(fm.get("summary")):
        used.add("summary")
    if drawer.key_kind == "source_id":
        used |= set(MEETING_ID_KEYS) | {"attendees"}
    return used


def _key_and_identities(drawer: Drawer, fm: Mapping[str, Any], title: str,
                        key: str | None) -> tuple[str, dict[str, list[str]], str | None]:
    if key is None:
        derived, note = derive_key(drawer, fm, title)
        return derived, _identities(drawer, fm), note
    found = _emails(fm) if drawer.key_kind == "email" else _domains(fm) if drawer.key_kind == "domain" else []
    others = [x for x in found if x != key]
    name = "emails" if drawer.key_kind == "email" else "domains"
    return key, ({name: others} if others else {}), None


def _sources(rel: Path, fm: Mapping[str, Any], drawer: Drawer) -> list[dict[str, str]]:
    sources = [{"source": "import", "source_id": rel.as_posix()}]
    listed = fm.get("sources")
    for item in listed if isinstance(listed, list) else _list(listed):
        if isinstance(item, dict):
            sources.append(dict(item))  # already {source, source_id, ...}: kept as it is
        elif _text(item):
            sources.append({"source": "import", "source_id": _text(item)})
    fireflies = _text(fm.get("fireflies_id"))
    if drawer.key_kind == "source_id" and fireflies:
        sources.append({"source": "fireflies", "source_id": fireflies})
    return sources


def _page(rel: Path, fm: Mapping[str, Any], body: str, drawer: Drawer, topics: list[str],
          entry: import_map.Entry | None = None) -> Planned:
    notes: list[str] = []
    title = (_text(fm.get("title")) or rel.stem).strip()[:MAX_TITLE]
    key, identities, note = _key_and_identities(drawer, fm, title, entry.key if entry else None)
    if note:
        notes.append(note)
    description = re.sub(r"\s+", " ", _text(fm.get("description")) or _text(fm.get("summary")))
    if len(description) > MAX_DESCRIPTION:
        description = description[: MAX_DESCRIPTION - 1].rstrip() + "…"
        notes.append("description shortened to 500 characters")
    dates, date_notes = _dates(fm)
    notes += date_notes
    status = _text(fm.get("status")).lower()
    aliases = [a for a in _list(fm.get("aliases")) + list(entry.aliases if entry else ()) if a != title]
    attendees = _attendees(fm.get("attendees")) if drawer.key_kind == "source_id" else []
    page = {
        "key": key[:200],
        "drawer": drawer.id,
        "title": title,
        "aliases": list(dict.fromkeys(aliases)),
        "description": description or None,
        "status": status if status in STATUSES else "unreviewed",
        "tags": [t.lstrip("#") for t in _list(fm.get("tags"))],
        "related": [_link_target(r) for r in _list(fm.get("related"))],
        "sources": _sources(rel, fm, drawer),
        "generated": {"by": "kbe pages import", "at": date.today().isoformat()},
        "verified": [v for v in fm.get("verified") or [] if isinstance(v, (str, dict))]
        if isinstance(fm.get("verified"), list) else [],
        "fields": {**_fields(drawer, fm), **identities},
        "topics": list(topics),
        "body": body.lstrip("\n"),
        **dates,
        **({"attendees": attendees} if attendees else {}),
    }
    return Planned(rel.as_posix(), page, tuple(notes))


def _stub(item: import_map.Create, topics: list[str]) -> Planned:
    page = {
        "key": item.key, "drawer": item.drawer, "title": item.name,
        "aliases": [a for a in item.aliases if a != item.name], "description": None,
        "status": "unreviewed", "tags": [], "related": [],
        "sources": [{"source": "import", "source_id": "map"}],
        "generated": {"by": "kbe pages import", "at": date.today().isoformat()},
        "verified": [], "fields": {}, "topics": list(topics), "body": "",
    }
    return Planned(f"(map) {item.name}", page, ("made from the map: no wiki file",))


def markdown_files(folder: Path, skip: Iterable[str] = ()) -> list[Path]:
    skipped = SKIP_DIRS | {s.lower() for s in skip}
    found = []
    for path in sorted(folder.rglob("*.md")):
        rel = path.relative_to(folder)
        if any(part.startswith(".") or part.lower() in skipped for part in rel.parts[:-1]):
            continue
        if len(rel.parts) == 1 and rel.name.lower() in SKIP_FILES:
            continue
        found.append(path)
    return found


def _read(folder: Path, files: list[Path], result: Plan) -> list[tuple[Path, dict[str, Any], str]]:
    """(relative path, frontmatter, body) for every file that reads cleanly."""
    out = []
    for path in files:
        rel = path.relative_to(folder)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            result.skipped.append((rel.as_posix(), "could not be read as UTF-8 text"))
            continue
        fm, body, problem = split_frontmatter(text)
        if problem:
            result.skipped.append((rel.as_posix(), problem))
            continue
        out.append((rel, fm, body))
    return out


def _count_dropped(result: Plan, drawer: Drawer, fm: Mapping[str, Any]) -> None:
    used = used_keys(drawer, fm)
    for name in fm:
        if name not in used:
            result.dropped_keys[name] = result.dropped_keys.get(name, 0) + 1


def _by_key(drafts: Iterable[Planned], known: Mapping[str, Drawer], result: Plan) -> dict[str, Planned]:
    """One page per key. Two files for one meeting id: the newer, with the
    other as a note section. Any other repeated key: the later file is skipped."""
    pages: dict[str, Planned] = {}
    for planned in drafts:
        key = planned.page["key"]
        first = pages.get(key)
        if first is None:
            pages[key] = planned
            continue
        meeting = known[planned.page["drawer"]].key_kind == "source_id"
        if not (meeting and first.page["drawer"] == planned.page["drawer"]):
            result.skipped.append((planned.path, f"same key {key} as {first.path}"))
            continue
        newer, older = sorted((first, planned), key=lambda p: (stamp(p.page), p.path), reverse=True)
        pages[key] = merge_pages(newer, older, as_note=True)
        result.combined.append((older.path, newer.path, f"same meeting id {key}: a note on the newer page"))
    return pages


BACKUP_MARKER = "Generated by the Engine's nightly backup"


def is_backup(folder: Path) -> bool:
    """True for a checkout of the Engine's nightly backup (its index.md says so)."""
    index = folder / "index.md"
    try:
        return index.is_file() and BACKUP_MARKER in index.read_text(encoding="utf-8")[:2000]
    except (OSError, UnicodeDecodeError):
        return False


def plan(folder: Path, *, topics: Iterable[str] = (), skip: Iterable[str] = (),
         drawers: Mapping[str, Drawer] | None = None, map_file: Path | None = None) -> Plan:
    """What an import of `folder` would do. Reads files only."""
    if not folder.is_dir():
        raise KbeError(f"{folder} is not a folder.")
    if is_backup(folder):
        raise KbeError(f"{folder} is an Engine backup. Restore it with --from-backup, which keeps "
                       "each page's key and files only the --owner's pages.")
    known = dict(drawers or load_drawers())
    chosen_topics = sorted({t.strip().lower() for t in topics if t.strip()})
    files = markdown_files(folder, skip)
    the_map = (import_map.load(map_file, {p.relative_to(folder).as_posix() for p in files}, known)
               if map_file else import_map.ImportMap())
    result = Plan(map_lines=import_map.describe(the_map))
    drafts: dict[str, Planned] = {}
    joining: list[tuple[Path, dict[str, Any], str, str]] = []
    for rel, fm, body in _read(folder, files, result):
        entry = the_map.files.get(rel.as_posix())
        if entry and entry.merge_into:
            joining.append((rel, fm, body, entry.merge_into))
            continue
        drawer_id = entry.drawer if entry and entry.drawer else _drawer_for(fm, rel, known)
        if drawer_id is None:
            what = _text(fm.get("type")) or rel.parts[0]
            result.skipped.append((rel.as_posix(), f'no drawer for type "{what}"'))
            continue
        drafts[rel.as_posix()] = _page(rel, fm, body, known[drawer_id], chosen_topics, entry)
        _count_dropped(result, known[drawer_id], fm)
    for rel, fm, body, target in joining:
        into = drafts.get(target)
        if into is None:
            result.skipped.append((rel.as_posix(), f"merge_into {target} is not imported"))
            continue
        drawer = known[into.page["drawer"]]
        other = _page(rel, fm, body, drawer, chosen_topics)
        other = replace(other, notes=tuple(n for n in other.notes if "key" not in n))
        drafts = {**drafts, target: merge_pages(into, other, as_note=False)}
        _count_dropped(result, drawer, fm)
        result.combined.append((rel.as_posix(), target, "merged by the map"))
    pages = _by_key(drafts.values(), known, result)
    for item in the_map.create:
        if item.key in pages:
            result.skipped.append((f"(map) {item.name}", f"same key {item.key} as {pages[item.key].path}"))
            continue
        pages = {**pages, item.key: _stub(item, chosen_topics)}
    split, result.splits = split_pages(pages.values(), part_key_for(known), limit=MAX_BODY)
    planned, result.attendees = resolve_attendees(split)
    result.pages = mark_key_only(planned, known)
    return result


def mark_key_only(planned: Iterable[Planned], known: Mapping[str, Drawer]) -> list[Planned]:
    """Pages whose drawer is keyed by a source id (a meeting) are sent with
    `key_only: true`: the database (migration 0079) then looks for that key
    alone, never another page with the same name. A weekly meeting keeps its
    title but each one has its own id or date, and is its own page."""
    return [replace(p, page={**p.page, "key_only": True})
            if known[p.page["drawer"]].key_kind == "source_id" else p
            for p in planned]
