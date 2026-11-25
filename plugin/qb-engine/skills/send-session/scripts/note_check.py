"""Check a session note before it is sent (send-session).

The same shape and limits as the Engine's own check (engine
src/sources/session-note.ts), so a mistake is caught here, in plain words,
before the person is asked. Every string is scrubbed of secret-looking text,
and every quote from the owner or Claude must appear word for word in the
session (spacing, curly quotes, dashes and markdown stars or backticks
aside). Stdlib only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from session_scrub import scrub

LABELS = ("decided", "fact", "status", "how-to", "idea")
WHO = {"owner": "Owner", "assistant": "Assistant", "tool": "Tool output"}
WHERE = {"owner": "what the owner wrote", "assistant": "Claude's replies"}
MAX_ITEMS, MAX_CHARS = 30, 20_000
TOOL_QUOTE_CHARS = 200
MIN_QUOTE_WORDS, MIN_QUOTE_CHARS = 2, 8  # shorter matches almost anything
_SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
_DRAWER_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
_TYPO = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-"})


@dataclass(frozen=True)
class Result:
    note: dict
    errors: list = field(default_factory=list)
    redactions: int = 0
    checked: int = 0
    unchecked: int = 0


def iso_time(ts) -> Optional[str]:
    """An ISO date and time in UTC with a Z, or None when it is not one."""
    if not isinstance(ts, str) or not ts:
        return None
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    parsed = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _scrubbed(value, counter: list):
    """A copy of the value with every string scrubbed; counter[0] counts redactions."""
    if isinstance(value, str):
        text, n = scrub(value)
        counter[0] += n
        return text
    if isinstance(value, list):
        return [_scrubbed(v, counter) for v in value]
    if isinstance(value, dict):
        return {k: _scrubbed(v, counter) for k, v in value.items()}
    return value


def _text(value, low: int, high: int) -> bool:
    return isinstance(value, str) and low <= len(value.strip()) <= high


def _keys(obj, allowed: set, where: str) -> list:
    if not isinstance(obj, dict):
        return [f"{where}: must be an object"]
    return [f"{where}: unknown field {k}" for k in obj if k not in allowed]


def _quote_errors(quote, where: str) -> list:
    errors = _keys(quote, {"who", "text"}, where)
    if errors:
        return errors
    if quote.get("who") not in WHO:
        errors.append(f"{where}: who must be owner, assistant or tool")
    if not _text(quote.get("text"), 1, 400):
        errors.append(f"{where}: text must be 1 to 400 characters")
    elif quote.get("who") == "tool" and len(quote["text"]) > TOOL_QUOTE_CHARS:
        errors.append(f"{where}: tool output quotes are at most {TOOL_QUOTE_CHARS} characters")
    elif quote.get("who") in WHERE:
        want = normal(quote["text"])
        if len(want.split()) < MIN_QUOTE_WORDS or len(want) < MIN_QUOTE_CHARS:
            errors.append(f"{where}: too short to check; quote at least {MIN_QUOTE_WORDS} words of the sentence")
    return errors


def _key_error(key, where: str) -> list:
    if not _text(key, 1, 200) or re.search(r"\s", key.strip()):
        return [f"{where}: key must be the page key, 1 to 200 characters, no spaces"]
    return []


def _hint_errors(item: dict, n: int) -> list:
    errors: list = []
    pages, new_pages = item.get("pages", []), item.get("new_pages", [])
    if not isinstance(pages, list) or len(pages) > 4:
        return [f"item {n}: at most 4 pages to consider"]
    if not isinstance(new_pages, list) or len(new_pages) > 2:
        return [f"item {n}: at most 2 new pages"]
    for j, p in enumerate(pages, 1):
        where = f"item {n}, page {j}"
        errors += _keys(p, {"key", "title", "whats_new"}, where)
        if isinstance(p, dict):
            errors += _key_error(p.get("key"), where)
            if not _text(p.get("title"), 1, 200) or not _text(p.get("whats_new"), 1, 300):
                errors.append(f"{where}: title (to 200) and whats_new (to 300) are needed")
    for j, p in enumerate(new_pages, 1):
        where = f"item {n}, new page {j}"
        errors += _keys(p, {"drawer", "title", "key", "why"}, where)
        if isinstance(p, dict):
            if "key" in p:
                errors += _key_error(p["key"], where)
            if not isinstance(p.get("drawer"), str) or not _DRAWER_RE.match(p["drawer"]):
                errors.append(f"{where}: drawer must be a drawer id such as projects or decisions")
            if not _text(p.get("title"), 1, 120) or not _text(p.get("why"), 1, 300):
                errors.append(f"{where}: title (to 120) and why (to 300) are needed")
    return errors


def _item_errors(item, n: int) -> list:
    errors = _keys(item, {"label", "text", "quotes", "pages", "new_pages"}, f"item {n}")
    if not isinstance(item, dict):
        return errors
    if item.get("label") not in LABELS:
        errors.append(f"item {n}: label must be one of {', '.join(LABELS)}")
    if not _text(item.get("text"), 1, 600):
        errors.append(f"item {n}: text must be 1 to 600 characters")
    quotes = item.get("quotes")
    if not isinstance(quotes, list) or not 1 <= len(quotes) <= 3:
        errors.append(f"item {n}: needs 1 to 3 quotes")
    else:
        for j, q in enumerate(quotes, 1):
            errors += _quote_errors(q, f"item {n}, quote {j}")
        if not any(isinstance(q, dict) and q.get("who") in WHERE for q in quotes):
            errors.append(f"item {n}: needs at least one quote from the owner or assistant (tool output alone is not evidence)")
    return errors + _hint_errors(item, n)


def _shape_errors(note: dict) -> list:
    errors = _keys(note, {"session_id", "project", "title", "started_at", "ended_at", "items"}, "note")
    if "title" in note and not _text(note["title"], 1, 120):
        errors.append("title must be 1 to 120 characters (a few words naming what the session was about)")
    if not isinstance(note.get("session_id"), str) or not _SESSION_RE.match(note["session_id"]):
        errors.append("session_id must be the session id (letters, digits, dashes)")
    if not _text(note.get("project"), 1, 100):
        errors.append("project must be 1 to 100 characters")
    for name in ("started_at", "ended_at"):
        if name in note and iso_time(note[name]) is None:
            errors.append(f"{name} must be a date and time such as 2026-11-24T10:00:00Z")
    items = note.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        return errors + [f"the note needs 1 to {MAX_ITEMS} items"]
    for n, item in enumerate(items, 1):
        errors += _item_errors(item, n)
    return errors


def normal(text: str) -> str:
    """Text as compared: typography, markdown stars and backticks, and spacing aside."""
    text = re.sub(r"[*`]", "", text.translate(_TYPO))
    return " ".join(text.split()).strip('"')


def _verify(note: dict, transcript: Optional[dict]) -> tuple:
    errors, checked, unchecked = [], 0, 0
    said = {role: [normal(t) for t in transcript.get(role, [])] for role in WHERE} if transcript is not None else None
    for n, item in enumerate(note["items"], 1):
        for j, q in enumerate(item["quotes"], 1):
            if said is None or q["who"] == "tool":
                unchecked += 1
                continue
            want = normal(q["text"])
            if any(want in t for t in said[q["who"]]):
                checked += 1
            else:
                errors.append(f'item {n}, quote {j}: not found word for word in {WHERE[q["who"]]}: "{q["text"]}"')
    return errors, checked, unchecked


def check_note(raw, transcript: Optional[dict]) -> Result:
    """The scrubbed note and everything wrong with it (an empty list: send it)."""
    if not isinstance(raw, dict):
        return Result(note={}, errors=["the note must be a JSON object"])
    counter = [0]
    note = _scrubbed(raw, counter)
    errors = _shape_errors(note)
    if errors:
        return Result(note=note, errors=errors, redactions=counter[0])
    wrong, checked, unchecked = _verify(note, transcript)
    size = len(render(note))
    if size > MAX_CHARS:
        wrong.append(f"the note is too long ({size} characters, at most {MAX_CHARS}): keep fewer, shorter items")
    return Result(note=note, errors=wrong, redactions=counter[0], checked=checked, unchecked=unchecked)


def _stamp(ts: Optional[str]) -> str:
    utc = iso_time(ts)
    return utc[:16].replace("T", " ") if utc else "unknown"


def render(note: dict) -> str:
    """The note as the Engine stores it (the same text as renderNote in the Engine)."""
    head = "\n".join([
        f"# Session note: {note['project']}",
        f"Session {note['session_id']}, {_stamp(note.get('started_at'))} to {_stamp(note.get('ended_at'))} UTC.",
        "Written by the owner's own Claude at the end of a working session and sent by the owner. "
        "Each item is labelled decided, fact, status, how-to or idea; an idea was only floated. "
        "Quotes are exact words from the session.",
    ])
    blocks = [head]
    for n, it in enumerate(note["items"], 1):
        lines = [f"## {n}. [{it['label']}] {it['text'].strip()}", "Evidence (exact words from the session):"]
        lines += [f'> {WHO[q["who"]]}: "{q["text"].strip()}"' for q in it["quotes"]]
        if it.get("pages"):
            lines += ["Pages to consider:"] + [f"- {p['key'].strip()} ({p['title'].strip()}): {p['whats_new'].strip()}" for p in it["pages"]]
        if it.get("new_pages"):
            lines += ["New page suggested:"] + [
                f"- {p['drawer']}: {p['title'].strip()}{' (key ' + p['key'].strip() + ')' if p.get('key') else ''}: {p['why'].strip()}"
                for p in it["new_pages"]
            ]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + "\n"
