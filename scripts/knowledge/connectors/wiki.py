"""Wiki connector -- the knowledge repo's markdown pages into the documents table.

Only the curated directories are wiki pages. `sources/**` is a raw mirror of
other files and may hold private material; ingesting "every `*.md`" would
place it in a store designed to be shared. Only CURATED_WIKI_DIRS is read.

Tier assignment also departs from the plan, which keyed tier 1 off `verified:` and
`status: current`. Measured against the real corpus: `verified:` appears on 1 page,
`status:` on 6, `stale_after:` on 0. That rule yields a single tier-1 page and makes
the tier column noise. Tier is therefore assigned by curation directory, with
`verified:` reserved as the promotion path a review loop can mint into later.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence

from ..config import (
    CHARS_PER_TOKEN,
    CURATED_WIKI_DIRS,
    EXCLUDED_WIKI_DIRS,
    EXCLUDED_WIKI_FILES,
    SECTION_THRESHOLD_TOKENS,
    sensitive_domains as configured_sensitive_domains,
    SOURCE_WIKI,
    TIER_CURATED,
    TIER_DISTILLED,
    TIER_VERIFIED,
    WIKI_ROOT,
)
from ..contract import Document
from ..engine_config import get_config
from ..frontmatter import as_datetime, as_list, parse
from ..tag_resolver import DomainAssignment, resolve
from ..tag_sources import wiki as wiki_tags

MEETINGS_DIR = "meetings"


class WikiConnectorError(RuntimeError):
    """The wiki could not be read."""


@dataclass(frozen=True, slots=True)
class PageAudit:
    """One row of the labelling audit, so every assignment is reviewable."""

    path: str
    title: str
    tier: int
    domains: tuple[str, ...]
    matched_by: str
    signals: tuple[str, ...]
    has_summary: bool


def _tracked_files(root: Path) -> set[Path] | None:
    """Absolute paths of every git-tracked file, or None if git is unavailable.

    Git is authoritative for the wiki, so an untracked or gitignored page is not
    wiki content -- it is a local artefact that happens to sit in the folder.

    This is not tidiness. Measured 2026-08-13: one meeting page was gitignored
    and existed only on a developer machine. The developer machine
    indexed it; the droplet, running the same full_sync against the same repo,
    saw it missing and tombstoned it along with its 10 section rows. Two hosts
    syncing the same corpus disagreed about its contents, and every run would
    have flip-flopped those rows forever.
    """
    import subprocess

    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", "*.md"],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if result.returncode != 0:
        return None

    names = result.stdout.decode("utf-8", "replace").split("\0")
    return {root / name for name in names if name}


def discover_pages(wiki_root: Path | None = None) -> list[Path]:
    """Curated, git-TRACKED wiki pages only. Never `sources/**`."""
    root = wiki_root or WIKI_ROOT
    if not root.exists():
        raise WikiConnectorError(
            f"Wiki repository not found at {root}. Expected a clone of "
            "the knowledge repo named in the Engine config (sources.wiki.repo)"
        )

    tracked = _tracked_files(root)

    pages: list[Path] = []
    for directory in CURATED_WIKI_DIRS:
        base = root / directory
        if not base.exists():
            continue
        for path in base.rglob("*.md"):
            if not path.is_file():
                continue
            relative = path.relative_to(root)
            if any(part in EXCLUDED_WIKI_DIRS for part in relative.parts):
                continue
            if path.name in EXCLUDED_WIKI_FILES:
                continue
            # None means git was unavailable -- fall back to indexing everything
            # rather than silently emitting an empty set, which under full_sync
            # would read as "delete the entire corpus".
            if tracked is not None and path not in tracked:
                continue
            pages.append(path)

    return sorted(set(pages))


def _resolve_tier(directory: str, frontmatter: dict) -> int:
    """Tier by curation state.

    1 -- carries an explicit `verified:` stamp. Currently one page; this is the
         slot a future review loop promotes into.
    2 -- curated concepts, decisions, people, projects, research, diagrams.
    3 -- meetings: real, dated, but not confirmed knowledge.
    """
    verified = frontmatter.get("verified")
    if isinstance(verified, str) and verified.strip():
        return TIER_VERIFIED
    if isinstance(verified, list) and verified:
        return TIER_VERIFIED

    if directory == MEETINGS_DIR:
        return TIER_DISTILLED

    return TIER_CURATED


def _heading_outline(body: str, limit: int = 40) -> list[str]:
    return [
        line.strip().lstrip("#").strip()
        for line in body.splitlines()
        if line.startswith("##") and line.strip().lstrip("#").strip()
    ][:limit]


def _summary_source(frontmatter: dict) -> str:
    """Whether the page carries a human-written summary.

    Load-bearing for the distillation workflow: a hand-written `summary:` is
    better than anything a model would produce, so those pages are never sent to
    the distiller. Pages falling back to the heading outline are.
    """
    for key in ("summary", "description"):
        value = frontmatter.get(key)
        if isinstance(value, str) and value.strip():
            return "frontmatter"
    return "outline"


def _build_distillation(frontmatter: dict, body: str) -> str | None:
    """Frontmatter summary plus the heading outline.

    The wiki uses two fields, not one: `summary:` on 161 pages and `description:`
    on 37. The plan named only `description`, and an earlier pass here read only
    `summary`; either alone leaves pages embedding on raw body text. Both are read,
    `summary` first. Where neither exists the outline still embeds better than the
    opening paragraphs.
    """
    summary_text = ""
    for key in ("summary", "description"):
        value = frontmatter.get(key)
        if isinstance(value, str) and value.strip():
            summary_text = value.strip()
            break

    outline = _heading_outline(body)
    outline_text = "\n".join(f"- {heading}" for heading in outline)

    parts = [part for part in (summary_text, outline_text) if part]
    return "\n\n".join(parts) if parts else None


# Hosts whose links are the owner's own artifacts rather than third-party reference
# material. A Zendesk help page is a citation; a Google Doc is a deliverable.
ARTIFACT_HOSTS = (
    "docs.google.com",
    "drive.google.com",
    "sheets.google.com",
    "slides.google.com",
    "claude.ai/public/artifacts",
)


def artifact_hosts() -> tuple[str, ...]:
    """ARTIFACT_HOSTS plus the owner's own GitHub organisation, taken from the
    knowledge repo named in the Engine config (sources.wiki.repo)."""
    from ..engine_config import get_config

    repo = get_config().sources.wiki.repo
    own = (f"github.com/{repo.split('/', 1)[0]}/",) if repo else ()
    return ARTIFACT_HOSTS + own

_URL_PATTERN = re.compile(r"https?://[^\s\)\]\>\"',]+")


def _artifact_only(urls) -> list[str]:
    """Keep only links to the owner's own artifacts.

    Vendor documentation, help centres and LinkedIn are citations, not
    deliverables. Mixing them in makes the field useless for finding artifacts.
    """
    hosts = artifact_hosts()
    return [url for url in urls if any(host in url for host in hosts)]


def _dedupe(urls: Sequence[str], limit: int = 20) -> list[str]:
    seen: list[str] = []
    for url in urls:
        if url not in seen:
            seen.append(url)
        if len(seen) >= limit:
            break
    return seen


def _body_artifact_urls(body: str) -> list[str]:
    """Artifact links found in the page body."""
    return _artifact_only(
        match.group(0).rstrip(".,;") for match in _URL_PATTERN.finditer(body)
    )


def _resolve_author(frontmatter: dict) -> str | None:
    verified = frontmatter.get("verified")
    if isinstance(verified, str) and verified.strip():
        return verified.strip()
    if isinstance(verified, list) and verified:
        return str(verified[0])
    return None


def _slugify(heading: str) -> str:
    kept = [char.lower() if char.isalnum() else "-" for char in heading]
    slug = "".join(kept)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-") or "section"


def _split_sections(body: str) -> list[tuple[str, str]]:
    """Split on `##` boundaries only. Never below `##`.

    Returns (heading, text) pairs. Content before the first `##` is not returned;
    the parent row already carries the whole body.
    """
    sections: list[tuple[str, str]] = []
    current_heading: str | None = None
    buffer: list[str] = []

    for line in body.splitlines():
        is_h2 = line.startswith("## ") and not line.startswith("### ")
        if is_h2:
            if current_heading is not None and buffer:
                sections.append((current_heading, "\n".join(buffer).strip()))
            current_heading = line.lstrip("#").strip()
            buffer = []
        elif current_heading is not None:
            buffer.append(line)

    if current_heading is not None and buffer:
        sections.append((current_heading, "\n".join(buffer).strip()))

    return [(heading, text) for heading, text in sections if text]


def _should_section(body: str) -> bool:
    return len(body) > SECTION_THRESHOLD_TOKENS * CHARS_PER_TOKEN


_TRANSCRIPT_SECTION = re.compile(r"^## Transcript[ \t]*\n.*?(?=^## |\Z)", re.MULTILINE | re.DOTALL)


def strip_transcript(body: str) -> str:
    """Drop a meeting page's `## Transcript` section before indexing.

    The full transcript is already searchable as the `fireflies` row; indexing
    the wiki copy too would return every transcript twice (and section-split
    it into dozens of rows).
    """
    return _TRANSCRIPT_SECTION.sub("", body).strip()


def _page_to_documents(
    path: Path, root: Path
) -> tuple[list[Document], PageAudit] | None:
    """Convert one page to a parent document plus optional section rows."""
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise WikiConnectorError(f"Could not read {path}: {error}") from error

    parsed = parse(raw)
    frontmatter = parsed.frontmatter
    body = parsed.body.strip()

    if not body:
        return None

    relative = path.relative_to(root)
    external_id = str(relative)
    directory = relative.parts[0] if relative.parts else ""
    if directory == MEETINGS_DIR:
        body = strip_transcript(body)

    title = frontmatter.get("title")
    title = title.strip() if isinstance(title, str) and title.strip() else path.stem

    # Topics come from one frontmatter key and nothing else -- not `tags:`,
    # not the title, not the folder. See docs/tagging.md.
    config = get_config()
    key = config.tagging.frontmatter_key
    assignment: DomainAssignment = resolve(
        SOURCE_WIKI,
        wiki_tags.content_tags(wiki_tags.frontmatter_for_tags(raw, frontmatter, key), key),
        (),
        config,
    )

    tier = _resolve_tier(directory, frontmatter)
    created = as_datetime(frontmatter.get("date")) or as_datetime(
        frontmatter.get("created")
    )

    # `sources:` mixes three kinds of provenance: session ids, repo-relative
    # paths, and external artifact URLs (Google Docs, GitHub, deployed apps).
    # Split them so the external ones are actually addressable -- an earlier
    # version dropped `sources` entirely.
    sources = as_list(frontmatter.get("sources"))
    artifact_urls = _dedupe(
        _artifact_only(s for s in sources if s.startswith(("http://", "https://")))
        + _body_artifact_urls(body)
    )

    shared_metadata = {
        "wiki_type": frontmatter.get("type"),
        "wiki_directory": directory,
        "tags": as_list(frontmatter.get("tags")),
        "aliases": as_list(frontmatter.get("aliases")),
        "related": as_list(frontmatter.get("related")),
        "sources": sources,
        "artifact_urls": artifact_urls,
        "domain_match": assignment.matched_by,
        "summary_source": _summary_source(frontmatter),
    }

    parent = Document(
        source=SOURCE_WIKI,
        external_id=external_id,
        title=title,
        body=body,
        distillation=_build_distillation(frontmatter, body),
        url=external_id,
        author=_resolve_author(frontmatter),
        domains=assignment.domains,
        tier=tier,
        source_created_at=created,
        metadata=shared_metadata,
        tag_source=assignment.matched_by,
        tag_signals=assignment.signals,
    )

    documents = [parent]

    if _should_section(body):
        for index, (heading, text) in enumerate(_split_sections(body)):
            documents.append(
                Document(
                    source=SOURCE_WIKI,
                    # Index-prefixed: a page can repeat a `##` heading, and the
                    # slug alone would collide on the unique constraint.
                    external_id=f"{external_id}#{index:02d}-{_slugify(heading)}",
                    parent_external_id=external_id,
                    title=f"{title} -- {heading}",
                    body=text,
                    distillation=heading,
                    url=external_id,
                    author=parent.author,
                    domains=assignment.domains,
                    tier=tier,
                    source_created_at=created,
                    metadata={**shared_metadata, "section_index": index},
                    tag_source=assignment.matched_by,
                    tag_signals=assignment.signals,
                )
            )

    audit = PageAudit(
        path=external_id,
        title=title,
        tier=tier,
        domains=assignment.domains,
        matched_by=assignment.matched_by,
        signals=assignment.signals,
        has_summary=bool(
            isinstance(frontmatter.get("summary"), str)
            and frontmatter["summary"].strip()
        ),
    )

    return documents, audit


def collect(
    wiki_root: Path | None = None,
    *,
    include_sensitive: bool = False,
    sensitive_domains: Sequence[str] | None = None,
) -> tuple[list[Document], list[PageAudit]]:
    """Read the wiki and emit documents plus a labelling audit.

    Sensitive domains are excluded by default and default to the config list, so
    adding a sensitive domain there takes effect here without a second edit. An
    earlier version hardcoded one sensitive topic, which silently let a newly added
    `personal` domain through.
    """
    root = wiki_root or WIKI_ROOT
    documents: list[Document] = []
    audits: list[PageAudit] = []
    sensitive = set(
        configured_sensitive_domains() if sensitive_domains is None else sensitive_domains
    )

    for path in discover_pages(root):
        converted = _page_to_documents(path, root)
        if converted is None:
            continue
        page_documents, audit = converted

        if not include_sensitive and sensitive.intersection(audit.domains):
            continue

        documents.extend(page_documents)
        audits.append(audit)

    _assert_unique_external_ids(documents)
    return documents, audits


def _assert_unique_external_ids(documents: Sequence[Document]) -> None:
    """Two sections with the same heading would collide on external_id."""
    seen: set[str] = set()
    collisions: list[str] = []
    for doc in documents:
        if doc.external_id in seen:
            collisions.append(doc.external_id)
        seen.add(doc.external_id)
    if collisions:
        raise WikiConnectorError(
            f"Duplicate external_ids emitted: {sorted(set(collisions))[:10]}"
        )


def iter_audit_rows(audits: Sequence[PageAudit]) -> Iterator[dict]:
    for audit in audits:
        yield {
            "path": audit.path,
            "title": audit.title,
            "tier": audit.tier,
            "domains": ",".join(audit.domains),
            "matched_by": audit.matched_by,
            "signals": ",".join(audit.signals),
            "has_summary": audit.has_summary,
        }
