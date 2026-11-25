"""Local setup state: `.kb-engine-local/state.json` (git-ignored).

Records which setup phases are done and the non-secret answers given along
the way (hostnames, repo names, paths), so a session can pick up where the
last one stopped. It never holds a secret: a key or value that looks like one
is refused before anything is written.

Every update returns a new state; nothing is changed in place. The file is
written to a temp file and renamed over the old one, with mode 0600.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .errors import KbeError

VERSION = 1
PHASE_STATUSES = ("pending", "done", "failed")

_SECRET_KEY = re.compile(
    r"(^|[_\-.])(key|token|secret|password|passwd|credential|credentials|code)$"
    r"|password|database_url",
    re.IGNORECASE,
)
_URL_WITH_PASSWORD = re.compile(r"://[^/\s:@]+:[^/\s@]+@")
_JWT = re.compile(r"\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}")


def empty() -> dict[str, Any]:
    return {"version": VERSION, "phases": {}, "answers": {}}


def looks_secret(key: str) -> bool:
    """True for names such as *_KEY, *_TOKEN, *_SECRET, password."""
    return bool(_SECRET_KEY.search(key))


def _value_looks_secret(value: str) -> bool:
    return bool(_URL_WITH_PASSWORD.search(value) or _JWT.search(value))


def _refuse(what: str) -> KbeError:
    return KbeError(
        f"{what} looks like a secret. Secrets are never stored in the local "
        "state file; keep them in your local env file."
    )


def _check(key: str, value: Any) -> None:
    """Raise if `key` or anything under `value` looks like a secret."""
    if looks_secret(key):
        raise _refuse(f'The name "{key}"')
    if isinstance(value, str) and _value_looks_secret(value):
        raise _refuse(f'The value given for "{key}"')
    if isinstance(value, Mapping):
        for child_key, child in value.items():
            _check(str(child_key), child)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _check(key, item)


def with_answer(state: Mapping[str, Any], key: str, value: Any) -> dict[str, Any]:
    """A new state with one non-secret answer set."""
    _check(key, value)
    return {**state, "answers": {**state.get("answers", {}), key: value}}


def with_phase(
    state: Mapping[str, Any], phase: str, status: str, now: str | None = None
) -> dict[str, Any]:
    """A new state with one phase marked `pending`, `done` or `failed`."""
    if status not in PHASE_STATUSES:
        raise KbeError(f'Phase status must be one of {", ".join(PHASE_STATUSES)}.')
    stamp = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry = {"status": status, "at": stamp}
    return {**state, "phases": {**state.get("phases", {}), phase: entry}}


def answer(state: Mapping[str, Any], key: str, default: Any = None) -> Any:
    return state.get("answers", {}).get(key, default)


def phase_done(state: Mapping[str, Any], phase: str) -> bool:
    return state.get("phases", {}).get(phase, {}).get("status") == "done"


def load(path: Path) -> dict[str, Any]:
    """Read the state file. A missing file is an empty state."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return empty()
    except OSError as error:
        raise KbeError(f"Could not read {path}: {error.strerror}.") from error
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise KbeError(
            f"{path} is not valid JSON. Fix it by hand, or move it aside to start over."
        ) from error
    if not isinstance(data, dict) or not isinstance(data.get("answers", {}), dict):
        raise KbeError(f"{path} has an unexpected shape. Move it aside to start over.")
    return {**empty(), **data}


def save(path: Path, state: Mapping[str, Any]) -> None:
    """Write the state file atomically, readable by the owner only."""
    for key, value in state.get("answers", {}).items():
        _check(str(key), value)
    text = json.dumps(state, indent=2, sort_keys=True) + "\n"
    temp_name = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.parent.name.startswith(".kb-engine"):
            os.chmod(path.parent, 0o700)
        # mkstemp creates the file with mode 0600.
        handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=".state-", suffix=".tmp")
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except OSError as error:
        if temp_name is not None and os.path.exists(temp_name):
            os.unlink(temp_name)
        reason = error.strerror or str(error)
        raise KbeError(f"Local state could not be saved to {path}: {reason}.") from error
