"""Decide a document's topics ("domains") from tags a person can see and change.

There are no keyword rules, no filename matching and no directory rules. The
only inputs are tags read at the source, in this order:

  1. content tag    -- on the item itself
  2. container tag  -- on what holds it (a Drive folder, a Fireflies channel),
                       nearest container first
  3. the source's `default_domain` from the Engine config
  4. `unclassified` -- reserved, sensitive, owner-only

A tag is `<prefix><topic id>` (the prefix is optional in wiki frontmatter).
The prefix is the source's own (`sources.<source>.prefix`) when set, otherwise
`tagging.prefix`. Matching ignores case.

The level that decides is the first one carrying any tag. If any tag on that
level names a topic the config does not declare, the item is `unclassified`
and an `unknown_tag` signal is recorded: a mistyped tag must never fall
through to a wider audience further down the order.

Pure functions, no I/O. Nothing here reads the config cache: the caller passes
the config in.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from .engine_config import UNCLASSIFIED

MATCH_CONTENT = "content"
MATCH_CONTAINER = "container"
MATCH_SOURCE_DEFAULT = "source_default"
MATCH_DEFAULT = "default"
MATCHED_BY = (MATCH_CONTENT, MATCH_CONTAINER, MATCH_SOURCE_DEFAULT, MATCH_DEFAULT)

SOURCES = ("wiki", "drive", "fireflies", "gmail")

# Marker stored in `documents.tag_signals`; the detail entries carry the text.
UNKNOWN_TAG = "unknown_tag"
UNKNOWN_DEFAULT = "unknown_default"
# A tag was found on an item the source does not trust tags from (Drive: an
# item the signed-in account does not own) and was ignored.
IGNORED_FOREIGN_TAG = "ignored_foreign_tag"
_SIGNAL_TEXT_MAX = 64
_QUOTES = "\"'"


@dataclass(frozen=True, slots=True)
class DomainAssignment:
    """The resolved topics plus how they were reached, so every row can be audited."""

    domains: tuple[str, ...]
    matched_by: str  # one of MATCHED_BY
    signals: tuple[str, ...]


def has_unknown_tag(signals: Iterable[str]) -> bool:
    return UNKNOWN_TAG in tuple(signals)


def _source_settings(source: str, config: Any) -> Any:
    if config is None or not hasattr(config, "sources"):
        raise ValueError("resolve() needs the Engine config")
    if source not in SOURCES:
        raise ValueError(f"unknown source {source!r}; expected one of {SOURCES}")
    return getattr(config.sources, source)


def prefix_for(source: str, config: Any) -> str:
    """The tag prefix for one source: its own when set, else the general one."""
    own = getattr(_source_settings(source, config), "prefix", None)
    return own or config.tagging.prefix


def topic_of(tag: Any, prefix: str) -> str | None:
    """The topic id a raw tag names, lower-cased, or None when it names nothing.

    Not validated against the config here -- `resolve` does that.
    """
    if not isinstance(tag, str):
        return None
    text = tag.strip().strip(_QUOTES).strip()
    if prefix and text.lower().startswith(prefix.lower()):
        text = text[len(prefix):].strip()
    return text.lower() or None


def _as_tags(value: Any) -> tuple[Any, ...]:
    """One level of tags. A lone string is one tag, never a list of letters."""
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, (list, tuple, set, frozenset)):
        return tuple(value)
    return ()


def _levels(container_tags: Any) -> tuple[tuple[Any, ...], ...]:
    """Container tags as levels, nearest first. Each entry is one container."""
    return tuple(_as_tags(level) for level in _as_tags(container_tags))


def _topics(tags: Sequence[Any], prefix: str) -> tuple[str, ...]:
    found = (topic_of(tag, prefix) for tag in tags)
    return tuple(dict.fromkeys(topic for topic in found if topic))


def _decide(topics: tuple[str, ...], matched_by: str, known: frozenset[str]) -> DomainAssignment:
    unknown = tuple(topic for topic in topics if topic not in known)
    if unknown:
        details = tuple(f"{UNKNOWN_TAG}:{topic[:_SIGNAL_TEXT_MAX]}" for topic in unknown)
        return DomainAssignment((UNCLASSIFIED,), matched_by, (UNKNOWN_TAG, *details))
    ordered = tuple(sorted(topics))
    return DomainAssignment(ordered, matched_by, ordered)


def _default(settings: Any, known: frozenset[str]) -> DomainAssignment:
    default = getattr(settings, "default_domain", None)
    if isinstance(default, str) and default in known:
        return DomainAssignment((default,), MATCH_SOURCE_DEFAULT, ())
    if default:
        signal = f"{UNKNOWN_DEFAULT}:{str(default)[:_SIGNAL_TEXT_MAX]}"
        return DomainAssignment((UNCLASSIFIED,), MATCH_DEFAULT, (signal,))
    return DomainAssignment((UNCLASSIFIED,), MATCH_DEFAULT, ())


def resolve(
    source: str,
    content_tags: Any,
    container_tags: Any,
    config: Any,
) -> DomainAssignment:
    """Resolve one item's topics.

    Args:
        source: `wiki`, `drive`, `fireflies` or `gmail`.
        content_tags: tags on the item itself.
        container_tags: one entry per container, nearest first. An entry is a
            list of that container's tags (or a single tag).
        config: the Engine config (`engine_config.EngineConfig`).
    """
    settings = _source_settings(source, config)
    prefix = prefix_for(source, config)
    known = frozenset(config.domain_ids)

    content = _topics(_as_tags(content_tags), prefix)
    if content:
        return _decide(content, MATCH_CONTENT, known)

    for level in _levels(container_tags):
        topics = _topics(level, prefix)
        if topics:
            return _decide(topics, MATCH_CONTAINER, known)

    return _default(settings, known)
