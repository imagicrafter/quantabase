"""Wiki tags: one frontmatter key (`tagging.frontmatter_key`, default `domains`).

    domains: [consulting, properties]
    domains: consulting

The value is a list or a single string of topic ids. No prefix is needed in
frontmatter (one is tolerated). A wiki page has no container.

A key that is there but cannot be read as topic ids (a mapping, a nested
list, a YAML boolean), or a frontmatter block that cannot be read at all, is
reported as the tag `?unreadable`. That is never a declared topic, so the page
becomes `unclassified` with an `unknown_tag` signal instead of quietly taking
the source default.
"""

from __future__ import annotations

from typing import Any, Mapping

DEFAULT_KEY = "domains"
UNREADABLE = "?unreadable"
_BOM = "\ufeff"
_DELIMITER = "---"


def _split(text: str) -> tuple[str, ...]:
    inner = text.strip()
    if inner.startswith("[") and inner.endswith("]"):
        inner = inner[1:-1]
    return tuple(part.strip() for part in inner.split(",") if part.strip())


def _texts(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return _split(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (str(value),)
    return (UNREADABLE,)


def content_tags(frontmatter: Any, key: str = DEFAULT_KEY) -> tuple[str, ...]:
    """The page's own tags, in the order written. Empty when the key is absent."""
    if not isinstance(frontmatter, Mapping) or not key:
        return ()
    value = frontmatter.get(key)
    items = value if isinstance(value, (list, tuple)) else (value,)
    return tuple(dict.fromkeys(text for item in items for text in _texts(item)))


def frontmatter_for_tags(text: Any, frontmatter: Any, key: str = DEFAULT_KEY) -> Mapping[str, Any]:
    """The frontmatter to read tags from.

    A page that opens a frontmatter block which could not be read (never
    closed, or hidden behind a byte-order mark) may be carrying a tag nobody
    can see. It is given the `?unreadable` tag rather than treated as untagged.
    """
    if isinstance(frontmatter, Mapping) and frontmatter:
        return frontmatter
    if isinstance(text, str) and text.lstrip(_BOM).startswith(_DELIMITER):
        return {key: UNREADABLE}
    return {}


def has_key(frontmatter: Any, key: str = DEFAULT_KEY) -> bool:
    """True when the page carries the key with at least one tag."""
    return bool(content_tags(frontmatter, key))
