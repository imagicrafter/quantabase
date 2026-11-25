"""Drive tags: the text `<prefix><topic>` anywhere in a Description field.

A file's own description is its content tag. Each ancestor folder's
description is a container tag; the caller passes the folders nearest first,
so the resolver stops at the nearest tagged one.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Sequence

DESCRIPTION_FIELD = "description"
# `/` is taken as part of the tag so `kx/a/b` reads as the (unknown) topic
# `a/b`, never as a shortened `a`.
_TOPIC = r"[A-Za-z0-9][A-Za-z0-9_/-]*"


def tag_pattern(prefix: str) -> re.Pattern[str]:
    """Matches one tag. The prefix must not be glued to a word before it."""
    if not isinstance(prefix, str) or not prefix:
        raise ValueError("a tag prefix is required")
    return re.compile(rf"(?<![A-Za-z0-9]){re.escape(prefix)}({_TOPIC})", re.IGNORECASE)


def tags_in(description: Any, prefix: str) -> tuple[str, ...]:
    """Every `<prefix><topic>` in one description, as written, without repeats."""
    if not isinstance(description, str) or not description:
        return ()
    pattern = tag_pattern(prefix)
    found = (f"{prefix}{match.group(1).rstrip('-_/')}" for match in pattern.finditer(description))
    return tuple(dict.fromkeys(found))


def _description(item: Any) -> Any:
    return item.get(DESCRIPTION_FIELD) if isinstance(item, Mapping) else None


def item_tags(
    item: Any, ancestors: Sequence[Any], prefix: str
) -> tuple[tuple[str, ...], tuple[tuple[str, ...], ...]]:
    """(content_tags, container_tags) for one Drive item.

    `ancestors` are the folders above the item, nearest first.
    """
    content = tags_in(_description(item), prefix)
    containers = tuple(tags_in(_description(folder), prefix) for folder in ancestors or ())
    return content, containers
