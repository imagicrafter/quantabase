"""Fireflies puller -- meeting transcripts via the Fireflies GraphQL API.

Replaces `knowledge.connectors.transcripts`, which reads
`memory/transcripts/*.md` off local disk -- files a host-only maintenance
script (`scripts/maintenance/fireflies_ingest.py`) wrote earlier. That disk
step does not exist in a job container, so this puller calls the Fireflies API
directly, the way `fireflies_ingest.py` already does for its own ingest path.

**`external_id` MUST match the existing convention exactly:**
`f"{date_str}-{slugify(title)}.md"` -- the same scheme
`connectors/transcripts.py` and `fireflies_ingest.py` both use. The 133 rows
already in `workspace.documents` under `source='fireflies'` were written with
that external_id. Using the Fireflies transcript id instead would not match
any existing row and would duplicate the entire corpus under `full_sync=False`
rather than update it. `source='fireflies'` is retained too, not the puller's
module name -- `workspace.raw_captures` has a CHECK constraint on
gmail/fireflies/drive (see `knowledge.bronze.VALID_SOURCES`).

**Retention risk, confirmed real (not hypothetical):**
`fireflies_ingest.py::phase_cleanup` deletes a transcript from Fireflies once
it is wiki-ingested and older than `--retention` (default 90 days). A meeting
whose transcript was already deleted upstream cannot be re-fetched by this
puller. The cursor below is a forward-only high-water mark for exactly that
reason -- this puller only ever asks for meetings *since* its last run, and
never attempts to backfill history the API may no longer hold. The existing
133 rows are the floor, not something this puller re-derives.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Iterable

from knowledge.env_file import read as read_env_file

from knowledge.config import SOURCE_FIREFLIES, TIER_DISTILLED, WORKSPACE_ROOT
from knowledge.contract import Document
from knowledge.engine_config import get_config
from pullers import fireflies_shared, fireflies_tags
from pullers.base import SkipPayload
from knowledge.kb_schema import db

SOURCE = "fireflies"
BRONZE = True
FULL_SYNC = False

FIREFLIES_API_URL = "https://api.fireflies.ai/graphql"
API_DELAY_SECONDS = 1
# Guard against a runaway first run / cursor corruption, mirroring the Gmail
# connector's GMAIL_MAX_THREADS_PER_RUN guard.
MAX_TRANSCRIPTS_PER_RUN = 200
# Fireflies rejects `limit` above 50 outright (400 invalid_arguments,
# "limit must not be greater than 50"), measured against the live API
# 2026-08-25. MAX_TRANSCRIPTS_PER_RUN is therefore a paging BUDGET, not a
# page size -- `_list_stubs()` walks pages of this size until the budget is
# spent or a short page proves the listing is exhausted.
API_PAGE_LIMIT = 50
RELIST_DAYS = 2
# No cursor yet: bounded first-run lookback, not unbounded history.
BOOTSTRAP_LOOKBACK_DAYS = 90

ENV_PATH = WORKSPACE_ROOT / ".env"

_LIST_QUERY = """
query ListTranscripts($fromDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) {
    id
    title
    date
  }
}
"""

# The owner's own meetings around one start time -- used to spot a shared
# meeting that the owner's own Fireflies also recorded.
_WINDOW_QUERY = """
query WindowTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit) {
    id
    date
    duration
  }
}
"""

_TRANSCRIPT_QUERY_TEMPLATE = """
query GetTranscript($id: String!) {
  transcript(id: $id) {
    id
    title
    date
    duration
    organizer_email
    participants
    %s
    speakers { id, name }
    sentences {
      index
      speaker_name
      text
      start_time
      end_time
    }
    summary {
      overview
      notes
      shorthand_bullet
      short_summary
      gist
      action_items
      keywords
    }
    meeting_attendees { displayName, email }
  }
}
"""

# The channel is how a meeting is tagged at the source (see docs/tagging.md).
_TRANSCRIPT_QUERY = _TRANSCRIPT_QUERY_TEMPLATE % "channels { id, title }"
_TRANSCRIPT_QUERY_NO_CHANNELS = _TRANSCRIPT_QUERY_TEMPLATE % ""
# Turned off for the rest of the process if the API refuses the field.
_channels_field_ok = True


class FirefliesConnectorError(RuntimeError):
    """Fireflies could not be reached or returned an unusable response."""


def _api_key() -> str:
    key = (read_env_file(ENV_PATH).get("FIREFLIES_API_KEY") or "").strip()
    if not key:
        raise FirefliesConnectorError(f"FIREFLIES_API_KEY not set in {ENV_PATH}")
    return key


def _gql(query: str, variables: dict | None = None) -> dict:
    import requests

    resp = requests.post(
        FIREFLIES_API_URL,
        json={"query": query, "variables": variables or {}},
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Content-Type": "application/json",
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if "errors" in data:
        raise FirefliesConnectorError(f"Fireflies API error: {data['errors']}")
    return data.get("data", {})


def _fetch_transcript(transcript_id: str) -> dict | None:
    """One transcript in full, with its channels when the API offers them.

    An API that does not know the `channels` field is asked again without it:
    the meeting is then simply untagged by channel, never dropped.
    """
    global _channels_field_ok
    if _channels_field_ok:
        try:
            return _gql(_TRANSCRIPT_QUERY, {"id": transcript_id}).get("transcript")
        except FirefliesConnectorError as error:
            if "channels" not in str(error).lower():
                raise
            _channels_field_ok = False
            print("[fireflies] the API refused the `channels` field; channel tags are off")
    return _gql(_TRANSCRIPT_QUERY_NO_CHANNELS, {"id": transcript_id}).get("transcript")


def _page_root():
    """The knowledge checkout to read meeting-page tags from, or None when no
    knowledge repo is configured. Raises if the checkout cannot be prepared."""
    if not get_config().sources.wiki.repo:
        return None
    from pullers import knowledge_repo

    return knowledge_repo.resolve_root()


def _with_page_tags(raws: list[dict]) -> list[dict]:
    """Stamp each payload with its meeting page's frontmatter.

    If the checkout is unavailable this raises and the run fails: ingesting on
    the channel alone could show a meeting to a wider audience than its page
    says. Nothing is written and the next run retries.
    """
    root = _page_root() if raws else None
    if root is None:
        return raws
    return fireflies_tags.stamp_pages(raws, root, _raw_external_id)


def _slugify(text: str | None, max_len: int = 60) -> str:
    if not text:
        return "untitled"
    slug = text.lower().strip()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:max_len]


def _external_id(title: str, date_str: str, suffix: str | None = None) -> str:
    """`{date}-{slug}.md`, plus a suffix only when `_disambiguate()` set one.

    The bare form must stay byte-identical to the disk-sourced connector's
    filename, so an API-fetched transcript lands on the SAME row a
    disk-sourced one would have. Only genuine same-title/same-day collisions
    take the suffixed form -- see `_disambiguate()`.
    """
    tail = f"-{suffix}" if suffix else ""
    return f"{date_str}-{_slugify(title)}{tail}.md"


def _parse_meeting_date(value: Any) -> datetime | None:
    """Fireflies `date` -> aware UTC datetime, or None if unparseable.

    The live API returns epoch MILLISECONDS as an int (measured 2026-08-25),
    not the ISO string the GraphQL `DateTime` type implies. Both shapes are
    accepted so a schema change in either direction cannot silently fall back
    to "today" -- that fallback would corrupt `external_id`, which is built
    from the meeting date and must match the disk-sourced transcripts.
    """
    if value is None or value == "":
        return None

    if isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        # Values past ~10^11 are milliseconds; below that, seconds.
        seconds = value / 1000 if abs(value) > 1e11 else float(value)
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None

    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None

    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _list_stubs(from_date: datetime) -> list[dict]:
    """Page the transcript listing from `from_date` up to the run budget.

    Returns a new list; never mutates a caller's collection. Stops on the
    first short page -- Fireflies has no total count, so a page smaller than
    `API_PAGE_LIMIT` is the only end-of-listing signal available.
    """
    collected: list[dict] = []

    while len(collected) < MAX_TRANSCRIPTS_PER_RUN:
        remaining = MAX_TRANSCRIPTS_PER_RUN - len(collected)
        page_size = min(API_PAGE_LIMIT, remaining)

        listing = _gql(
            _LIST_QUERY,
            {
                "fromDate": from_date.isoformat(),
                "limit": page_size,
                "skip": len(collected),
            },
        )
        page = listing.get("transcripts") or []
        collected = [*collected, *page]

        if len(page) < page_size:
            break

        time.sleep(API_DELAY_SECONDS)

    return collected


def _disambiguate(raws: list[dict]) -> list[dict]:
    """Stamp a suffix on transcripts that would collide on `external_id`.

    `external_id` is `{date}-{slug(title)}.md`, which the disk-sourced
    connector got for free -- a filesystem cannot hold two identical names.
    The API can and does: measured 2026-08-25, two distinct meetings shared
    'Weekly Build Sessions' on 2026-07-07, and only ONE of them was
    ever stored. The other was silently absent from the knowledge base.

    Rule: within a colliding group, the EARLIEST meeting keeps the bare
    `external_id` -- so the row already in the database keeps its identity,
    its distillation and its review state -- and each later one is suffixed
    with its start time (or a short transcript-id fragment if even the times
    match). Ordering is by (meeting time, transcript id), so the assignment
    is stable across runs and never depends on API response order.

    Groups are keyed on the SLUGIFIED title, exactly as `_external_id()`
    builds it -- 'Client Scope' and 'Client scope!' collide on disk too. When two
    later members share a start minute (measured 2026-09-28: one call
    recorded by four attendees' bots, two in the same minute), the second
    gets the HHMM plus a transcript-id fragment so the batch stays unique.

    Returns new dicts; the input payloads are not mutated.
    """
    groups: dict[tuple[str, str], list[dict]] = {}
    for raw in raws:
        parsed = _parse_meeting_date(raw.get("date"))
        title = (raw.get("title") or "Untitled Meeting").strip()
        date_str = (parsed or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
        groups.setdefault((_slugify(title), date_str), []).append(raw)

    suffixes: dict[str, str] = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        ordered = sorted(
            members,
            key=lambda r: (
                (_parse_meeting_date(r.get("date")) or datetime.max.replace(
                    tzinfo=timezone.utc
                )).isoformat(),
                str(r.get("id") or ""),
            ),
        )
        used: set[str] = set()
        for position, member in enumerate(ordered):
            if position == 0:
                continue
            parsed = _parse_meeting_date(member.get("date"))
            id_fragment = str(member.get("id") or "")[:6].lower()
            stamp = parsed.strftime("%H%M") if parsed else ""
            if not stamp or stamp == "0000":
                stamp = id_fragment
            elif stamp in used:
                stamp = f"{stamp}-{id_fragment}"
            used.add(stamp)
            suffixes[str(member.get("id"))] = stamp

    return [
        {**raw, "_external_id_suffix": suffixes[str(raw.get("id"))]}
        if str(raw.get("id")) in suffixes
        else raw
        for raw in raws
    ]


def fetch(cursor: dict, *, sb: Any = None) -> tuple[Iterable[dict], dict]:
    """List transcripts since the cursor, fetch each in full.

    Raw payload per item is the full Fireflies `transcript` object -- bronze
    gets the assembled transcript text via `to_document()`'s side effect,
    same shape `fireflies_ingest.py` writes today.
    """
    from datetime import timedelta

    last_checked = cursor.get("last_checked")
    if last_checked:
        high_water = datetime.fromisoformat(last_checked)
        # Re-list the last RELIST_DAYS too: Fireflies can finish a meeting's
        # notes hours after the transcript appears. Unchanged rows cost no
        # writes (upsert is idempotent; the page writer skips identical pages).
        from_date = high_water - timedelta(days=RELIST_DAYS)
    else:
        high_water = datetime.now(timezone.utc) - timedelta(days=BOOTSTRAP_LOOKBACK_DAYS)
        from_date = high_water

    stubs = _list_stubs(from_date)

    raws: list[dict] = []
    newest_seen = high_water  # the cursor never moves backwards
    for stub in stubs:
        time.sleep(API_DELAY_SECONDS)
        full = _fetch_transcript(stub["id"])
        if not full:
            continue
        raws.append(full)
        meeting_date = _parse_meeting_date(full.get("date"))
        if meeting_date and meeting_date > newest_seen:
            newest_seen = meeting_date

    own = _disambiguate(raws)
    shared_raws, shared_state = _fetch_shared(
        sb, cursor, listed={s["id"] for s in stubs}, taken={_raw_external_id(r) for r in own},
    )
    stamped = _with_page_tags([*own, *shared_raws])
    return stamped, {"last_checked": newest_seen.isoformat(), **shared_state}


def _raw_external_id(raw: dict) -> str:
    """The external_id `to_document()` will give this transcript."""
    title = (raw.get("title") or "Untitled Meeting").strip()
    meeting_date = _parse_meeting_date(raw.get("date"))
    date_str = (meeting_date or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
    return _external_id(title, date_str, raw.get("_external_id_suffix"))


def _read_shared_cursor(sb: Any) -> dict:
    from knowledge import cursors

    return cursors.get_cursor(fireflies_shared.SHARED_SOURCE, sb=sb)


def _stored_by_other(sb: Any, external_id: str, fireflies_id: str) -> bool:
    """True when a stored row already holds `external_id` for a different
    recording. On a read error, assume it does (a suffix is the safe side)."""
    try:
        rows = (
            db(sb).table("documents").select("metadata")
            .eq("source", SOURCE_FIREFLIES).eq("external_id", external_id).limit(1).execute().data
        )
    except Exception:  # noqa: BLE001
        return True
    return bool(rows) and (rows[0].get("metadata") or {}).get("fireflies_id") != fireflies_id


def _own_window(start: datetime, end: datetime) -> list[dict]:
    """The owner's own recordings that started from LOOKBACK before `start` up to `end`."""
    listing = _gql(
        _WINDOW_QUERY,
        {
            "fromDate": (start - fireflies_shared.LOOKBACK).isoformat(),
            "toDate": end.isoformat(),
            "limit": 20,
        },
    )
    return listing.get("transcripts") or []


def _judge_shared(meeting_id: str, trusted: frozenset[str]) -> tuple[dict | None, str | None]:
    """Fetch one shared meeting -> (transcript to ingest, None), or
    (None, reason it is skipped for good). Raises when it should be retried.
    `trusted` is the set of organizer email domains that may be ingested."""
    full = _fetch_transcript(meeting_id)
    if not full:
        raise FirefliesConnectorError("not available")
    if not fireflies_shared.trusted_organizer(full, trusted):
        return None, "organizer is not on the trusted list"
    bounds = fireflies_shared.span(full)
    if bounds is not None and fireflies_shared.is_duplicate(full, _own_window(*bounds)):
        return None, "the owner's own Fireflies recorded this call"
    return full, None


def _fetch_shared(sb: Any, cursor: dict, *, listed: set[str], taken: set[str]) -> tuple[list[dict], dict]:
    """Meetings shared with the owner that the owner's own listing cannot see.

    Runs only when `sources.fireflies.shared_meetings.enabled` is true in the
    Engine config; otherwise it returns nothing and reads nothing.

    Ids come from the `fireflies-shared` row a mailbox scanner writes. Each
    id is handled once (`shared_seen` in this source's own cursor): ingested,
    or skipped for an untrusted organizer or as a second recording of one of
    the owner's own calls. A failing id is retried on later runs and given up
    after MAX_TRIES (`shared_tries`); it never fails the run. A shared meeting
    never takes an external_id that another recording already holds, and
    never moves `last_checked`.
    """
    now = datetime.now(timezone.utc)
    seen = fireflies_shared.prune_seen(dict(cursor.get("shared_seen") or {}), now=now)
    tries = dict(cursor.get("shared_tries") or {})
    config = get_config()
    if sb is None or not config.sources.fireflies.shared_meetings_enabled:
        return [], fireflies_shared.state(seen, tries)
    trusted = fireflies_shared.trusted_domains(config.sources.fireflies.shared_trusted_domains)
    try:
        shared_cursor = _read_shared_cursor(sb)
    except Exception as error:  # noqa: BLE001 -- own meetings must still ingest
        print(f"[fireflies] shared: could not read the scanner row: {type(error).__name__}")
        return [], fireflies_shared.state(seen, tries)

    raws: list[dict] = []
    for meeting_id in fireflies_shared.pending(shared_cursor, seen=seen, listed=listed):
        time.sleep(API_DELAY_SECONDS)
        try:
            full, reason = _judge_shared(meeting_id, trusted)
        except Exception as error:  # noqa: BLE001 -- one bad id must not stop the run
            seen, tries = fireflies_shared.record_failure(meeting_id, seen, tries, now=now)
            gave_up = " (giving up)" if meeting_id in seen else ""
            print(f"[fireflies] shared {meeting_id}: {type(error).__name__}: {str(error)[:120]}{gave_up}")
            continue
        seen = {**seen, meeting_id: now.isoformat()}
        tries = {k: v for k, v in tries.items() if k != meeting_id}
        if full is None:
            print(f"[fireflies] shared {meeting_id}: skipped, {reason}")
            continue
        external_id = _raw_external_id(full)
        if external_id in taken or _stored_by_other(sb, external_id, meeting_id):
            full = {**full, "_external_id_suffix": fireflies_shared.shared_suffix(meeting_id)}
            external_id = _raw_external_id(full)
        taken = {*taken, external_id}
        # Marked so retention never tries to delete someone else's recording.
        raws.append({**full, "_shared": True})
    if raws:
        print(f"[fireflies] shared: {len(raws)} meeting(s) added")
    live = set((shared_cursor.get("ids") or {}))
    return raws, fireflies_shared.state(seen, {k: v for k, v in tries.items() if k in live})


def _sentences_shape(raw: dict) -> str:
    """How `sentences` is absent, for a SkipPayload reason: "absent" (key
    missing), "null" (present but None), or "empty" (present but falsy)."""
    if "sentences" not in raw:
        return "absent"
    if raw.get("sentences") is None:
        return "null"
    return "empty"


def to_document(raw: dict) -> Document:
    """One Fireflies `transcript` object -> the full-transcript Document.

    Mirrors `connectors/transcripts.py::_transcript_to_document` exactly for
    title parsing, date parsing and the wiki cross-link, so a transcript
    fetched via the API lands under the SAME external_id a disk-sourced one
    would have used.
    """
    title = (raw.get("title") or "Untitled Meeting").strip()
    meeting_date = _parse_meeting_date(raw.get("date"))
    date_str = (meeting_date or datetime.now(timezone.utc)).strftime("%Y-%m-%d")

    filename = _raw_external_id(raw)

    from pullers.meeting_page import render_notes_block, transcript_lines_from_sentences

    duration = round(float(raw.get("duration") or 0))
    sentences = raw.get("sentences") or []
    summary = raw.get("summary") or {}
    notes_available = any(summary.values())
    # One empty transcript must not wedge the puller. With notes we ingest a
    # notes-only document; with nothing at all the runner skips this payload so
    # the cursor still advances past it (see pullers/runner.py::build_documents).
    transcript_unavailable = not sentences
    if transcript_unavailable and not notes_available:
        shape = _sentences_shape(raw)
        raise SkipPayload(
            external_id=raw.get("id"),
            reason=(
                f"Fireflies transcript {raw.get('id')} has no sentences and no notes "
                f"(sentences={shape}, duration={duration} min, title={title})"
            ),
        )
    if transcript_unavailable:
        print(f"[fireflies] {raw.get('id')}: no sentences (sentences={_sentences_shape(raw)}), ingesting notes only")
    header = [
        f"# Transcript: {title}",
        f"**Date:** {date_str} | **Duration:** {duration} min",
        "",
    ]
    # Fireflies' notes ride in the body (and so in bronze) so they survive the
    # recording's deletion from Fireflies -- see pullers/fireflies_retention.py.
    if notes_available:
        header += [render_notes_block(summary), ""]
    header += ["---", ""]
    body = "\n".join(header) + (
        "(no transcript stored: Fireflies returned no sentences)"
        if transcript_unavailable
        else "\n".join(transcript_lines_from_sentences(sentences))
    )

    # Channel tag, or the meeting page's own tag once it exists. Never the title.
    assignment = fireflies_tags.assignment(raw, get_config())

    return Document(
        source=SOURCE_FIREFLIES,
        external_id=filename,
        title=title,
        body=body,
        distillation=None,
        url=None,
        author=raw.get("organizer_email"),
        domains=assignment.domains,
        tier=TIER_DISTILLED,
        source_created_at=datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc),
        metadata={
            "filename": filename,
            "fireflies_id": raw.get("id"),
            # Filled by before_upsert() once the page is on knowledge main. If the
            # write-back fails, before_upsert carries over the value already
            # stored on this row so a re-index never clears a recorded link.
            "wiki_page_id": None,
            **({} if notes_available else {"fireflies_notes_unavailable": True}),
            **({"fireflies_transcript_unavailable": True} if transcript_unavailable else {}),
            **({"fireflies_shared": True} if raw.get("_shared") else {}),
            "domain_match": assignment.matched_by,
        },
        tag_source=assignment.matched_by,
        tag_signals=assignment.signals,
    )


