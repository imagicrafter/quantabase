"""The optional `--map` file of `kbe pages import`: refile, merge, create.

    files:
      "companies/Acme.md":                 # a path in the wiki folder
        drawer: organisations
        key: acme.com                      # the drawer's key rule (a domain here)
        aliases: [Acme Corp]
      "notes/Acme prep.md":
        merge_into: "companies/Acme.md"    # one page with both bodies
    create:                                # pages with no wiki file
      - name: Globex
        domain: globex.com
        aliases: [Globex Corp]
        drawer: organisations              # optional; organisations by default

Only reads and checks the file; pages_import.plan applies it. Every problem
is listed at once, so the file can be fixed in one go.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .errors import KbeError

_EMAIL = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}")
_DOMAIN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}")
_KEY = re.compile(r"[a-z0-9][a-z0-9:._@/-]{0,199}")
_ENTRY_KEYS = frozenset({"drawer", "key", "aliases", "merge_into"})
_CREATE_KEYS = frozenset({"name", "domain", "key", "aliases", "drawer"})


@dataclass(frozen=True)
class Entry:
    drawer: str | None = None
    key: str | None = None
    aliases: tuple[str, ...] = ()
    merge_into: str | None = None


@dataclass(frozen=True)
class Create:
    drawer: str
    key: str
    name: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class ImportMap:
    files: Mapping[str, Entry] = field(default_factory=dict)
    create: tuple[Create, ...] = ()


def _aliases(value: Any, where: str, problems: list[str]) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(a, str) and a.strip() for a in value):
        problems.append(f"{where}: aliases must be a list of names")
        return ()
    return tuple(a.strip() for a in value)


def check_key(kind: str, key: str) -> str | None:
    """Why `key` does not fit a drawer whose key rule is `kind`, or None."""
    if kind == "email" and not _EMAIL.fullmatch(key):
        return "must be an email address"
    if kind == "domain" and not _DOMAIN.fullmatch(key):
        return "must be a web domain such as example.com"
    if not _KEY.fullmatch(key):
        return "must be lower case, no spaces, at most 200 characters"
    return None


def _drawer(value: Any, where: str, drawers: Mapping[str, Any], problems: list[str]) -> str | None:
    if value is None:
        return None
    if value not in drawers:
        problems.append(f"{where}: no drawer {value!r} (one of {', '.join(sorted(drawers))})")
        return None
    return str(value)


def _key(value: Any, drawer: str | None, where: str, drawers: Mapping[str, Any],
         problems: list[str]) -> str | None:
    if value is None:
        return None
    key = str(value).strip().lower()
    kind = drawers[drawer].key_kind if drawer in drawers else "slug"
    why = check_key(kind, key)
    if why:
        problems.append(f"{where}: key {key!r} {why}")
        return None
    return key


def _entries(raw: Any, folder_paths: set[str], drawers: Mapping[str, Any],
             problems: list[str]) -> dict[str, Entry]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        problems.append("files: must be a mapping of wiki path -> entry")
        return {}
    entries: dict[str, Entry] = {}
    for path, spec in raw.items():
        path = str(path).strip().removeprefix("./")
        where = f"files.{path}"
        if path not in folder_paths:
            problems.append(f"{where}: no such Markdown file in the folder")
        if not isinstance(spec, dict) or set(spec) - _ENTRY_KEYS:
            extra = sorted(set(spec) - _ENTRY_KEYS) if isinstance(spec, dict) else []
            problems.append(f"{where}: use only drawer, key, aliases, merge_into"
                            + (f" (not {', '.join(extra)})" if extra else ""))
            continue
        merge_into = str(spec["merge_into"]).strip().removeprefix("./") if spec.get("merge_into") else None
        drawer = _drawer(spec.get("drawer"), where, drawers, problems)
        if merge_into and (drawer or spec.get("key")):
            problems.append(f"{where}: merge_into takes no drawer or key (the page it joins has them)")
        entries[path] = Entry(
            drawer=drawer, key=_key(spec.get("key"), drawer, where, drawers, problems),
            aliases=_aliases(spec.get("aliases"), where, problems), merge_into=merge_into)
    for path, entry in entries.items():
        target = entry.merge_into
        if target is None:
            continue
        if target == path:
            problems.append(f"files.{path}: cannot merge into itself")
        elif target not in folder_paths:
            problems.append(f"files.{path}: merge_into {target!r} is not a Markdown file in the folder")
        elif entries.get(target, Entry()).merge_into:
            problems.append(f"files.{path}: {target!r} is itself merged into another page; "
                            "merge into that page instead")
    return entries


def _creates(raw: Any, drawers: Mapping[str, Any], problems: list[str]) -> tuple[Create, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        problems.append("create: must be a list of pages")
        return ()
    out: list[Create] = []
    for i, spec in enumerate(raw, 1):
        where = f"create #{i}"
        if not isinstance(spec, dict) or set(spec) - _CREATE_KEYS:
            problems.append(f"{where}: use only name, domain (or key), aliases, drawer")
            continue
        name = str(spec.get("name") or "").strip()
        if not name:
            problems.append(f"{where}: needs a name")
        drawer = _drawer(spec.get("drawer", "organisations"), where, drawers, problems)
        key = _key(spec.get("key") or spec.get("domain"), drawer, where, drawers, problems)
        if spec.get("key") is None and spec.get("domain") is None:
            problems.append(f"{where}: needs a domain (or key)")
        aliases = _aliases(spec.get("aliases"), where, problems)
        if name and drawer and key:
            out.append(Create(drawer=drawer, key=key, name=name[:300], aliases=aliases))
    return tuple(out)


def load(path: Path, folder_paths: set[str], drawers: Mapping[str, Any]) -> ImportMap:
    """The checked map, or a KbeError listing every problem in it."""
    import yaml

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, UnicodeDecodeError) as error:
        raise KbeError(f"Could not read the map file {path}: {error}") from error
    except yaml.YAMLError as error:
        raise KbeError(f"The map file {path} is not valid YAML: {error}") from error
    if not isinstance(raw, dict) or set(raw) - {"files", "create"}:
        raise KbeError(f"The map file {path} must have only `files:` and `create:`.")
    problems: list[str] = []
    result = ImportMap(files=_entries(raw.get("files"), folder_paths, drawers, problems),
                       create=_creates(raw.get("create"), drawers, problems))
    if problems:
        raise KbeError(f"The map file {path} has problems:\n" + "\n".join(f"  {p}" for p in problems))
    return result


def describe(import_map: ImportMap) -> list[str]:
    """One line per map entry, for the dry run."""
    lines: list[str] = []
    for path, entry in sorted(import_map.files.items()):
        if entry.merge_into:
            lines.append(f"  {path} -> merged into {entry.merge_into}")
            continue
        parts = [p for p in (entry.drawer, entry.key) if p]
        alias = f" (aliases: {', '.join(entry.aliases)})" if entry.aliases else ""
        lines.append(f"  {path} -> {' '.join(parts) or 'as found'}{alias}")
    for item in import_map.create:
        alias = f" (aliases: {', '.join(item.aliases)})" if item.aliases else ""
        lines.append(f"  create {item.drawer} {item.key}: {item.name}{alias}")
    return lines
