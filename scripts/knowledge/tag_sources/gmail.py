"""Gmail tags: a label named `<prefix><topic>`.

The label is on the thread itself, so it is a content tag. Gmail has no
container. Labels that do not start with the prefix are not tags.
"""

from __future__ import annotations

from typing import Any


def label_tags(label_names: Any, prefix: str) -> tuple[str, ...]:
    """The label names that are tags, as written, without repeats."""
    if not isinstance(prefix, str) or not prefix:
        raise ValueError("a tag prefix is required")
    if isinstance(label_names, str):
        label_names = (label_names,)
    if not isinstance(label_names, (list, tuple, set, frozenset)):
        return ()
    lowered = prefix.lower()
    names = sorted(label_names) if isinstance(label_names, (set, frozenset)) else label_names
    tags = (
        name.strip()
        for name in names
        if isinstance(name, str) and name.strip().lower().startswith(lowered)
    )
    return tuple(dict.fromkeys(tag for tag in tags if len(tag) > len(prefix)))
