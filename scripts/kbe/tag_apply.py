"""`kbe tags apply` -- write the tags in a proposals file back to the sources.

Two steps, always: `plan` reads the file and says exactly what would change;
`apply` does it, and only when asked to write. A dry run builds no client,
opens no file for writing and calls no API.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from knowledge.engine_config import UNCLASSIFIED
from knowledge.tag_resolver import prefix_for

from kbe import tag_writers
from kbe.tag_writers import TagWriteError

REQUIRED_COLUMNS = ("source", "external_id", "proposed")
WRITABLE_SOURCES = ("wiki", "drive", "gmail")
READY, SKIP, DONE, UNCHANGED, FAILED = "ready", "skip", "written", "unchanged", "failed"
_SEPARATORS = re.compile(r"[;,|\s]+")

Writer = Callable[["Action"], bool]


class TagApplyError(RuntimeError):
    """The proposals file could not be used."""


@dataclass(frozen=True, slots=True)
class Action:
    """One row of the file: what would be written where, or why it is skipped."""

    source: str
    external_id: str
    topics: tuple[str, ...]
    status: str
    note: str = ""


def read_proposals(path: Path) -> list[dict[str, str]]:
    target = Path(path)
    try:
        with target.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or ())]
            if missing:
                raise TagApplyError(f"{target} is missing column(s): {', '.join(missing)}")
            return [{k: (v or "").strip() for k, v in row.items() if k} for row in reader]
    except (OSError, UnicodeDecodeError, csv.Error) as error:
        raise TagApplyError(f"could not read {target}: {error}") from error


def _topics(cell: str) -> tuple[str, ...]:
    parts = (part.strip().lstrip("'").lower() for part in _SEPARATORS.split(cell or ""))
    return tuple(dict.fromkeys(part for part in parts if part))


def _skip_reason(row: Mapping[str, str], topics, config: Any, wiki_root: Path | None) -> str:
    source, external_id = row.get("source", ""), row.get("external_id", "")
    if not topics:
        return "no topic proposed"
    if not external_id:
        return "no external_id"
    if source == "fireflies":
        return "tag the Fireflies channel, or the meeting's wiki page, instead"
    if source not in WRITABLE_SOURCES:
        return f"unknown source {source!r}"
    unknown = [t for t in topics if t not in config.domain_ids or t == UNCLASSIFIED]
    if unknown:
        return f"not a topic in the config: {', '.join(unknown)}"
    if source == "wiki":
        if wiki_root is None:
            return "needs --wiki-root (a local clone of the knowledge repo)"
        try:
            tag_writers.wiki_page_path(wiki_root, external_id)
        except TagWriteError as error:
            return str(error)
    return ""


def _note(topics: Sequence[str], config: Any) -> str:
    sensitive = [t for t in topics if t in config.sensitive_domain_ids]
    return f"sensitive topic: {', '.join(sensitive)}" if sensitive else ""


def plan(
    rows: Sequence[Mapping[str, str]], config: Any, *, wiki_root: Path | None = None
) -> list[Action]:
    """One action per row, in file order. Reads only; changes nothing."""
    seen: set[tuple[str, str]] = set()
    actions: list[Action] = []
    for row in rows:
        source, external_id = row.get("source", ""), row.get("external_id", "")
        topics = _topics(row.get("proposed", ""))
        reason = _skip_reason(row, topics, config, wiki_root)
        if not reason and (source, external_id) in seen:
            reason = "listed twice; only the first row is used"
        seen = {*seen, (source, external_id)}
        status, note = (SKIP, reason) if reason else (READY, _note(topics, config))
        actions.append(Action(source, external_id, topics, status, note))
    return actions


def wiki_writer(wiki_root: Path, key: str) -> Writer:
    return lambda action: tag_writers.write_wiki_tag(
        wiki_root, action.external_id, action.topics, key
    )


def drive_writer(client: Any, config: Any) -> Writer:
    prefix = prefix_for("drive", config)
    return lambda action: tag_writers.write_drive_tag(
        client, action.external_id, action.topics, prefix
    )


def gmail_writer(client: Any, config: Any) -> Writer:
    prefix = prefix_for("gmail", config)
    return lambda action: tag_writers.write_gmail_labels(
        client, action.external_id, action.topics, prefix
    )


def _run(action: Action, writer: Writer | None) -> Action:
    if writer is None:
        return replace(action, status=FAILED, note=f"no writer for {action.source}")
    try:
        changed = writer(action)
    except TagWriteError as error:
        return replace(action, status=FAILED, note=str(error))
    return replace(action, status=DONE if changed else UNCHANGED)


def apply(
    actions: Sequence[Action], writers: Mapping[str, Writer], *, write: bool = False
) -> list[Action]:
    """Carry out the ready actions. Without `write=True` nothing is called."""
    if not write:
        return list(actions)
    return [
        _run(action, writers.get(action.source)) if action.status == READY else action
        for action in actions
    ]


def sources_needed(actions: Sequence[Action]) -> tuple[str, ...]:
    return tuple(sorted({a.source for a in actions if a.status == READY}))


def render(actions: Sequence[Action], *, wrote: bool) -> str:
    lines = [
        f"{action.status:<9} {action.source:<6} {action.external_id}"
        f"  -> {', '.join(action.topics) or '-'}"
        + (f"  ({action.note})" if action.note else "")
        for action in actions
    ]
    counts: dict[str, int] = {}
    for action in actions:
        counts = {**counts, action.status: counts.get(action.status, 0) + 1}
    summary = "  ".join(f"{status}={count}" for status, count in sorted(counts.items()))
    footer = (
        "Written. Wiki pages are changed in the clone only: review and commit them."
        if wrote
        else "Dry run: nothing was written. Re-run with --write to apply the ready rows."
    )
    return "\n".join([*lines, "", summary or "no rows", footer])
