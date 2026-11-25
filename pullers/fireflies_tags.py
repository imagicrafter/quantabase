"""Where a Fireflies meeting's topics come from.

  container tag  the meeting's channel: named `<prefix><topic>`, or listed in
                 `sources.fireflies.channels`
  content tag    the wiki meeting page's frontmatter key, once the page exists
                 and carries it -- from then on the page is the source of truth

`stamp_pages` reads the pages (the only I/O here) and puts what each page says
on its raw payload, so `fireflies.to_document` stays a pure function of the
payload.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Mapping

from knowledge.engine_config import UNCLASSIFIED, get_config
from knowledge.frontmatter import parse as parse_frontmatter
from knowledge.tag_resolver import (
    MATCH_CONTAINER,
    MATCH_CONTENT,
    MATCH_DEFAULT,
    DomainAssignment,
    prefix_for,
    resolve,
)
from knowledge.tag_sources import fireflies as fireflies_source, wiki as wiki_source

SOURCE = "fireflies"
MEETINGS_DIR = "meetings"
# Stamped on a raw payload by `stamp_pages`:
PAGE_FRONTMATTER = "_page_frontmatter"  # this meeting's own page (or None)
PAGE_DOUBTFUL = "_page_doubtful"        # a page that may belong to another recording
PAGE_CONFLICT = "_page_conflict"        # several pages claim this recording and disagree
AMBIGUOUS_PAGE = "ambiguous_page"
_WRITABLE = (MATCH_CONTENT, MATCH_CONTAINER)


def _resolve(raw: dict, page: Any, config: Any) -> DomainAssignment:
    content, containers = fireflies_source.meeting_tags(
        raw,
        page,
        prefix=prefix_for(SOURCE, config),
        channel_map=config.sources.fireflies.channels,
        frontmatter_key=config.tagging.frontmatter_key,
    )
    return resolve(SOURCE, content, containers, config)


def assignment(raw: dict, config: Any) -> DomainAssignment:
    """Topics for one transcript payload (already stamped, or not).

    A page that is certainly this meeting's decides. A page that only shares
    the meeting's name (another recording of the same title and day) is used
    only when it agrees with what the meeting gets on its own; if they differ
    the meeting is `unclassified`, because either answer could be the wider one.
    """
    ambiguous = DomainAssignment((UNCLASSIFIED,), MATCH_DEFAULT, (AMBIGUOUS_PAGE,))
    if raw.get(PAGE_CONFLICT):
        return ambiguous
    own = _resolve(raw, raw.get(PAGE_FRONTMATTER), config)
    doubtful = raw.get(PAGE_DOUBTFUL)
    if doubtful is None:
        return own
    other = _resolve(raw, doubtful, config)
    if other.matched_by == MATCH_CONTENT and set(other.domains) != set(own.domains):
        return ambiguous
    return own


def _read(root: Path, rel: str, key: str) -> Mapping[str, Any]:
    text = (root / rel).read_text(encoding="utf-8")
    return wiki_source.frontmatter_for_tags(text, parse_frontmatter(text).frontmatter, key)


def _pages_for(root: Path, raw: dict, external_id: str, by_fid: dict, key: str) -> dict:
    """What to stamp on one payload: its own page, a doubtful one, or a conflict."""
    from pullers.fireflies import _external_id as page_name

    own = by_fid.get(str(raw.get("id") or ""), [])
    if own:
        pages = [_read(root, rel, key) for rel in own]
        disagree = len({wiki_source.content_tags(page, key) for page in pages}) > 1
        return {PAGE_FRONTMATTER: pages[0], PAGE_DOUBTFUL: None, PAGE_CONFLICT: disagree}

    bare = page_name(_title(raw), external_id[:10])
    for name in dict.fromkeys((external_id, bare)):
        rel = f"{MEETINGS_DIR}/{name}"
        if not (root / rel).is_file():
            continue
        page = _read(root, rel, key)
        certain = name == external_id and not str(page.get("fireflies_id") or "").strip()
        return {
            PAGE_FRONTMATTER: page if certain else None,
            PAGE_DOUBTFUL: None if certain else page,
            PAGE_CONFLICT: False,
        }
    return {PAGE_FRONTMATTER: None, PAGE_DOUBTFUL: None, PAGE_CONFLICT: False}


def _title(raw: dict) -> str:
    return (raw.get("title") or "Untitled Meeting").strip()


def stamp_pages(
    raws: list[dict], root: Path, external_id_of: Callable[[dict], str]
) -> list[dict]:
    """New payloads, each carrying what its meeting page says (see `_pages_for`).

    A page is certainly a meeting's own when it carries the recording's
    `fireflies_id`, or is named exactly for it and carries no id. A page that
    cannot be read raises: a topic must never be guessed.
    """
    from pullers import meeting_writeback

    key = get_config().tagging.frontmatter_key
    by_fid = meeting_writeback.pages_by_fireflies_id(root)
    return [
        {**raw, **_pages_for(root, raw, external_id_of(raw), by_fid, key)} for raw in raws
    ]


def writable_topics(document: Any) -> tuple[str, ...]:
    """The topics a new meeting page may be written with: only ones that came
    from a real tag (the channel, or a page). A source default or an old
    stored value is never frozen into a page."""
    if getattr(document, "tag_source", None) not in _WRITABLE:
        return ()
    return tuple(topic for topic in document.domains if topic != UNCLASSIFIED)


def page_topics(existing: str | None, resolved: tuple[str, ...], key: str) -> tuple[str, ...]:
    """The topics to write into a meeting page's frontmatter.

    A tag already on the page is kept as written -- a person may have changed
    it. Otherwise the resolved topics, except `unclassified`: an untagged
    meeting writes no key, so tagging its channel later still takes effect.
    """
    if existing is not None:
        kept = wiki_source.content_tags(parse_frontmatter(existing).frontmatter, key)
        if kept:
            return kept
    return tuple(topic for topic in resolved if topic != UNCLASSIFIED)
