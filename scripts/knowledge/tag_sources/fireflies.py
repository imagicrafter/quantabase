"""Fireflies tags.

Container: the meeting's channel. A channel named `<prefix><topic>` is a tag,
and so is a channel listed in `sources.fireflies.channels` (name -> topic).

Content: once a wiki meeting page exists and carries the frontmatter key, the
page's value is the tag -- the page is the source of truth from then on.

A meeting someone else recorded and shared carries THEIR channels, which the
owner did not choose, so those are ignored.
"""

from __future__ import annotations

from typing import Any, Mapping

from . import wiki

CHANNELS_FIELD = "channels"
SHARED_FLAG = "_shared"
_NAME_KEYS = ("title", "name")


def _name(channel: Any) -> str:
    if isinstance(channel, str):
        return channel.strip()
    if isinstance(channel, Mapping):
        for key in _NAME_KEYS:
            value = channel.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def channel_names(raw: Any) -> tuple[str, ...]:
    """Names of the channels a Fireflies transcript sits in. Empty if unknown."""
    if not isinstance(raw, Mapping) or raw.get(SHARED_FLAG):
        return ()
    channels = raw.get(CHANNELS_FIELD)
    if isinstance(channels, (str, Mapping)):
        channels = [channels]
    if not isinstance(channels, (list, tuple)):
        return ()
    names = (_name(channel) for channel in channels)
    return tuple(dict.fromkeys(name for name in names if name))


def channel_tags(
    names: Any, prefix: str, channel_map: Mapping[str, str] | None = None
) -> tuple[str, ...]:
    """Tags carried by channel names: a prefixed name, or one the map names."""
    mapped = {
        str(name).strip().lower(): topic
        for name, topic in (channel_map or {}).items()
        if isinstance(topic, str) and topic.strip()
    }
    lowered_prefix = (prefix or "").lower()
    tags: list[str] = []
    for name in names or ():
        if not isinstance(name, str) or not name.strip():
            continue
        key = name.strip().lower()
        if key in mapped:
            tags.append(mapped[key])
        if lowered_prefix and key.startswith(lowered_prefix):
            tags.append(name.strip())
    return tuple(dict.fromkeys(tags))


def meeting_tags(
    raw: Any,
    page_frontmatter: Any,
    *,
    prefix: str,
    channel_map: Mapping[str, str] | None = None,
    frontmatter_key: str = wiki.DEFAULT_KEY,
) -> tuple[tuple[str, ...], tuple[tuple[str, ...], ...]]:
    """(content_tags, container_tags) for one meeting."""
    content = wiki.content_tags(page_frontmatter, frontmatter_key)
    channels = channel_tags(channel_names(raw), prefix, channel_map)
    return content, ((channels,) if channels else ())
