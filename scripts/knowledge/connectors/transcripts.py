"""Transcripts connector -- full speaker-attributed meeting transcripts into
workspace.documents.

Local files only, no API: `memory/transcripts/*.md` in the workspace
(NOT the wiki repo -- the wiki connector never reaches them). 119 files,
verified indexed in neither `memory_chunks` nor `workspace.documents` as of
2026-08-13.

`source='fireflies'` -- `raw_captures` has a fixed CHECK constraint allowing
only gmail/fireflies/drive, and these files originate from Fireflies exports
even though this connector reads them off disk rather than calling the API.

One row per transcript. `external_id` is the filename, which is also the join
key to the wiki: every transcript filename has a same-named page under
`~/github/knowledge/meetings/`, carrying the summary that cites it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence

from ..bronze import capture
from ..config import SOURCE_FIREFLIES, TIER_DISTILLED, TRANSCRIPTS_DIR, WORKSPACE_ROOT
from ..contract import Document
from ..engine_config import get_config
from ..frontmatter import parse as parse_frontmatter
from ..tag_resolver import prefix_for, resolve
from ..tag_sources import fireflies as fireflies_tags, wiki as wiki_tags

# The wiki connector's own external_id for the matching meeting summary, so a
# reader can hop from a quote straight to the page that cites it.
WIKI_MEETING_PREFIX = "meetings/"


class TranscriptsConnectorError(RuntimeError):
    """Transcripts could not be read."""


@dataclass(frozen=True, slots=True)
class TranscriptAudit:
    """One row per transcript, so domain assignments stay reviewable."""

    filename: str
    title: str
    domains: tuple[str, ...]
    matched_by: str
    wiki_page_id: str | None


def discover_transcripts(root: Path | None = None) -> list[Path]:
    base = root or TRANSCRIPTS_DIR
    if not base.exists():
        raise TranscriptsConnectorError(f"Transcripts directory not found at {base}")
    return sorted(p for p in base.glob("*.md") if p.is_file())


def _parse_title(body: str, fallback: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].replace("Transcript:", "").strip() or fallback
    return fallback


def _parse_date(body: str) -> datetime | None:
    for line in body.splitlines()[:5]:
        if "**Date:**" not in line:
            continue
        raw = line.split("**Date:**", 1)[1].split("|")[0].strip()
        try:
            return datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _wiki_page_id(filename: str) -> str | None:
    """The matching meeting summary's external_id, if the wiki has one.

    Filenames correspond 1:1 by naming convention -- checked against the
    live directory rather than assumed, since a transcript with no matching
    summary should still be indexed, just without the link.
    """
    wiki_meetings = WORKSPACE_ROOT.parent / "knowledge" / "meetings" / filename
    if wiki_meetings.exists():
        return f"{WIKI_MEETING_PREFIX}{filename}"
    return None


def _page_frontmatter(wiki_page_id: str | None) -> dict | None:
    """Frontmatter of the matching meeting page, or None when there is none."""
    if not wiki_page_id:
        return None
    page = WORKSPACE_ROOT.parent / "knowledge" / wiki_page_id
    try:
        text = page.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise TranscriptsConnectorError(f"Could not read {page}: {error}") from error
    key = get_config().tagging.frontmatter_key
    return dict(wiki_tags.frontmatter_for_tags(text, parse_frontmatter(text).frontmatter, key))


def _transcript_to_document(path: Path) -> tuple[Document, TranscriptAudit] | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise TranscriptsConnectorError(f"Could not read {path}: {error}") from error

    body = raw.strip()
    if not body:
        return None

    filename = path.name
    title = _parse_title(body, path.stem)
    created = _parse_date(body)
    wiki_page_id = _wiki_page_id(filename)

    # A file on disk has no channel. The only tag is the meeting page's.
    config = get_config()
    content, containers = fireflies_tags.meeting_tags(
        {},
        _page_frontmatter(wiki_page_id),
        prefix=prefix_for(SOURCE_FIREFLIES, config),
        frontmatter_key=config.tagging.frontmatter_key,
    )
    assignment = resolve(SOURCE_FIREFLIES, content, containers, config)

    capture(
        source="fireflies",
        external_id=filename,
        raw_text=body,
        raw_metadata={
            "filename": filename,
            "title": title,
            "wiki_page_id": wiki_page_id,
        },
    )

    document = Document(
        source=SOURCE_FIREFLIES,
        external_id=filename,
        title=title,
        body=body,
        distillation=None,
        url=None,
        author=None,
        domains=assignment.domains,
        tier=TIER_DISTILLED,
        source_created_at=created,
        metadata={
            "filename": filename,
            "wiki_page_id": wiki_page_id,
            "domain_match": assignment.matched_by,
        },
        tag_source=assignment.matched_by,
        tag_signals=assignment.signals,
    )

    audit = TranscriptAudit(
        filename=filename,
        title=title,
        domains=assignment.domains,
        matched_by=assignment.matched_by,
        wiki_page_id=wiki_page_id,
    )

    return document, audit


def collect(
    *,
    root: Path | None = None,
    include_sensitive: bool = False,
    sensitive_domains: Sequence[str] | None = None,
) -> tuple[list[Document], list[TranscriptAudit]]:
    from ..config import sensitive_domains as configured_sensitive_domains

    sensitive = set(
        configured_sensitive_domains() if sensitive_domains is None else sensitive_domains
    )

    documents: list[Document] = []
    audits: list[TranscriptAudit] = []

    for path in discover_transcripts(root):
        converted = _transcript_to_document(path)
        if converted is None:
            continue
        document, audit = converted

        if not include_sensitive and sensitive.intersection(audit.domains):
            continue

        documents.append(document)
        audits.append(audit)

    return documents, audits


def iter_audit_rows(audits: Iterable[TranscriptAudit]):
    for audit in audits:
        yield {
            "filename": audit.filename,
            "title": audit.title,
            "domains": ",".join(audit.domains),
            "matched_by": audit.matched_by,
            "wiki_page_id": audit.wiki_page_id or "",
        }
