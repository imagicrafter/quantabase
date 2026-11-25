"""`kbe tags audit` -- how every source's documents got their topics.

Reads `workspace.documents` (whole, live documents only) and counts them by
`tag_source`, then lists what a person should look at: items with no tag, and
items whose tag names a topic the config does not declare.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from knowledge.engine_config import UNCLASSIFIED
from knowledge.tag_resolver import IGNORED_FOREIGN_TAG, MATCH_DEFAULT, MATCHED_BY, UNKNOWN_TAG
from knowledge.kb_schema import db

NOT_RECORDED = "not_recorded"
COLUMNS = "source, external_id, title, domains, tag_source, tag_signals"
PAGE_SIZE = 1000
MAX_PAGES = 200


class TagAuditError(RuntimeError):
    """The documents could not be read."""


@dataclass(frozen=True, slots=True)
class Item:
    source: str
    external_id: str
    title: str
    domains: tuple[str, ...]
    signals: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SourceAudit:
    source: str
    total: int
    by_tag_source: Mapping[str, int]
    untagged: tuple[Item, ...]
    unknown: tuple[Item, ...]
    # Documents with a tag that was not trusted (Drive: on an item the
    # signed-in account does not own). A count only.
    ignored_foreign: int = 0


def _query(sb: Any, columns: str, source: str | None, start: int):
    query = (
        db(sb)
        .table("documents")
        .select(columns)
        .is_("deleted_at", "null")
        .is_("parent_external_id", "null")
    )
    if source:
        query = query.eq("source", source)
    return query.order("source").order("external_id").range(start, start + PAGE_SIZE - 1)


def fetch_rows(sb: Any, source: str | None = None, columns: str = COLUMNS) -> list[dict]:
    """Every whole, live document (optionally one source), a page at a time."""
    rows: list[dict] = []
    for page in range(MAX_PAGES):
        try:
            batch = _query(sb, columns, source, page * PAGE_SIZE).execute().data or []
        except Exception as error:  # noqa: BLE001 - any client failure
            raise TagAuditError(
                "Could not read the documents table "
                f"({type(error).__name__}). Has migration 0031 been applied?"
            ) from error
        rows = [*rows, *batch]
        if len(batch) < PAGE_SIZE:
            return rows
    raise TagAuditError(f"more than {MAX_PAGES * PAGE_SIZE} documents; narrow with --source")


def is_untagged(row: Mapping[str, Any]) -> bool:
    """No tag was found at the source (so the item is owner-only)."""
    tag_source = row.get("tag_source")
    if tag_source == MATCH_DEFAULT:
        return True
    return tag_source is None and list(row.get("domains") or []) == [UNCLASSIFIED]


def has_unknown_tag(row: Mapping[str, Any]) -> bool:
    return UNKNOWN_TAG in (row.get("tag_signals") or ())


def has_ignored_foreign_tag(row: Mapping[str, Any]) -> bool:
    return IGNORED_FOREIGN_TAG in (row.get("tag_signals") or ())


def _item(row: Mapping[str, Any]) -> Item:
    return Item(
        source=str(row.get("source") or ""),
        external_id=str(row.get("external_id") or ""),
        title=str(row.get("title") or ""),
        domains=tuple(row.get("domains") or ()),
        signals=tuple(row.get("tag_signals") or ()),
    )


def _audit_source(source: str, rows: Sequence[Mapping[str, Any]]) -> SourceAudit:
    keys = (*MATCHED_BY, NOT_RECORDED)
    counts = {key: 0 for key in keys}
    for row in rows:
        key = row.get("tag_source") or NOT_RECORDED
        counts = {**counts, key: counts.get(key, 0) + 1}
    return SourceAudit(
        source=source,
        total=len(rows),
        by_tag_source=counts,
        untagged=tuple(_item(row) for row in rows if is_untagged(row)),
        unknown=tuple(_item(row) for row in rows if has_unknown_tag(row)),
        ignored_foreign=sum(1 for row in rows if has_ignored_foreign_tag(row)),
    )


def summarise(rows: Sequence[Mapping[str, Any]]) -> tuple[SourceAudit, ...]:
    """One audit per source, sources in name order."""
    sources = sorted({str(row.get("source") or "") for row in rows})
    return tuple(
        _audit_source(source, [row for row in rows if str(row.get("source") or "") == source])
        for source in sources
    )


def _listing(label: str, items: Sequence[Item], limit: int, with_signals: bool) -> list[str]:
    lines = [f"  {label}: {len(items)}"]
    for item in items[:limit]:
        detail = f"  [{', '.join(s for s in item.signals if ':' in s)}]" if with_signals else ""
        lines.append(f"    {item.external_id}  {item.title}{detail}")
    if len(items) > limit:
        lines.append(f"    ... and {len(items) - limit} more")
    return lines


def render(audits: Sequence[SourceAudit], limit: int = 50) -> str:
    """The audit as plain text."""
    if not audits:
        return "No documents found."
    lines: list[str] = []
    for audit in audits:
        counts = "  ".join(f"{key}={count}" for key, count in audit.by_tag_source.items())
        lines += [f"{audit.source}: {audit.total} documents", f"  {counts}"]
        lines += _listing("untagged", audit.untagged, limit, with_signals=False)
        lines += _listing("unknown tag", audit.unknown, limit, with_signals=True)
        if audit.ignored_foreign:
            lines.append(f"  tag ignored (not the owner's item): {audit.ignored_foreign}")
        lines.append("")
    return "\n".join(lines).rstrip()


def as_json(audits: Sequence[SourceAudit]) -> list[dict]:
    return [
        {
            "source": audit.source,
            "total": audit.total,
            "by_tag_source": dict(audit.by_tag_source),
            "untagged": [item.external_id for item in audit.untagged],
            "unknown_tag": [
                {"external_id": item.external_id, "signals": list(item.signals)}
                for item in audit.unknown
            ],
            "ignored_foreign_tag": audit.ignored_foreign,
        }
        for audit in audits
    ]
