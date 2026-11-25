"""Open and close a source's issue in `workspace.issues` after a run.

Kept out of runner.py so the runner's own logic stays untouched (the same
split as run_events.py). Two rules:

  * A failed run opens an issue keyed `run-<source>`, or bumps the open one.
    A SHORT OUTAGE (HTTP 502/503/504, a timeout) is retried by the next run
    and opens nothing the first time; only a second failure in a row does.
    The count is `connector_state.consecutive_failures`, which the runner
    already keeps -- no extra state.
  * A clean run closes that issue with proof.

Neither function ever raises: the issue log must not hide the error that
ended a run, and must not fail a run that was clean.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from typing import Callable

from knowledge import cursors, issues

# A short outage opens an issue once this many runs in a row have failed.
REPEATED_FAILURES = 2


def _warn(name: str, action: str, error: BaseException) -> None:
    print(
        f"[runner:{name}] WARNING could not {action} the issue: {type(error).__name__}",
        file=sys.stderr,
    )


def _failures_in_a_row(name: str, sb, read: Callable[..., int]) -> int:
    """The failure count, or "repeated" when it cannot be read (fail loud)."""
    try:
        return read(name, sb=sb)
    except Exception:  # noqa: BLE001 -- unknown history must not hide a failure
        return REPEATED_FAILURES


def report_failure(
    name: str,
    error: BaseException,
    *,
    sb,
    failure_count: Callable[..., int] = cursors.consecutive_failures,
) -> bool:
    """Log a failed run. Returns True when an issue was opened or bumped."""
    try:
        if (
            issues.is_short_outage(error)
            and _failures_in_a_row(name, sb, failure_count) < REPEATED_FAILURES
        ):
            print(f"[runner:{name}] short outage -- retried next run, no issue opened")
            return False
        issues.upsert(sb, issues.from_exception(name, error))
        return True
    except Exception as issue_error:  # noqa: BLE001 -- never mask the run's own error
        _warn(name, "log", issue_error)
        return False


def report_clean(name: str, hook: dict | None = None, *, sb) -> bool:
    """Close the source's open issue after a clean run. Returns True if asked.

    A run whose wiki write-back failed is recorded as failed elsewhere
    (run_events.py), so it is not proof that the source works again.
    """
    if (hook or {}).get("wiki_error"):
        return False
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        issues.close(sb, issues.run_key(name), f"clean run at {stamp}")
        return True
    except Exception as issue_error:  # noqa: BLE001 -- never fail a clean run
        _warn(name, "close", issue_error)
        return False
