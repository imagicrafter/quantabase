"""Deterministic triage -- which documents are worth distilling.

Every decision here is a RULE, not a judgement. Rules are testable, diffable,
free to run, and produce the same answer every time. The model is only asked to
write summaries for what survives; it is never asked whether a document deserves
one.

Each skip carries a machine-readable reason, so the candidate list can be reviewed
as "here is what I am NOT doing and why" rather than an opaque subset.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Sequence

from .config import sensitive_domains as configured_sensitive_domains
from .distill import DISTILLER_VERSION, content_hash

# A body shorter than this cannot support a meaningful summary. A Drive row
# that is metadata only lands around 150-250 characters.
MIN_BODY_CHARS = 400

# Titles that are structurally not knowledge.
SKIP_TITLE_PATTERNS: tuple[tuple[re.Pattern, str], ...] = (
    (re.compile(r"^untitled\b", re.I), "untitled placeholder"),
    (re.compile(r"^backup of\b", re.I), "backup copy"),
    (re.compile(r"^copy of\b", re.I), "duplicate copy"),
    (re.compile(r"^sample_", re.I), "sample template"),
)

# Exact-content duplicates: byte-identical documents stored twice (a Drive file
# copied between folders, a page duplicated under two names). Distil one, point
# the rest at it.
#
# Title similarity is deliberately NOT a rule: recurring documents share a
# title shape and carry different content. Identical content is the only
# evidence of redundancy used here.


@dataclass(frozen=True, slots=True)
class Candidate:
    """A document selected for distillation."""

    doc_id: str
    source: str
    external_id: str
    title: str
    body: str
    location: str
    kind: str


@dataclass(frozen=True, slots=True)
class Skipped:
    """A document deliberately not distilled, with the reason."""

    doc_id: str
    source: str
    title: str
    reason: str


@dataclass(frozen=True, slots=True)
class TriageResult:
    candidates: list[Candidate] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)

    def reason_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for item in self.skipped:
            counts[item.reason] = counts.get(item.reason, 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


def _content_key(row: dict) -> str:
    """Hash of the body alone -- groups byte-identical documents."""
    return content_hash("", (row.get("body") or "").strip())


def _already_distilled(row: dict) -> bool:
    """True when a current-version distillation exists for this exact content."""
    metadata = row.get("metadata") or {}
    record = metadata.get("distill")
    if not isinstance(record, dict):
        return False
    if record.get("version") != DISTILLER_VERSION:
        return False
    return record.get("content_hash") == content_hash(
        row.get("title") or "", row.get("body") or ""
    )


def _current_content_hash(row: dict) -> str:
    return content_hash(row.get("title") or "", row.get("body") or "")


def _is_excluded(row: dict, excluded_keys: frozenset[tuple[str, str, str]]) -> bool:
    """True when this row's CURRENT content was terminally excluded.

    Keyed to (source, external_id, content_hash): if the source content
    changes, the hash changes and the row becomes eligible again -- that is
    what makes an 'exclude' rejection different from a soft delete, and what
    lets a 'regenerate' rejection make a row eligible again without needing
    any special-case here (regenerate also clears `metadata.distill`, so
    `_already_distilled` alone re-admits it).
    """
    if not excluded_keys:
        return False
    key = (row.get("source", ""), row.get("external_id", ""), _current_content_hash(row))
    return key in excluded_keys


def _static_reason(
    row: dict, excluded_keys: frozenset[tuple[str, str, str]] = frozenset()
) -> str | None:
    """Rule-based reasons to skip, in priority order. None means keep."""
    title = (row.get("title") or "").strip()
    body = row.get("body") or ""
    metadata = row.get("metadata") or {}

    if _is_excluded(row, excluded_keys):
        return "excluded by prior human review"

    if row.get("parent_external_id"):
        # Sections inherit their parent's meaning; distilling each one would
        # multiply cost for near-duplicate summaries.
        return "section of a larger document"

    # NOTE: a page carrying `summary:` frontmatter is NOT skipped. A one-line
    # summary cannot carry a key-terms block. `summary_source` is recorded in
    # metadata so the audit can show which rows had one; it is information,
    # not an exemption.

    if _already_distilled(row):
        return "already distilled at current version"

    for pattern, reason in SKIP_TITLE_PATTERNS:
        if pattern.search(title):
            return reason

    if len(body.strip()) < MIN_BODY_CHARS:
        return "body too short to summarise"

    return None


def priority_score(row: dict) -> float:
    """Consequence-if-wrong ordering for the review queue, highest first.

        label_source == 'model_proposed' (disputed)              -> 300
        sensitive domain (any topic the config marks sensitive)  -> 200
        terms dropped as unverifiable                            -> 100
        (nothing above applies)                                  -> 0

    Every band comes from the row and the Engine config; no topic name is
    special. A disputed label is first because an unresolved access question
    needs a person before anything else.
    """
    domains = row.get("domains") or ()
    metadata = row.get("metadata") or {}

    if row.get("label_source") == "model_proposed":
        band = 300.0
    elif any(domain in configured_sensitive_domains() for domain in domains):
        band = 200.0
    elif (metadata.get("distill") or {}).get("dropped_terms", 0):
        band = 100.0
    else:
        band = 0.0

    return band + _recency_tiebreak(row)


def _recency_tiebreak(row: dict) -> float:
    """A small, band-safe nudge toward newer documents.

    Always in (0, 1] -- strictly less than the gap between any two priority
    bands (100), so this only reorders rows that already share a band, never
    moves a row across one. Newer `source_created_at` -> value closer to 1.
    """
    stamp = row.get("source_created_at") or ""
    if not stamp:
        return 0.0
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    days_ago = max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds() / 86400)
    return 1.0 / (1.0 + days_ago)


def triage(
    rows: Iterable[dict],
    excluded_keys: frozenset[tuple[str, str, str]] = frozenset(),
) -> TriageResult:
    """Split documents into distillation candidates and reasoned skips.

    Expects raw `workspace.documents` rows. `excluded_keys` is the set of
    (source, external_id, content_hash) for rows carrying an 'exclude'
    rejection in `workspace.distillation_rejections` -- the caller (which
    talks to the database) is responsible for building it; this module stays
    a pure function over its inputs, like the rest of triage.
    """
    rows = list(rows)
    result = TriageResult()

    survivors: list[dict] = []
    for row in rows:
        reason = _static_reason(row, excluded_keys)
        if reason:
            result.skipped.append(
                Skipped(
                    doc_id=row["id"],
                    source=row.get("source", ""),
                    title=row.get("title", ""),
                    reason=reason,
                )
            )
        else:
            survivors.append(row)

    # Exact-duplicate collapse runs last, over survivors only, so the
    # representative chosen is one that would genuinely have been distilled.
    groups: dict[str, list[dict]] = {}
    for row in survivors:
        groups.setdefault(_content_key(row), []).append(row)

    representative_by_doc_id: dict[str, dict] = {}
    for members in groups.values():
        if len(members) > 1:
            members.sort(
                key=lambda r: (r.get("source_created_at") or "", r.get("title") or ""),
                reverse=True,
            )
            representative = members[0]
            result.candidates.append(_to_candidate(representative))
            representative_by_doc_id[representative["id"]] = representative
            for row in members[1:]:
                result.skipped.append(
                    Skipped(
                        doc_id=row["id"],
                        source=row.get("source", ""),
                        title=row.get("title", ""),
                        reason=(
                            "byte-identical to "
                            f"{representative.get('title', '')!r}"
                        ),
                    )
                )
        else:
            result.candidates.append(_to_candidate(members[0]))
            representative_by_doc_id[members[0]["id"]] = members[0]

    # Highest consequence-if-wrong first; (source, title) breaks any
    # remaining tie deterministically.
    result.candidates.sort(
        key=lambda c: (
            -priority_score(representative_by_doc_id[c.doc_id]),
            c.source,
            c.title,
        )
    )
    return result


def _to_candidate(row: dict) -> Candidate:
    metadata = row.get("metadata") or {}
    return Candidate(
        doc_id=row["id"],
        source=row.get("source", ""),
        external_id=row.get("external_id", ""),
        title=row.get("title", ""),
        body=row.get("body") or "",
        location=metadata.get("folder_path") or metadata.get("wiki_directory") or "",
        kind=metadata.get("mime_type") or metadata.get("wiki_type") or "",
    )


def as_dicts(items: Sequence[Candidate] | Sequence[Skipped]) -> list[dict]:
    """Serialise for the workflow's JSON handoff."""
    output: list[dict] = []
    for item in items:
        if isinstance(item, Candidate):
            output.append(
                {
                    "doc_id": item.doc_id,
                    "source": item.source,
                    "external_id": item.external_id,
                    "title": item.title,
                    "location": item.location,
                    "kind": item.kind,
                    "body_chars": len(item.body),
                }
            )
        else:
            output.append(
                {
                    "doc_id": item.doc_id,
                    "source": item.source,
                    "title": item.title,
                    "reason": item.reason,
                }
            )
    return output
