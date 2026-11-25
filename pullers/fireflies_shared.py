"""Meetings recorded by someone else's Fireflies and shared with the owner.

The Fireflies `transcripts` listing returns only meetings the owner's own
Fireflies recorded. A meeting someone else's Fireflies recorded never appears
there, even when it is shared with the owner -- but `transcript(id:)` still
opens it. The only place those ids show up is the recap email Fireflies sends
to the owner's mailbox.

This is an add-on, off unless `sources.fireflies.shared_meetings.enabled` is
true in the Engine config. It has two halves and one shared cursor row
(`connector_state.source = 'fireflies-shared'`):

  * a scanner outside this repo, which holds the mailbox token, reads the
    recap emails and records each meeting id in that row;
  * pullers/fireflies.py (holds the Fireflies key) fetches the recorded ids it
    has not handled yet, alongside its own listing.

The puller keeps its own `shared_seen` map in the `fireflies` cursor, so the
scanner's row is written by exactly one writer and read by the other.
Everything here is pure: no network, no database.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

SHARED_SOURCE = "fireflies-shared"
# How far back the scanner looks, and how long either side remembers an id.
KEEP_DAYS = 30
# Two recordings of one call (the owner's bot and another attendee's) can start
# well apart -- measured 2026-09-25: one at 19:00, the other joined at 19:23.
# They are the same call when they overlap for at least this share of the
# shorter recording.
DUPLICATE_OVERLAP = 0.5
# How far before a shared meeting's start to look for the owner's own recording.
LOOKBACK = timedelta(hours=3)
# Used when Fireflies reports no duration.
DEFAULT_DURATION = timedelta(minutes=30)
# Cap per puller run, so a burst of shares cannot stall the daily run.
MAX_SHARED_PER_RUN = 20
# Runs an id may fail before the puller gives up on it, so dead ids cannot
# block newer shares.
MAX_TRIES = 3
# Only meetings organized by a trusted email domain are ingested. A recap email
# proves Fireflies sent it, not that the person who recorded the meeting is
# trusted: anyone can record a call with the owner and share it. The trusted
# domains come from the Engine config -- see `trusted_domains()`.

_ID_RE = re.compile(
    r"https://app\.fireflies\.ai/view/[^\s\"'<>]*?::([A-Za-z0-9]{20,32})(?![A-Za-z0-9])"
)


def extract_ids(text: str | None) -> list[str]:
    """Fireflies meeting ids linked from a recap email, first-seen order, no repeats."""
    if not text:
        return []
    return list(dict.fromkeys(_ID_RE.findall(text)))


def _parse_iso(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _recent(stamp: Any, now: datetime) -> bool:
    parsed = _parse_iso(stamp)
    return parsed is not None and now - parsed <= timedelta(days=KEEP_DAYS)


def merge_ids(cursor: dict, found: dict[str, str], *, now: datetime) -> dict:
    """New scanner cursor: old ids keep their first-seen time, new ids are added,
    ids older than KEEP_DAYS are dropped. The input is not mutated."""
    combined = {**found, **(cursor.get("ids") or {})}
    kept = {mid: seen for mid, seen in combined.items() if _recent(seen, now)}
    return {"ids": dict(sorted(kept.items())), "scanned_at": now.isoformat()}


def prune_seen(seen: dict[str, str], *, now: datetime) -> dict[str, str]:
    """The puller's handled-ids map without entries older than KEEP_DAYS."""
    return {mid: day for mid, day in seen.items() if _recent(day, now)}


def pending(shared_cursor: dict, *, seen: dict[str, str], listed: Iterable[str]) -> list[str]:
    """Shared ids not yet handled and not already in this run's own listing,
    oldest first, capped at MAX_SHARED_PER_RUN."""
    skip = set(seen) | set(listed)
    ids = shared_cursor.get("ids") or {}
    todo = sorted((first_seen, mid) for mid, first_seen in ids.items() if mid not in skip)
    return [mid for _first_seen, mid in todo[:MAX_SHARED_PER_RUN]]


def span(raw: dict) -> tuple[datetime, datetime] | None:
    """(start, end) of a recording; Fireflies `duration` is in minutes."""
    from pullers.fireflies import _parse_meeting_date

    start = _parse_meeting_date(raw.get("date"))
    if start is None:
        return None
    try:
        minutes = float(raw.get("duration") or 0)
    except (TypeError, ValueError):
        minutes = 0
    length = timedelta(minutes=minutes) if minutes > 0 else DEFAULT_DURATION
    return start, start + length


def is_duplicate(raw: dict, own: list[dict]) -> bool:
    """True when the owner's own Fireflies recorded the same call: another
    recording that overlaps this one for at least DUPLICATE_OVERLAP of the
    shorter of the two."""
    mine = span(raw)
    if mine is None:
        return False
    for other in own:
        if other.get("id") == raw.get("id"):
            continue
        theirs = span(other)
        if theirs is None:
            continue
        overlap = min(mine[1], theirs[1]) - max(mine[0], theirs[0])
        shorter = min(mine[1] - mine[0], theirs[1] - theirs[0])
        if overlap > timedelta(0) and overlap >= shorter * DUPLICATE_OVERLAP:
            return True
    return False


def trusted_domains(listed: Iterable[str]) -> frozenset[str]:
    """Email domains whose meetings may be ingested: exactly those listed in
    `sources.fireflies.shared_meetings.trusted_domains`.

    Nothing is trusted by default -- not even the domain of the owner's own
    address, which may be a public mail provider that anyone can sign up to."""
    return frozenset(d.strip().lower() for d in listed if d and d.strip())


def trusted_organizer(raw: dict, trusted: Iterable[str]) -> bool:
    """True when the meeting's organizer is at one of the `trusted` domains.
    The whole domain must match; an empty list trusts nobody."""
    email = str(raw.get("organizer_email") or "").strip().lower()
    local, _, domain = email.rpartition("@")
    return bool(local) and domain in frozenset(trusted)


def shared_suffix(meeting_id: str) -> str:
    """external_id suffix for a shared meeting whose bare name is taken."""
    return f"shared-{str(meeting_id)[:6].lower()}"


def record_failure(meeting_id: str, seen: dict[str, str], tries: dict[str, int], *,
                   now: datetime) -> tuple[dict[str, str], dict[str, int]]:
    """One more failed run for `meeting_id`; after MAX_TRIES it moves to `seen`."""
    count = int(tries.get(meeting_id, 0)) + 1
    if count >= MAX_TRIES:
        return {**seen, meeting_id: now.isoformat()}, {k: v for k, v in tries.items() if k != meeting_id}
    return seen, {**tries, meeting_id: count}


def state(seen: dict[str, str], tries: dict[str, int]) -> dict:
    """The puller-cursor keys this module owns, empty ones left out."""
    return {
        **({"shared_seen": seen} if seen else {}),
        **({"shared_tries": tries} if tries else {}),
    }
