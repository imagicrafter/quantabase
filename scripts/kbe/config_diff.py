"""A human-readable diff between two Engine configs. No I/O here.

`current` is what the database has applied (or None on a first apply); `new`
is the validated file about to be applied. Both are plain parsed mappings.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping

from knowledge.config_hash import config_hash as _shared_hash

from .errors import KbeError

_ABSENT = object()


@dataclass(frozen=True)
class ConfigDiff:
    first_apply: bool
    lines: tuple[str, ...] = ()
    # Changes the database is known to refuse, said up front.
    warnings: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.first_apply and not self.lines


def config_hash(config: Mapping[str, Any]) -> str:
    """SHA-256 of the config's canonical JSON (knowledge.config_hash, shared with the pullers)."""
    try:
        return _shared_hash(config)
    except ValueError as error:
        text = str(error)
        raise KbeError(f"{text[0].upper()}{text[1:]}.") from error


def _show(value: Any) -> str:
    if value is _ABSENT:
        return "(not set)"
    return json.dumps(value, ensure_ascii=False)


def _flatten(node: Any, prefix: str = "") -> dict[str, Any]:
    """Nested mappings as dotted paths. Lists and scalars are leaves."""
    if not isinstance(node, Mapping) or (not node and prefix):
        return {prefix: node}
    flat: dict[str, Any] = {}
    for key, value in node.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        flat = {**flat, **_flatten(value, path)}
    return flat


def _topics(config: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    items = config.get("domains") or []
    return {str(t.get("id")): t for t in items if isinstance(t, Mapping)}


def _topic_lines(old: Mapping, new: Mapping) -> tuple[list[str], list[str]]:
    before, after = _topics(old), _topics(new)
    lines: list[str] = []
    warnings: list[str] = []
    for topic_id in sorted(after.keys() - before.keys()):
        topic = after[topic_id]
        lock = " (sensitive)" if topic.get("sensitive") else ""
        lines.append(f'+ topic {topic_id}: "{topic.get("label")}"{lock}')
    for topic_id in sorted(before.keys() - after.keys()):
        lines.append(f'- topic {topic_id}: "{before[topic_id].get("label")}"')
        warnings.append(
            f"topic {topic_id}: the database refuses to remove a topic that still "
            "has documents or grants."
        )
    for topic_id in sorted(before.keys() & after.keys()):
        was, now = before[topic_id], after[topic_id]
        if was.get("label") != now.get("label"):
            lines.append(f'~ topic {topic_id}: label "{was.get("label")}" -> "{now.get("label")}"')
        locked_before, locked_now = bool(was.get("sensitive")), bool(now.get("sensitive"))
        if locked_now and not locked_before:
            lines.append(f"~ topic {topic_id}: becomes sensitive")
        if locked_before and not locked_now:
            lines.append(f"~ topic {topic_id}: no longer sensitive")
            warnings.append(
                f"topic {topic_id}: the database refuses to unlock a sensitive "
                "topic from a config; an administrator must do it."
            )
    return lines, warnings


def _setting_line(path: str, was: Any, now: Any) -> str:
    parts = path.split(".")
    if parts[0] == "sources" and len(parts) == 3 and parts[2] == "enabled":
        return f"~ source {parts[1]}: turned {'on' if now is True else 'off'}"
    if parts[0] == "sources" and len(parts) >= 3:
        return f"~ source {parts[1]}: {'.'.join(parts[2:])} {_show(was)} -> {_show(now)}"
    if path == "engine.owner.email":
        return f"~ owner: {_show(was)} -> {_show(now)}"
    return f"~ {path}: {_show(was)} -> {_show(now)}"


def _setting_lines(old: Mapping, new: Mapping) -> tuple[list[str], list[str]]:
    skip = ("domains",)
    before = _flatten({k: v for k, v in old.items() if k not in skip})
    after = _flatten({k: v for k, v in new.items() if k not in skip})
    lines = [
        _setting_line(path, before.get(path, _ABSENT), after.get(path, _ABSENT))
        for path in sorted(before.keys() | after.keys())
        if before.get(path, _ABSENT) != after.get(path, _ABSENT)
    ]
    owner_changed = (
        str(before.get("engine.owner.email", "")).strip().lower()
        != str(after.get("engine.owner.email", "")).strip().lower()
    )
    warnings = (
        ["owner: the database refuses a new owner unless that person is already "
         "an active administrator."]
        if owner_changed
        else []
    )
    return lines, warnings


def _first_apply_lines(new: Mapping[str, Any]) -> list[str]:
    flat = _flatten(new)
    lines = [
        f"+ engine: {_show(flat.get('engine.name'))} ({flat.get('engine.id')})",
        f"+ owner: {_show(flat.get('engine.owner.email'))} becomes the first administrator",
    ]
    for topic_id, topic in sorted(_topics(new).items()):
        lock = " (sensitive)" if topic.get("sensitive") else ""
        lines.append(f'+ topic {topic_id}: "{topic.get("label")}"{lock}')
    lines.append("+ topic unclassified (always there; owner only)")
    sources = new.get("sources") or {}
    for name in sorted(sources):
        on = isinstance(sources[name], Mapping) and sources[name].get("enabled") is True
        lines.append(f"+ source {name}: {'on' if on else 'off'}")
    return lines


def diff(current: Mapping[str, Any] | None, new: Mapping[str, Any]) -> ConfigDiff:
    """What applying `new` over `current` would change."""
    if not current:
        return ConfigDiff(first_apply=True, lines=tuple(_first_apply_lines(new)))
    topic_lines, topic_warnings = _topic_lines(current, new)
    setting_lines, setting_warnings = _setting_lines(current, new)
    return ConfigDiff(
        first_apply=False,
        lines=tuple(topic_lines + setting_lines),
        warnings=tuple(topic_warnings + setting_warnings),
    )


def render(change: ConfigDiff) -> str:
    """The diff as text for a person."""
    if change.is_empty:
        return "No changes: this config matches what the database has applied."
    title = (
        "No config has been applied yet. This will set:"
        if change.first_apply
        else "Changes this will make:"
    )
    body = [title, *(f"  {line}" for line in change.lines)]
    if change.warnings:
        body = [*body, "", "Heads up:", *(f"  ! {w}" for w in change.warnings)]
    return "\n".join(body)
