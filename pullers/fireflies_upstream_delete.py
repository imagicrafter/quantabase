"""Delete bronze-captured Fireflies transcripts upstream once past retention.

Safety rules (each is tested in fireflies_upstream_delete_test.py):

* DRY-RUN by default. Real deletes need `execute=True`, which the env wiring
  only grants when FIREFLIES_UPSTREAM_DELETE_EXECUTE=true.
* A transcript is deleted only when `is_captured(id)` confirms it is in
  bronze AND it is older than the retention window (missing date => keep).
* Every transcript considered is logged with its decision.
* HTTP 429 -> back off and retry the same id; after `max_backoffs` the whole
  run halts (nothing further is attempted).

`fireflies_retention.run()` holds the fuller per-row gates (wiki page, notes,
live re-read); this module is the small, client-agnostic delete core plus the
429 backoff, which `fireflies_retention._delete_live` reuses.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Protocol

DEFAULT_RETENTION_DAYS = 90
RATE_LIMIT_BACKOFF_SECONDS = 70  # Fireflies throttle window is ~1 minute
MAX_BACKOFFS = 10
EXECUTE_ENV = "FIREFLIES_UPSTREAM_DELETE_EXECUTE"


class RateLimited(Exception):
    """Fireflies answered HTTP 429."""


class FirefliesClient(Protocol):
    def delete_transcript(self, transcript_id: str) -> None:
        """Delete upstream. Raise RateLimited on 429."""


@dataclass
class SweepReceipt:
    execute: bool = False
    eligible: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)
    halted: bool = False


def execute_enabled(env: dict[str, str | None]) -> bool:
    return (env.get(EXECUTE_ENV) or "").strip().lower() in {"1", "true", "yes"}


def delete_with_backoff(delete: Callable[[str], None], transcript_id: str, *,
                        sleep: Callable[[float], None] = time.sleep,
                        max_backoffs: int = MAX_BACKOFFS,
                        backoff_seconds: float = RATE_LIMIT_BACKOFF_SECONDS) -> None:
    """Call delete(id); on RateLimited wait and retry. Re-raises once
    `max_backoffs` retries are spent."""
    attempts = 0
    while True:
        try:
            delete(transcript_id)
            return
        except RateLimited:
            attempts += 1
            if attempts > max_backoffs:
                raise
            sleep(backoff_seconds)


def _meeting_time(date) -> datetime | None:
    if not isinstance(date, (int, float)) or isinstance(date, bool):
        return None
    return datetime.fromtimestamp(date / 1000, tz=timezone.utc)


def sweep(client: FirefliesClient, transcripts: list[dict],
          is_captured: Callable[[str], bool], *,
          retention_days: int = DEFAULT_RETENTION_DAYS,
          now: datetime | None = None, execute: bool = False,
          log: Callable[[str], None] = print,
          sleep: Callable[[float], None] = time.sleep,
          max_backoffs: int = MAX_BACKOFFS) -> SweepReceipt:
    """`transcripts`: dicts with `id` and `date` (epoch ms)."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=retention_days)
    receipt = SweepReceipt(execute=execute)

    for t in transcripts:
        tid = str(t.get("id"))
        when = _meeting_time(t.get("date"))
        if when is None:
            reason = "no date"
        elif not is_captured(tid):
            reason = "not captured"
        elif when >= cutoff:
            reason = "within retention"
        else:
            reason = None
        if reason:
            receipt.skipped.append((tid, reason))
            log(f"[fireflies-upstream] KEEP {tid}: {reason}")
            continue
        receipt.eligible.append(tid)
        if not execute:
            log(f"[fireflies-upstream] DRY-RUN would delete {tid} ({when:%Y-%m-%d})")
            continue
        log(f"[fireflies-upstream] DELETE {tid} ({when:%Y-%m-%d})")
        try:
            delete_with_backoff(client.delete_transcript, tid, sleep=sleep, max_backoffs=max_backoffs)
        except RateLimited:
            receipt.errors.append((tid, "rate limited; run halted"))
            receipt.halted = True
            log(f"[fireflies-upstream] HALT: still rate limited after {max_backoffs} backoffs")
            break
        except Exception as error:  # noqa: BLE001 -- one failure must not stop the sweep
            receipt.errors.append((tid, f"{type(error).__name__}: {error}"))
            log(f"[fireflies-upstream] FAILED {tid}: {error}")
            continue
        receipt.deleted.append(tid)
    return receipt


def delete_live_with_backoff(mutation: str, transcript_id: str) -> None:
    """Live delete via the puller's GraphQL helper, retrying HTTP 429."""
    import requests

    from pullers.fireflies import _gql

    def _once(tid: str) -> None:
        try:
            _gql(mutation, {"id": tid})
        except requests.HTTPError as error:
            if error.response is not None and error.response.status_code == 429:
                raise RateLimited() from error
            raise

    delete_with_backoff(_once, transcript_id)
