"""Per-source ingest cursors and the cron lock.

Wraps `workspace.connector_state` and `workspace.acquire_connector_lock()` /
`workspace.release_connector_lock()` (supabase/migrations/0010_connector_state.sql).

`with_lock` must never raise when the lock is held -- a cron run that cannot get
the lock stands down quietly rather than failing the workflow. Parallel
workflow runs corrupt the runner's shared database; this is the
guard against that for source-level ingest work.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from .supabase_client import get_supabase
from .kb_schema import db

DEFAULT_LOCK_TTL_SECONDS = 3600


class CursorError(RuntimeError):
    """A cursor or lock operation could not complete."""


def get_cursor(source: str, *, sb=None) -> dict:
    """The stored cursor for a source, or {} if the source has never run.

    `sb`: an existing Supabase client, or None to build the service-role one.
    The default exists only for pre-cutover callers on a long-lived host; it should be
    deleted once the knowledge-capture/-review workflows retire (plan Step 7).
    `pullers/runner.py` always passes its `kb_ingest`-scoped client.
    """
    sb = sb or get_supabase()
    try:
        resp = (
            db(sb)
            .table("connector_state")
            .select("cursor")
            .eq("source", source)
            .limit(1)
            .execute()
        )
    except Exception as error:
        raise CursorError(f"Could not read cursor for {source!r}: {error}") from error

    rows = resp.data or []
    return rows[0]["cursor"] if rows else {}


def set_cursor(source: str, cursor: dict, *, sb=None) -> None:
    """Persist a source's cursor. Creates the row if this source has never run.

    `sb`: see `get_cursor`.
    """
    sb = sb or get_supabase()
    try:
        (
            db(sb)
            .table("connector_state")
            .upsert({"source": source, "cursor": cursor}, on_conflict="source")
            .execute()
        )
    except Exception as error:
        raise CursorError(f"Could not write cursor for {source!r}: {error}") from error


def record_run(
    source: str, *, success: bool, error: str | None = None, sb=None
) -> None:
    """Record the outcome of a connector run.

    `last_run_at` is always set. On success, `last_success_at` is stamped and
    `consecutive_failures` resets to 0. On failure, `consecutive_failures`
    increments and `last_error` is stored.

    `sb`: see `get_cursor`.
    """
    sb = sb or get_supabase()
    stamp = datetime.now(timezone.utc).isoformat()

    if success:
        payload = {
            "source": source,
            "last_run_at": stamp,
            "last_success_at": stamp,
            "consecutive_failures": 0,
            # A successful run may still carry a warning (e.g. Fireflies wiki
            # write-back failed but the ingest landed); None clears it.
            "last_error": error,
        }
        try:
            (
                db(sb)
                .table("connector_state")
                .upsert(payload, on_conflict="source")
                .execute()
            )
        except Exception as exc:
            raise CursorError(f"Could not record success for {source!r}: {exc}") from exc
        return

    try:
        resp = (
            db(sb)
            .table("connector_state")
            .select("consecutive_failures")
            .eq("source", source)
            .limit(1)
            .execute()
        )
        prior_failures = (resp.data or [{}])[0].get("consecutive_failures", 0)
    except Exception as exc:
        raise CursorError(f"Could not read prior failure count for {source!r}: {exc}") from exc

    payload = {
        "source": source,
        "last_run_at": stamp,
        "consecutive_failures": (prior_failures or 0) + 1,
        "last_error": error,
    }
    try:
        (
            db(sb)
            .table("connector_state")
            .upsert(payload, on_conflict="source")
            .execute()
        )
    except Exception as exc:
        raise CursorError(f"Could not record failure for {source!r}: {exc}") from exc


def consecutive_failures(source: str, *, sb=None) -> int:
    """How many runs in a row have failed for a source (0 if it never ran).

    `record_run` keeps this count; the issue log reads it to tell a first short
    outage from a repeated one (pullers/run_issues.py).

    `sb`: see `get_cursor`.
    """
    sb = sb or get_supabase()
    try:
        resp = (
            db(sb)
            .table("connector_state")
            .select("consecutive_failures")
            .eq("source", source)
            .limit(1)
            .execute()
        )
    except Exception as error:
        raise CursorError(f"Could not read failure count for {source!r}: {error}") from error

    rows = resp.data or []
    return int((rows[0].get("consecutive_failures") if rows else 0) or 0)


@contextmanager
def with_lock(
    source: str, owner: str, ttl_seconds: int = DEFAULT_LOCK_TTL_SECONDS, *, sb=None
) -> Iterator[bool]:
    """Acquire the connector lock for the duration of the block.

    Yields True if the lock was acquired, False if another owner holds it --
    never raises for a held lock, so a cron run can stand down quietly. Always
    releases in a finally block when it was the one to acquire it.

    `sb`: see `get_cursor`.
    """
    sb = sb or get_supabase()
    acquired = False
    try:
        try:
            resp = (
                db(sb)
                .rpc(
                    "acquire_connector_lock",
                    {"p_source": source, "p_owner": owner, "p_ttl_seconds": ttl_seconds},
                )
                .execute()
            )
            acquired = bool(resp.data)
        except Exception as error:
            raise CursorError(f"Could not attempt lock acquisition for {source!r}: {error}") from error

        yield acquired
    finally:
        if acquired:
            try:
                db(sb).rpc(
                    "release_connector_lock", {"p_source": source}
                ).execute()
            except Exception:
                # Releasing on a best-effort basis: a stale lock still expires
                # via locked_until, so a failed release here is not fatal.
                pass