def keep_stored_page_ids(documents: list[Document], sb: Any) -> list[Document]:
    """Carry over the `wiki_page_id` already stored for any document still missing
    one, so a re-index whose wiki write-back failed never clears a recorded link.

    A document stamped with a fresh link this run keeps it (its value is truthy);
    only documents with a falsy `wiki_page_id` are back-filled from the store. A
    lookup failure must never stop the upsert, so on any error the documents are
    returned unchanged.
    """
    from dataclasses import replace

    from pullers import meeting_writeback

    if not sb:
        return documents
    missing = [doc.external_id for doc in documents if not doc.metadata.get("wiki_page_id")]
    if not missing:
        return documents
    try:
        stored = meeting_writeback.stored_page_ids(sb, missing)
    except Exception as error:  # noqa: BLE001 -- the Supabase write must still happen
        print(f"[fireflies] keep stored wiki_page_id failed: {type(error).__name__}: {error}")
        return documents
    if not stored:
        return documents
    return [
        replace(doc, metadata={**doc.metadata, "wiki_page_id": stored[doc.external_id]})
        if not doc.metadata.get("wiki_page_id") and doc.external_id in stored else doc
        for doc in documents
    ]


def before_upsert(raws: list[dict], documents: list[Document], sb: Any) -> tuple[list[Document], dict]:
    """Write this batch's meeting pages (plus any recent row still missing one)
    to the knowledge repo, and stamp `metadata.wiki_page_id` on the documents
    about to be upserted. Never raises: a failed write leaves wiki_page_id
    unset and the next run's self-heal sweep retries from the stored row.
    """
    from dataclasses import replace

    from pullers import fireflies_retention, knowledge_repo, meeting_writeback
    from pullers.meeting_page import MeetingInput

    info: dict = {}
    try:
        by_external = {doc.external_id: doc for doc in documents}
        inputs = [
            MeetingInput.from_raw(
                raw,
                external_id=doc.external_id,
                domain_tags=tuple(doc.domains or ()),
                page_topics=fireflies_tags.writable_topics(doc),
            )
            for raw, doc in zip(raws, documents)
        ]
        healing = meeting_writeback.self_heal_rows(sb, exclude=set(by_external)) if sb else []
        inputs += [MeetingInput.from_row(row) for row in healing]

        root = knowledge_repo.resolve_root()
        receipt = meeting_writeback.write_pages(inputs, root=root)
        info = {
            "wiki_written": len(receipt.written),
            "wiki_unchanged": len(receipt.unchanged),
            "wiki_skipped": receipt.skipped,
            "wiki_commit": receipt.commit,
            "wiki_error": receipt.error,
        }
        print(f"[fireflies] wiki write-back: {receipt.summary()}")

        stamped = [
            replace(doc, metadata={**doc.metadata, "wiki_page_id": receipt.page_ids[doc.external_id]})
            if doc.external_id in receipt.page_ids else doc
            for doc in documents
        ]
        healed = {
            row["external_id"]: receipt.page_ids[row["external_id"]]
            for row in healing if row["external_id"] in receipt.page_ids
        }
        if healed and sb:
            info["wiki_healed"] = meeting_writeback.patch_page_ids(sb, healed)

        # Retention only after a clean write-back, so the wiki-file gate checks
        # the checkout this run just pushed.
        try:
            enabled, retention_dry_run, days = fireflies_retention.settings(read_env_file(ENV_PATH))
            if sb and receipt.error is None and (enabled or retention_dry_run):
                retention = fireflies_retention.run(
                    sb, root, days=days, dry_run=not enabled or retention_dry_run,
                )
                info["retention"] = retention.summary()
                info["retention_skipped"] = retention.skipped[:50]
                info["retention_errors"] = retention.errors[:50]
                print(f"[fireflies] retention: {retention.summary()}")
        except Exception as error:  # noqa: BLE001 -- never lose the page stamps over retention
            info["retention_error"] = f"{type(error).__name__}: {error}"
            print(f"[fireflies] retention failed: {info['retention_error']}")
        return keep_stored_page_ids(stamped, sb), info
    except Exception as error:  # noqa: BLE001 -- the Supabase write must still happen
        import traceback

        traceback.print_exc()
        return keep_stored_page_ids(documents, sb), {**info, "wiki_error": f"{type(error).__name__}: {error}"}
