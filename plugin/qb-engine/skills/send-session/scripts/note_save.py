"""Save the approved session note to a local folder (send-session).

Optional. The folder is a pattern from --save-dir, else from `save_dir` in
the settings file: ~/.claude/qb-engine/send-session.json, or the older
~/.claude/kb-send-session/config.json when only that one exists; with
neither, nothing is saved. The
pattern may hold {week}: the Monday of the current week, yyyy-mm-dd. The file
is <date>-<slug of the note's title>.md with a small frontmatter. A file is
replaced only when its frontmatter names the same session; otherwise the
name gets -2, -3 and so on. Stdlib only.
"""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from note_check import iso_time, render

# The settings file, newest name first. The old one keeps working.
CONFIG_PATHS = (
    Path.home() / ".claude" / "qb-engine" / "send-session.json",
    Path.home() / ".claude" / "kb-send-session" / "config.json",
)
SLUG_WORDS, SLUG_CHARS = 6, 60
MAX_COPIES = 99


class SaveError(Exception):
    """A problem with the save setting; shown as one plain line."""


def monday_of(day: date) -> str:
    return (day - timedelta(days=day.weekday())).isoformat()


def expand(pattern: str, today: date) -> Path:
    """The folder a pattern names today: ~ and {week} filled in, nothing else allowed."""
    if not isinstance(pattern, str) or not pattern.strip():
        raise SaveError("save_dir is empty")
    filled = pattern.strip().replace("{week}", monday_of(today))
    if "{" in filled or "}" in filled:
        raise SaveError("save_dir may hold only {week} (the Monday of this week)")
    folder = Path(filled).expanduser()
    if not folder.is_absolute():
        raise SaveError("save_dir must be a full path (it may start with ~)")
    return folder


def config_file(paths: Optional[tuple] = None) -> Optional[Path]:
    """The first settings file that exists, or None."""
    for path in CONFIG_PATHS if paths is None else paths:
        if path.is_file():
            return path
    return None


def save_dir(flag: Optional[str], config: Optional[Path], today: date) -> Optional[Path]:
    """The folder to save in: the flag, else the config's save_dir, else None."""
    if flag:
        return expand(flag, today)
    if config is None or not config.is_file():
        return None
    try:
        value = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SaveError(f"Could not read the config file {config} ({type(error).__name__})") from error
    pattern = value.get("save_dir") if isinstance(value, dict) else None
    if pattern is None:
        return None
    if not isinstance(pattern, str):
        raise SaveError(f"save_dir in {config} must be a folder path")
    return expand(pattern, today)


def slug(title: str) -> str:
    plain = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    words = re.findall(r"[a-z0-9]+", plain)[:SLUG_WORDS]
    return "-".join(words)[:SLUG_CHARS].strip("-")


def _day(note: dict) -> str:
    stamp = iso_time(note.get("ended_at")) or iso_time(note.get("started_at"))
    return stamp[:10] if stamp else date.today().isoformat()


def file_name(note: dict) -> str:
    name = slug(str(note.get("title") or "")) or slug(str(note.get("project") or "")) or "session-note"
    return f"{_day(note)}-{name}.md"


def markdown(note: dict) -> str:
    title = str(note.get("title") or f"Session note: {note['project']}")
    front = [
        "---",
        f"title: {json.dumps(title, ensure_ascii=False)}",
        f"session_id: {note['session_id']}",
        f"project: {json.dumps(note['project'], ensure_ascii=False) if ':' in note['project'] else note['project']}",
        f"date: {_day(note)}",
        "source: claude-code",
        "---",
    ]
    return "\n".join(front) + "\n\n" + render(note)


def _session_of(path: Path) -> Optional[str]:
    """The session id in a saved note's frontmatter, or None (not ours)."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    head = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    found = re.search(r"^session_id: (\S+)$", head.group(1), re.MULTILINE) if head else None
    return found.group(1) if found else None


def save_note(note: dict, folder: Path) -> Path:
    """Write the note; the path written."""
    folder.mkdir(parents=True, exist_ok=True)
    base = file_name(note)[: -len(".md")]
    for n in range(1, MAX_COPIES + 1):
        target = folder / (f"{base}.md" if n == 1 else f"{base}-{n}.md")
        if not target.exists() or _session_of(target) == note["session_id"]:
            target.write_text(markdown(note), encoding="utf-8")
            return target
    raise SaveError(f"{MAX_COPIES} notes with this name already in {folder}")
