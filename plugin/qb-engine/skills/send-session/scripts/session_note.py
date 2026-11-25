"""send-session: check a session note and get it ready to send, locally.

    python3 session_note.py transcript [--session ID | --path FILE] [--max-chars N]
    python3 session_note.py check --note NOTE.json [--session ID | --path FILE | --no-transcript] [--out DIR]
    python3 session_note.py save --out DIR [--save-dir PATTERN]
    python3 session_note.py clean --out DIR

`transcript` prints the conversation only (what the owner typed and Claude's
text replies, secrets cut), for a session Claude does not have in front of
it. `check` fills the note's header from the transcript (session id,
project, dates), validates it, scrubs it, checks every quote word for word
against the session, writes DIR/item.json (the record_source_item fields)
and prints the preview. `save` writes the approved note to the person's own
notes folder, if they set one (note_save.py). `clean` deletes the note and
item files. Stdlib only,
no network.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import note_save
from note_save import SaveError, save_dir, save_note
from note_check import LABELS, check_note, iso_time, render  # noqa: F401  (iso_time re-exported)
from session_turns import Session, read_session

SOURCE = "claude-code"
TAIL_CHARS = 60_000
_SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
DEFAULT_PROJECTS = Path.home() / ".claude" / "projects"
OWN_FILES = ("note.json", "item.json")


class SendError(Exception):
    """A problem the person can fix; shown as one plain line."""


def slug_for(cwd: str) -> str:
    """Claude Code's folder name for a working directory."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def find_transcript(projects_dir: Path, cwd: str, session: Optional[str] = None, path: Optional[str] = None) -> Path:
    if path:
        found = Path(path).expanduser()
        if found.suffix != ".jsonl" or not found.is_file():
            raise SendError(f"{found} is not a .jsonl transcript file")
        return found
    if session is not None and not _SESSION_RE.match(session):
        raise SendError("That is not a session id (letters, digits and dashes only)")
    folder = projects_dir / slug_for(cwd)
    files = sorted(folder.glob("*.jsonl"), key=lambda f: f.stat().st_mtime) if folder.is_dir() else []
    if not files:
        raise SendError(f"No Claude Code transcripts for {cwd} (looked in {folder})")
    if session is None:
        return files[-1]
    chosen = folder / f"{session}.jsonl"
    if not chosen.is_file():
        raise SendError(f"No transcript for session {session} in {folder}")
    return chosen


def _session(args: argparse.Namespace) -> Session:
    return read_session(find_transcript(args.projects_dir, args.cwd, args.session, args.path))


def _transcript(args: argparse.Namespace) -> int:
    session = _session(args)
    who = {"owner": "Owner", "assistant": "Assistant"}
    text = "\n\n".join(f"[{(t.ts or '')[:16].replace('T', ' ')}] {who[t.role]}: {t.text}" for t in session.turns)
    print(text[-args.max_chars:])
    return 0


def _load_note(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise SendError(f"Could not read the note ({type(error).__name__})") from error
    except ValueError as error:
        raise SendError(f"The note is not valid JSON ({error})") from error


def _with_header(raw: object, session: Session) -> object:
    if not isinstance(raw, dict):
        return raw
    header = {"session_id": session.session_id, "project": session.project,
              "started_at": iso_time(session.started_at), "ended_at": iso_time(session.ended_at)}
    return {**raw, **{k: v for k, v in header.items() if v is not None}}


def _item(note: dict) -> dict:
    when = iso_time(note.get("ended_at")) or iso_time(note.get("started_at")) \
        or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"source": SOURCE, "source_id": note["session_id"], "source_created_at": when, "cursor": when,
            "tags": [{"kind": "project", "id": note["project"], "name": note["project"]}], "note": note}


