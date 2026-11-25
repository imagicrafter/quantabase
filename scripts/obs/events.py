"""One append-only event log for kb-engine and its agent host (`workspace.events`).

    from obs import events
    with events.run("kb-engine", "puller-fireflies") as r:
        ...
        r.attrs = {"fetched": 3}          # lands on run.finished
        r.fail("wiki push failed")        # run.finished status=failed, no raise needed

    events.emit("agents", "kb-health", "health.fixed", attrs={"rule": "meeting-links"})

Rules (see supabase/migrations/0026_events.sql):
  - event names are fixed `noun.verb` strings -- dashboards key on them.
  - only service / component / event / status are metric labels later; ids and
    titles go in `attrs`.
  - emit() NEVER raises: a bad event or a down database prints a JSON line to
    stdout and returns. Logging must not break the job it observes.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator, Protocol

LEVELS = ("debug", "info", "warn", "error")
STATUSES = ("ok", "failed", "skipped")
_EVENT_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
_SECRET_RE = re.compile(r"token|secret|password|passwd|api_?key|authorization|credential|jwt", re.I)


class EventError(ValueError):
    """The event is malformed (bad name, level or status)."""


class Sink(Protocol):
    def write(self, row: dict) -> None: ...


def scrub(value: Any) -> Any:
    """A copy of `value` with secret-looking keys redacted, recursively."""
    if isinstance(value, dict):
        return {
            k: "[redacted]" if _SECRET_RE.search(str(k)) else scrub(v)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [scrub(v) for v in value]
    return value


def current_commit() -> str | None:
    """Best-effort code version.

    `OBS_COMMIT` in the job's .env wins (set it in the deploy spec so the row
    names what DigitalOcean actually runs); else the local git HEAD.
    """
    try:
        from knowledge.supabase_client import _read_env

        pinned = (_read_env().get("OBS_COMMIT") or "").strip()
        if pinned:
            return pinned[:40]
    except Exception:  # noqa: BLE001 -- no .env is fine, fall through to git
        pass
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=3, check=False,
        )
        return out.stdout.strip()[:40] or None
    except (OSError, subprocess.SubprocessError):
        return None


def build(
    service: str,
    component: str,
    event: str,
    *,
    level: str = "info",
    status: str | None = None,
    run_id: str | None = None,
    duration_ms: int | None = None,
    commit: str | None = None,
    attrs: dict | None = None,
) -> dict:
    if not _EVENT_RE.match(event):
        raise EventError(f"event {event!r} must be lowercase noun.verb, e.g. 'run.finished'")
    if level not in LEVELS:
        raise EventError(f"level {level!r} not in {LEVELS}")
    if status is not None and status not in STATUSES:
        raise EventError(f"status {status!r} not in {STATUSES}")
    if not service or not component:
        raise EventError("service and component are required")
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "service": service,
        "component": component,
        "event": event,
        "level": level,
        "status": status,
        "run_id": run_id,
        "commit_sha": commit,
        "duration_ms": duration_ms,
        "attrs": scrub(attrs or {}),
    }


def _default_sink() -> Sink:
    from obs.sink import SupabaseSink

    return SupabaseSink()


def emit(service: str, component: str, event: str, *, sink: Sink | None = None, **fields: Any) -> None:
    """Build, print as a JSON line, and write to the sink. Never raises."""
    try:
        row = build(service, component, event, **fields)
    except Exception as error:  # noqa: BLE001 -- logging must not break the job
        print(json.dumps({"event": "obs.invalid_event", "level": "warn", "attrs": {"error": str(error)}}))
        return
    print(json.dumps(row, default=str))
    try:
        (sink or _default_sink()).write(row)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"event": "obs.sink_failed", "level": "warn", "attrs": {"error": str(error)[:300]}}))


class Run:
    """Handle yielded by `run()`: attach attrs, or mark failed without raising."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.attrs: dict = {}
        self.error: str | None = None
        self.skipped = False

    def fail(self, message: str) -> None:
        self.error = message

    def skip(self) -> None:
        self.skipped = True


@contextmanager
def run(service: str, component: str, *, sink: Sink | None = None, attrs: dict | None = None) -> Iterator[Run]:
    """run.started on entry; run.finished (ok/failed + duration) on exit.

    A start with no finish in the table means the process died -- the case that
    used to be silent. Exceptions are recorded then re-raised.
    """
    handle = Run(uuid.uuid4().hex[:12])
    common = {"run_id": handle.run_id, "commit": current_commit(), "sink": sink}
    started = time.monotonic()
    emit(service, component, "run.started", attrs=attrs, **common)
    try:
        yield handle
    except BaseException as error:  # noqa: BLE001 -- recorded, then re-raised
        emit(
            service, component, "run.finished", level="error", status="failed",
            duration_ms=int((time.monotonic() - started) * 1000),
            attrs={**handle.attrs, "error": f"{type(error).__name__}: {error}"}, **common,
        )
        raise
    failed = handle.error is not None
    emit(
        service, component, "run.finished",
        level="error" if failed else "info",
        status="failed" if failed else ("skipped" if handle.skipped else "ok"),
        duration_ms=int((time.monotonic() - started) * 1000),
        attrs={**handle.attrs, **({"error": handle.error} if failed else {})}, **common,
    )
