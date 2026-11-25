"""Read a Claude Code transcript (.jsonl) into the conversation only (send-session).

Kept: what the owner typed, and the assistant's text replies. Dropped: tool
calls and their results, thinking, images, system and hook text, attachments,
subagent (sidechain) records, compact summaries, and every record type that
is not a user or assistant message. Big pasted bodies are replaced by a short
note. Every kept text is scrubbed of secret-looking strings.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from session_scrub import scrub

PASTE_KEEP_CHARS = 2000
PROJECT_CHARS = 100
SESSION_CHARS = 100

# Record flags that mark text the owner did not type or the assistant did not say.
_SKIP_FLAGS = ("isMeta", "isSidechain", "isCompactSummary", "isVisibleInTranscriptOnly", "isApiErrorMessage", "toolUseResult")

# Tags Claude Code wraps around injected text, dropped with what they hold.
_DROP_TAGS = (
    "system-reminder", "user-prompt-submit-hook", "local-command-stdout", "local-command-stderr",
    "local-command-caveat", "bash-input", "bash-stdout", "bash-stderr", "task-notification",
    "persisted-output", "teammate-message", "cross-session-message", "command-message",
)
_DROP_RE = re.compile(r"<(" + "|".join(_DROP_TAGS) + r")(?:\s[^>]*)?>[\s\S]*?</\1>")
# An opening tag left with no end: everything after it is dropped too.
_DROP_OPEN_RE = re.compile(r"<(?:" + "|".join(_DROP_TAGS) + r")(?:\s[^>]*)?>[\s\S]*\Z")
_PASTE_RE = re.compile(r"<pasted_content(?:\s[^>]*)?>([\s\S]*?)</pasted_content>")
_CMD_NAME_RE = re.compile(r"<command-name>([\s\S]*?)</command-name>")
_CMD_ARGS_RE = re.compile(r"<command-args>([\s\S]*?)</command-args>")
_INTERRUPTED_RE = re.compile(r"^\[Request interrupted by user[^\]]*\]\s*$", re.MULTILINE)
_BLANKS_RE = re.compile(r"\n{3,}")


@dataclass(frozen=True)
class Turn:
    role: str  # "owner" or "assistant"
    text: str
    ts: str | None


@dataclass(frozen=True)
class Session:
    session_id: str
    project: str
    started_at: str | None
    ended_at: str | None
    turns: tuple[Turn, ...]
    redactions: int
    bad_lines: int


def _paste(m: re.Match[str]) -> str:
    body = m.group(1)
    return body if len(body) <= PASTE_KEEP_CHARS else f"[pasted text left out: {len(body)} characters]"


def clean_prompt(text: str) -> str:
    """The owner's prompt without injected tags; a slash command becomes one line."""
    name = _CMD_NAME_RE.search(text)
    args = _CMD_ARGS_RE.search(text)
    out = _DROP_OPEN_RE.sub("", _DROP_RE.sub("", text))
    out = _CMD_NAME_RE.sub("", _CMD_ARGS_RE.sub("", out))
    out = _PASTE_RE.sub(_paste, out)
    out = _INTERRUPTED_RE.sub("", out)
    if name:
        command = name.group(1).strip()
        command = command if command.startswith("/") else f"/{command}"
        line = f"{command} {args.group(1).strip() if args else ''}".strip()
        out = f"{line}\n{out}"
    return _BLANKS_RE.sub("\n\n", out).strip()


def _texts(content: object) -> list[str]:
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]


def _turn_of(record: dict) -> Turn | None:
    kind = record.get("type")
    if kind not in ("user", "assistant") or any(record.get(f) for f in _SKIP_FLAGS):
        return None
    message = record.get("message")
    parts = _texts(message.get("content") if isinstance(message, dict) else None)
    if kind == "user":
        text = "\n\n".join(p for p in (clean_prompt(t) for t in parts) if p)
    else:
        text = "\n\n".join(t.strip() for t in parts if t.strip())
    ts = record.get("timestamp") if isinstance(record.get("timestamp"), str) else None
    return Turn("owner" if kind == "user" else "assistant", text, ts) if text else None


def _records(path: Path) -> tuple[list[dict], int]:
    records: list[dict] = []
    bad = 0
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            if isinstance(value, dict):
                records.append(value)
            else:
                bad += 1
    return records, bad


def _merged(turns: list[Turn]) -> tuple[Turn, ...]:
    """One assistant turn per reply, even when tool calls split it into records."""
    out: list[Turn] = []
    for turn in turns:
        last = out[-1] if out else None
        if last and last.role == "assistant" and turn.role == "assistant":
            # Keep the first record's time: a reply that grows later must not
            # change the stamp already sent in an earlier part.
            out[-1] = Turn("assistant", f"{last.text}\n\n{turn.text}", last.ts or turn.ts)
        else:
            out.append(turn)
    return tuple(out)


def _first(records: list[dict], key: str) -> str | None:
    for r in records:
        value = r.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def read_session(path: Path) -> Session:
    records, bad = _records(path)
    raw = [t for t in (_turn_of(r) for r in records) if t is not None]
    scrubbed: list[Turn] = []
    redactions = 0
    for turn in raw:
        text, n = scrub(turn.text)
        redactions += n
        scrubbed.append(Turn(turn.role, text, turn.ts))
    turns = _merged(scrubbed)
    stamps = [t.ts for t in scrubbed if t.ts]
    cwd = _first([r for r in records if r.get("type") in ("user", "assistant")], "cwd")
    project = Path(cwd).name if cwd else path.parent.name
    return Session(
        session_id=(_first(records, "sessionId") or path.stem)[:SESSION_CHARS],
        project=(project or path.parent.name)[:PROJECT_CHARS],
        started_at=stamps[0] if stamps else None,
        ended_at=stamps[-1] if stamps else None,
        turns=turns,
        redactions=redactions,
        bad_lines=bad,
    )
