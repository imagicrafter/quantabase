"""Minimal YAML frontmatter parsing for wiki pages.

Uses PyYAML when available and falls back to a small line parser covering the
shapes this wiki actually uses: scalars, inline `[a, b]` lists, and block lists.
The fallback exists so a backfill is not blocked by a missing dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

_DELIMITER = "---"


@dataclass(frozen=True, slots=True)
class ParsedPage:
    """Frontmatter mapping plus the body with frontmatter stripped."""

    frontmatter: dict[str, Any]
    body: str


def _parse_inline_list(raw: str) -> list[str]:
    inner = raw.strip()[1:-1]
    return [
        item.strip().strip("\"'")
        for item in inner.split(",")
        if item.strip().strip("\"'")
    ]


def _fallback_parse(block: str) -> dict[str, Any]:
    """Line parser for the subset of YAML this wiki uses."""
    result: dict[str, Any] = {}
    current_key: str | None = None

    for line in block.splitlines():
        if not line.strip():
            continue

        if line.startswith((" ", "\t", "-")) and current_key:
            item = line.strip()
            if item.startswith("- "):
                value = item[2:].strip().strip("\"'")
                if value:
                    existing = result.get(current_key)
                    if isinstance(existing, list):
                        existing.append(value)
                    else:
                        result[current_key] = [value]
            continue

        if ":" not in line:
            continue

        key, _, raw_value = line.partition(":")
        key = key.strip()
        value = raw_value.strip()
        current_key = key

        if not value:
            result[key] = []
        elif value.startswith("[") and value.endswith("]"):
            result[key] = _parse_inline_list(value)
        else:
            result[key] = value.strip("\"'")

    return result


def parse(text: str) -> ParsedPage:
    """Split a markdown document into frontmatter and body.

    A page without frontmatter returns an empty mapping and the untouched text.
    Malformed frontmatter is treated as absent rather than raising -- one bad page
    must not abort a 275-page backfill.
    """
    if not text.startswith(_DELIMITER):
        return ParsedPage(frontmatter={}, body=text)

    lines = text.splitlines(keepends=True)
    closing_index: int | None = None
    for index in range(1, len(lines)):
        if lines[index].rstrip() == _DELIMITER:
            closing_index = index
            break

    if closing_index is None:
        return ParsedPage(frontmatter={}, body=text)

    block = "".join(lines[1:closing_index])
    body = "".join(lines[closing_index + 1 :]).lstrip("\n")

    try:
        import yaml

        parsed = yaml.safe_load(block)
        if not isinstance(parsed, dict):
            parsed = _fallback_parse(block)
    except Exception:
        parsed = _fallback_parse(block)

    return ParsedPage(frontmatter=parsed or {}, body=body)


def as_list(value: Any) -> list[str]:
    """Coerce a frontmatter value to a list of strings."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item is not None]
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            return _parse_inline_list(stripped)
        return [stripped] if stripped else []
    return [str(value)]


def as_datetime(value: Any) -> datetime | None:
    """Coerce a frontmatter date value to a timezone-aware datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    if isinstance(value, str):
        candidate = value.strip().strip("\"'")
        if not candidate:
            return None
        try:
            parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None
