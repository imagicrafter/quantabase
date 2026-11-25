"""Synthetic Claude Code transcripts for the send-session tests.

Every record here is made up. Secret-looking strings are built from pieces at
run time, so no scanner ever sees a whole one in this file.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "plugin" / "qb-engine" / "skills" / "send-session" / "scripts"
SESSION = "0b5c6c1e-1111-4222-8333-944455556666"
CWD = "/home/someone/code/demo-project"


def load(name: str):
    """Import one of the skill's bundled scripts by module name."""
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    return importlib.import_module(name)


def user(text, ts="2026-11-24T10:00:00.000Z", **extra):
    return {"type": "user", "sessionId": SESSION, "cwd": CWD, "timestamp": ts,
            "message": {"role": "user", "content": text}, **extra}


def assistant(blocks, ts="2026-11-24T10:00:05.000Z", **extra):
    content = [{"type": "text", "text": blocks}] if isinstance(blocks, str) else blocks
    return {"type": "assistant", "sessionId": SESSION, "cwd": CWD, "timestamp": ts,
            "message": {"role": "assistant", "content": content}, **extra}


def tool_result(ts="2026-11-24T10:00:03.000Z"):
    return user([{"type": "tool_result", "tool_use_id": "t1", "content": "TOOL OUTPUT SHOULD NOT APPEAR"}],
                ts=ts, toolUseResult={"stdout": "TOOL OUTPUT SHOULD NOT APPEAR"})


def write_jsonl(path: Path, records, raw_lines=()) -> Path:
    lines = [json.dumps(r, ensure_ascii=False) for r in records] + list(raw_lines)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def fake(prefix: str, body: str) -> str:
    """A secret-shaped string made from two pieces."""
    return prefix + body
