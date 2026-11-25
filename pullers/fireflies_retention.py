"""Gated 90-day Fireflies cleanup -- delete a recording only once it is safe.

Fireflies storage is limited, so old recordings must go. But a deleted
recording takes Fireflies' notes with it, so a meeting is deleted ONLY when
every gate holds:

1. the meeting is older than `days` (FIREFLIES_RETENTION_DAYS, default 90);
2. its `workspace.documents` row is live and its body holds the Fireflies
   notes block -- or Fireflies never produced notes
   (`metadata.fireflies_notes_unavailable`);
3. `metadata.wiki_page_id` is set AND that file is committed on origin/main;
4. bronze (`raw_captures_latest`) holds the same notes, so the text is
   recoverable even if the documents row is rewritten;
5. a LIVE re-read of the Fireflies summary, right before the delete, finds
   nothing the stored notes lack (Fireflies can finish notes hours late);
6. the recording actually produced a transcript -- a notes-only row
   (`metadata.fireflies_transcript_unavailable`) is never deleted, since
   Fireflies may still finish the transcript later.

Anything failing a gate is skipped with its reason and never deleted. At most
`cap` deletes per run, so a bug cannot empty the account in one go. Disabled
unless FIREFLIES_RETENTION_ENABLED=true; FIREFLIES_RETENTION_DRY_RUN=true
lists what would go without deleting.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from pullers.meeting_page import NOTES_START, has_notes, parse_notes_block
from knowledge.kb_schema import db

DEFAULT_DAYS = 90
DEFAULT_CAP = 25
API_DELAY_SECONDS = 1

_DELETE_MUTATION = """
mutation DeleteTranscript($id: String!) {
  deleteTranscript(id: $id) { id }
}
"""


@dataclass(frozen=True, slots=True)
class Candidate:
    fireflies_id: str
    rows: tuple[dict, ...]  # every stored row recorded from this recording

    @property
    def external_ids(self) -> list[str]:
        return [row["external_id"] for row in self.rows]


@dataclass
class RetentionReceipt:
    enabled: bool = False
    dry_run: bool = False
    eligible: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"enabled={self.enabled} dry_run={self.dry_run} eligible={len(self.eligible)} "
            f"deleted={len(self.deleted)} skipped={len(self.skipped)} errors={len(self.errors)}"
        )


def settings(env: dict[str, str | None]) -> tuple[bool, bool, int]:
    def _flag(key: str) -> bool:
        return (env.get(key) or "").strip().lower() in {"1", "true", "yes"}

    try:
        days = int(env.get("FIREFLIES_RETENTION_DAYS") or DEFAULT_DAYS)
    except ValueError:
        days = DEFAULT_DAYS
    return _flag("FIREFLIES_RETENTION_ENABLED"), _flag("FIREFLIES_RETENTION_DRY_RUN"), max(days, 30)


def _old_rows(sb, cutoff_iso: str) -> list[dict]:
    rows: list[dict] = []
    start = 0
    while True:
        page = (
            db(sb).table("documents")
            .select("external_id,body,metadata,source_created_at")
            .eq("source", "fireflies").is_("parent_external_id", "null").is_("deleted_at", "null")
            .lt("source_created_at", cutoff_iso)
            .order("source_created_at").range(start, start + 199).execute().data or []
        )
        rows += page
        if len(page) < 200:
            return rows
        start += 200


def _bronze_text(sb, external_id: str) -> str | None:
    rows = (
        db(sb).table("raw_captures_latest").select("raw_text")
        .eq("source", "fireflies").eq("external_id", external_id).limit(1).execute().data or []
    )
    return rows[0].get("raw_text") if rows else None


def page_on_main(root: Path) -> Callable[[str], bool]:
    """True only when the page is committed on origin/main -- not merely in
    the working tree, where an unpushed or aborted commit would also show."""
    import subprocess

    def _check(page_id: str) -> bool:
        result = subprocess.run(
            ["git", "-C", str(root), "cat-file", "-e", f"origin/main:{page_id}"],
            capture_output=True, text=True, timeout=30,
        )
        return result.returncode == 0

    return _check


def gate(row: dict, page_exists: Callable[[str], bool], bronze_text: str | None) -> str | None:
    """None when the stored copy looks complete; otherwise the reason it is not.
    (The live re-check in `run()` is the final word on notes.)"""
    metadata = row.get("metadata") or {}
    if not metadata.get("fireflies_id"):
        return "no fireflies_id"
    if metadata.get("fireflies_deleted_at"):
        return "already deleted"
    if metadata.get("fireflies_shared"):
        return "shared by someone else's Fireflies; not ours to delete"
    if metadata.get("fireflies_transcript_unavailable"):
        return "no transcript stored"
    notes_unavailable = bool(metadata.get("fireflies_notes_unavailable"))
    if not notes_unavailable and not has_notes(row.get("body") or ""):
        return "notes not saved in Supabase"
    page_id = metadata.get("wiki_page_id")
    if not page_id:
        return "no wiki_page_id"
    if not page_exists(page_id):
        return f"wiki page not on origin/main: {page_id}"
    if bronze_text is None:
        return "no bronze capture"
    if not notes_unavailable and NOTES_START not in bronze_text:
        return "notes not saved in bronze"
    return None


def eligible(sb, page_exists: Callable[[str], bool], *, days: int, now: datetime | None = None,
             bronze: Callable[[object, str], str | None] = _bronze_text
             ) -> tuple[list[Candidate], list[tuple[str, str]]]:
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=days)).isoformat()
    groups: dict[str, list[dict]] = {}
    skipped: list[tuple[str, str]] = []
    for row in _old_rows(sb, cutoff):
        reason = gate(row, page_exists, bronze(sb, row["external_id"]))
        if reason:
            if reason != "already deleted":
                skipped.append((row["external_id"], reason))
            continue
        groups.setdefault(row["metadata"]["fireflies_id"], []).append(row)
    return [Candidate(fid, tuple(rows)) for fid, rows in groups.items()], skipped


_LIVE_SUMMARY_QUERY = """
query LiveSummary($id: String!) {
  transcript(id: $id) {
    id
    summary { overview notes shorthand_bullet short_summary action_items keywords }
  }
}
"""

NOT_FOUND = "not found in Fireflies"


def live_check_default(fireflies_id: str, rows: tuple[dict, ...]) -> str | None:
    """Re-read Fireflies right before deleting. Fireflies can finish a summary
    hours after the transcript was ingested; any field it has now must be in
    the stored notes block, or the delete is refused."""
    from pullers.fireflies import _gql

    transcript = _gql(_LIVE_SUMMARY_QUERY, {"id": fireflies_id}).get("transcript")
    if not transcript:
        return NOT_FOUND
    return compare_live(transcript.get("summary") or {}, rows)


def compare_live(live: dict, rows: tuple[dict, ...]) -> str | None:
    stored: dict = {}
    for row in rows:
        stored = {**parse_notes_block(row.get("body") or ""), **stored}
    missing = [key for key, value in live.items() if value and not stored.get(key)]
    return f"Fireflies has notes not saved: {', '.join(sorted(missing))}" if missing else None


def _delete_live(fireflies_id: str) -> None:
    from pullers.fireflies_upstream_delete import delete_live_with_backoff

    delete_live_with_backoff(_DELETE_MUTATION, fireflies_id)


def _mark_deleted(sb, candidate: Candidate, stamp: str, receipt: RetentionReceipt) -> None:
    for row in candidate.rows:
        try:
            (
                db(sb).table("documents")
                .update({"metadata": {**(row.get("metadata") or {}), "fireflies_deleted_at": stamp}})
                .eq("source", "fireflies").eq("external_id", row["external_id"]).execute()
            )
        except Exception as error:  # noqa: BLE001 -- recorded, never fatal
            receipt.errors.append((row["external_id"], f"mark deleted failed: {error}"))


def run(sb, root: Path | None = None, *, days: int = DEFAULT_DAYS, cap: int = DEFAULT_CAP,
        dry_run: bool = False,
        delete: Callable[[str], None] = _delete_live,
        live_check: Callable[[str, tuple[dict, ...]], str | None] = live_check_default,
        bronze: Callable[[object, str], str | None] = _bronze_text,
        page_exists: Callable[[str], bool] | None = None,
        now: datetime | None = None) -> RetentionReceipt:
    receipt = RetentionReceipt(enabled=True, dry_run=dry_run)
    if page_exists is None:
        if root is None:
            raise ValueError("run() needs root or page_exists")
        page_exists = page_on_main(root)
    ready, receipt.skipped = eligible(sb, page_exists, days=days, now=now, bronze=bronze)
    receipt.eligible = [eid for c in ready for eid in c.external_ids]
    if dry_run:
        return receipt

    attempted = 0
    for candidate in ready:
        if attempted >= cap:
            break
        try:
            reason = live_check(candidate.fireflies_id, candidate.rows)
        except Exception as error:  # noqa: BLE001
            receipt.errors.append((candidate.external_ids[0], f"live check failed: {error}"))
            continue
        if reason == NOT_FOUND:
            _mark_deleted(sb, candidate, "not-found-in-fireflies", receipt)
            continue
        if reason:
            receipt.skipped.append((candidate.external_ids[0], reason))
            continue
        attempted += 1
        try:
            delete(candidate.fireflies_id)
        except Exception as error:  # noqa: BLE001 -- one failure must not stop the run
            receipt.errors.append((candidate.external_ids[0], f"{type(error).__name__}: {error}"))
            continue
        _mark_deleted(sb, candidate, datetime.now(timezone.utc).isoformat(), receipt)
        receipt.deleted.extend(candidate.external_ids)
        time.sleep(API_DELAY_SECONDS if delete is _delete_live else 0)
    return receipt