def _preview(note: dict, result, has_transcript: bool, item_path: Path) -> str:
    labels = Counter(it["label"] for it in note["items"])
    quotes = result.checked + result.unchecked
    why = "" if has_transcript and not result.unchecked else (" (no transcript)" if not has_transcript else " (tool output is not checked)")
    body = render(note)
    return "\n".join([
        body,
        f"Items: {len(note['items'])} ({', '.join(f'{k} {labels[k]}' for k in LABELS if labels[k])})",
        f"Quotes checked against the session: {result.checked} of {quotes}{why}",
        f"Secrets redacted: {result.redactions}",
        f"Size: {len(body)} characters",
        f"Item file: {item_path}",
        "Send to Quantabase? (yes / no, or say what to change)",
    ])


def _check(args: argparse.Namespace) -> int:
    raw = _load_note(args.note)
    transcript = None
    if not args.no_transcript:
        session = _session(args)
        raw = _with_header(raw, session)
        transcript = {r: [t.text for t in session.turns if t.role == r] for r in ("owner", "assistant")}
    result = check_note(raw, transcript)
    if result.errors:
        for error in result.errors:
            print(f"send-session: {error}", file=sys.stderr)
        return 1
    out = args.out or Path(tempfile.mkdtemp(prefix="send-session-"))
    out.mkdir(parents=True, exist_ok=True)
    item_path = out / "item.json"
    item_path.write_text(json.dumps(_item(result.note), indent=1, ensure_ascii=False), encoding="utf-8")
    print(_preview(result.note, result, transcript is not None, item_path))
    return 0


def _save(args: argparse.Namespace) -> int:
    try:
        note = json.loads((args.out / "item.json").read_text(encoding="utf-8"))["note"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SendError(f"Could not read item.json in {args.out} ({type(error).__name__})") from error
    try:
        config = args.config if args.config is not None else note_save.config_file()
        folder = save_dir(args.save_dir, config, date.today())
        if folder is None:
            print("not saved (no save folder set)")
            return 0
        print(f"saved {save_note(note, folder)}")
    except SaveError as error:
        raise SendError(str(error)) from error
    return 0


def _clean(args: argparse.Namespace) -> int:
    for name in OWN_FILES:
        target = args.out / name
        if target.is_file():
            target.unlink()
    if args.out.is_dir() and not any(args.out.iterdir()):
        args.out.rmdir()
    print("Removed the note files from this computer.")
    return 0


def _bounded(low: int, high: int):
    def parse(value: str) -> int:
        if not value.isdigit() or not low <= int(value) <= high:
            raise argparse.ArgumentTypeError(f"must be a whole number from {low} to {high}")
        return int(value)
    return parse


def _where(p: argparse.ArgumentParser) -> None:
    p.add_argument("--session", help="the session id (default: the newest for this folder)")
    p.add_argument("--path", help="a transcript .jsonl file (overrides --session)")
    p.add_argument("--cwd", default=os.getcwd(), help="the project folder (default: here)")
    p.add_argument("--projects-dir", type=Path, default=DEFAULT_PROJECTS)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="send-session", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    tr = sub.add_parser("transcript", help="print the conversation only")
    _where(tr)
    tr.add_argument("--max-chars", type=_bounded(1_000, 400_000), default=TAIL_CHARS)
    ck = sub.add_parser("check", help="check the note, write item.json, print the preview")
    _where(ck)
    ck.add_argument("--note", type=Path, required=True)
    ck.add_argument("--no-transcript", action="store_true", help="no transcript: quotes are not checked")
    ck.add_argument("--out", type=Path, help="where to write item.json (default: a new temp folder)")
    sv = sub.add_parser("save", help="save the approved note to your notes folder, if one is set")
    sv.add_argument("--out", type=Path, required=True)
    sv.add_argument("--save-dir", help="folder pattern, may hold {week}; overrides the config")
    sv.add_argument("--config", type=Path, default=None, help="settings file (default: the first of note_save.CONFIG_PATHS that exists)")
    cl = sub.add_parser("clean", help="delete note.json and item.json")
    cl.add_argument("--out", type=Path, required=True)
    return parser


def main(argv: Optional[list] = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as stop:
        return int(stop.code or 0)
    try:
        return {"transcript": _transcript, "check": _check, "save": _save, "clean": _clean}[args.command](args)
    except SendError as error:
        print(f"send-session: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"send-session: could not read or write a file ({type(error).__name__}: {error.filename})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
