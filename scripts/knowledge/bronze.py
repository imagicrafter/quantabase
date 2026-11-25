"""Bronze layer -- immutable raw source text.

Wraps `workspace.raw_captures` / `workspace.raw_captures_latest`
(supabase/migrations/0008_raw_captures.sql). See that file's header for why
this layer exists: re-distillation must never need a fetch.

APPEND-ONLY, enforced at the privilege level, not by convention. This module
must not grow an update or delete path -- the grants forbid it (INSERT/SELECT
only, not even for service_role).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Iterator

from .supabase_client import get_supabase
from .kb_schema import db

VALID_SOURCES = frozenset({"gmail", "fireflies", "drive"})


class BronzeError(RuntimeError):
    """A single capture could not be written or read."""


@dataclass(frozen=True, slots=True)
class CaptureResult:
    """What `capture()` actually did for one document."""

    source: str
    external_id: str
    capture_hash: str
    status: str  # 'inserted' | 'unchanged'


def _hash(raw_text: str) -> str:
    return hashlib.sha256(raw_text.encode("utf-8")).hexdigest()


def capture(
    source: str, external_id: str, raw_text: str, raw_metadata: dict, *, sb=None
) -> CaptureResult:
    """Insert a raw capture. Never updates, never deletes.

    A re-fetch of unchanged content hits the (source, external_id, capture_hash)
    unique constraint and is reported as `unchanged` -- nothing is written.

    `sb`: an existing Supabase client, or None to build the service-role one.
    The default exists only for pre-cutover callers on a long-lived host
    (`workflows/capture_sources.py`); it should be deleted once
    `tasks/workflows/knowledge-capture.yaml` retires (plan Step 7).
    `pullers/runner.py` always passes its `kb_ingest`-scoped client.
    """
    if source not in VALID_SOURCES:
        raise BronzeError(
            f"Unknown source {source!r}; must be one of {sorted(VALID_SOURCES)}."
        )
    if not external_id or not external_id.strip():
        raise BronzeError("external_id must not be blank.")
    if not raw_text or not raw_text.strip():
        raise BronzeError(f"raw_text for {source}/{external_id} must not be blank.")

    capture_hash = _hash(raw_text)
    sb = sb or get_supabase()

    try:
        (
            db(sb)
            .table("raw_captures")
            .insert(
                {
                    "source": source,
                    "external_id": external_id,
                    "capture_hash": capture_hash,
                    "raw_text": raw_text,
                    "raw_metadata": raw_metadata or {},
                }
            )
            .execute()
        )
        return CaptureResult(
            source=source, external_id=external_id, capture_hash=capture_hash, status="inserted"
        )
    except Exception as error:
        # PostgREST reports a unique-constraint conflict as a 409/23505 error,
        # not a distinguishable exception type -- match on the constraint name.
        if "raw_captures_version_uniq" in str(error) or "23505" in str(error):
            return CaptureResult(
                source=source,
                external_id=external_id,
                capture_hash=capture_hash,
                status="unchanged",
            )
        raise BronzeError(
            f"Capture failed for {source}/{external_id}: {error}"
        ) from error


def capture_batch(
    items: list[tuple[str, str, str, dict]], *, sb=None
) -> tuple[list[CaptureResult], list[dict]]:
    """Capture many documents. One failure does not abort the batch.

    Args:
        items: list of (source, external_id, raw_text, raw_metadata).
        sb: an existing Supabase client, or None -- see `capture()`.

    Returns:
        (results, errors) -- errors are {"source", "external_id", "error"} dicts.
    """
    results: list[CaptureResult] = []
    errors: list[dict] = []
    for source, external_id, raw_text, raw_metadata in items:
        try:
            results.append(capture(source, external_id, raw_text, raw_metadata, sb=sb))
        except BronzeError as error:
            errors.append({"source": source, "external_id": external_id, "error": str(error)})
    return results, errors


def read_latest(source: str, external_id: str) -> dict | None:
    """The most recent capture for one document, or None if never captured."""
    sb = get_supabase()
    try:
        resp = (
            db(sb)
            .table("raw_captures_latest")
            .select("raw_text, raw_metadata, capture_hash, fetched_at")
            .eq("source", source)
            .eq("external_id", external_id)
            .limit(1)
            .execute()
        )
    except Exception as error:
        raise BronzeError(
            f"Could not read raw_captures_latest for {source}/{external_id}: {error}"
        ) from error

    rows = resp.data or []
    return rows[0] if rows else None


def iter_latest(source: str) -> Iterator[dict]:
    """The most recent capture per external_id for a source, paginated."""
    sb = get_supabase()
    page_size = 500
    offset = 0
    while True:
        try:
            resp = (
                db(sb)
                .table("raw_captures_latest")
                .select("external_id, raw_text, raw_metadata, capture_hash, fetched_at")
                .eq("source", source)
                .order("external_id")
                .range(offset, offset + page_size - 1)
                .execute()
            )
        except Exception as error:
            raise BronzeError(
                f"Could not read raw_captures_latest for source {source!r}: {error}"
            ) from error

        rows = resp.data or []
        if not rows:
            return
        yield from rows
        if len(rows) < page_size:
            return
        offset += page_size
