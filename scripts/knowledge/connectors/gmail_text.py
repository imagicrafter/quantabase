"""Turn the messages of a Gmail thread into the text that gets indexed.

Pure functions over the API's message payloads; no I/O. The plain-text part
of a message is used when there is one; otherwise the HTML part with its
markup, scripts and styles removed.
"""

from __future__ import annotations

import base64
import binascii
import html
import re
from datetime import datetime, timezone
from email.utils import getaddresses, parsedate_to_datetime
from typing import Any, Sequence

_DROPPED_BLOCKS = re.compile(r"<(script|style|head)\b.*?</\1\s*>", re.I | re.S)
_TAGS = re.compile(r"<[^>]*>")
_BLANK_RUNS = re.compile(r"\n\s*\n\s*\n+")
_SPACES = re.compile(r"[ \t\r\f\v]+")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MAX_DEPTH = 20


def _decode(data: Any) -> str:
    if not isinstance(data, str) or not data:
        return ""
    try:
        raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
    except (binascii.Error, ValueError):
        return ""
    return raw.decode("utf-8", errors="replace")


def _parts(payload: Any, depth: int = 0) -> list[dict]:
    """Every leaf part of a payload, in order."""
    if not isinstance(payload, dict) or depth > _MAX_DEPTH:
        return []
    children = payload.get("parts")
    if isinstance(children, list) and children:
        return [leaf for child in children for leaf in _parts(child, depth + 1)]
    return [payload]


def html_to_text(markup: str) -> str:
    """Readable text from HTML: no tags, no script or style content."""
    stripped = _TAGS.sub(" ", _DROPPED_BLOCKS.sub(" ", markup))
    return html.unescape(stripped)


def clean(text: str) -> str:
    """One tidy block of text: no control characters, no runs of blank lines."""
    text = _CONTROL.sub("", text)
    lines = (_SPACES.sub(" ", line).strip() for line in text.split("\n"))
    return _BLANK_RUNS.sub("\n\n", "\n".join(lines)).strip()


def message_text(payload: Any) -> str:
    """The text of one message: its plain part, else its HTML part as text."""
    leaves = _parts(payload)
    for leaf in leaves:
        if leaf.get("mimeType") == "text/plain":
            text = _decode((leaf.get("body") or {}).get("data"))
            if text.strip():
                return clean(text)
    for leaf in leaves:
        if leaf.get("mimeType") == "text/html":
            text = html_to_text(_decode((leaf.get("body") or {}).get("data")))
            if text.strip():
                return clean(text)
    return ""


def header(message: dict, name: str) -> str:
    """One header of a message, as one clean line ("" when absent)."""
    wanted = name.lower()
    for item in (message.get("payload") or {}).get("headers") or []:
        if isinstance(item, dict) and str(item.get("name", "")).lower() == wanted:
            return clean(str(item.get("value") or "")).replace("\n", " ")
    return ""


def participants(messages: Sequence[dict]) -> list[str]:
    """Every From/To/Cc address in the thread, lower-cased, in first-seen order."""
    raw = [header(m, name) for m in messages for name in ("From", "To", "Cc")]
    found = (address.strip().lower() for _name, address in getaddresses([r for r in raw if r]))
    return list(dict.fromkeys(address for address in found if "@" in address))


def sent_at(message: dict) -> datetime | None:
    """When a message was sent, from its Date header; None if unreadable."""
    try:
        parsed = parsedate_to_datetime(header(message, "Date"))
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def assemble(messages: Sequence[dict], max_chars: int) -> tuple[str, str]:
    """(thread text, newest subject). Messages in order, each under its headers."""
    blocks = []
    subject = ""
    for message in messages:
        this_subject = header(message, "Subject")
        subject = this_subject or subject
        blocks.append(
            f"From: {header(message, 'From')}\nDate: {header(message, 'Date')}\n"
            f"Subject: {this_subject}\n{message_text(message.get('payload'))}\n---"
        )
    return "\n\n".join(blocks)[:max_chars], subject
