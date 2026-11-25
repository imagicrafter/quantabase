"""Ingest pipeline -- Document objects into workspace.documents.

Three properties this module exists to guarantee:

1. **Idempotent.** A second run over unchanged input performs zero writes and
   zero re-embeddings. Enforced by comparing `Document.source_hash` against the
   stored `source_hash` before doing any work.
2. **Tombstone, never hard-delete.** A full sync marks absent external_ids with
   `deleted_at`. The index stays auditable and rebuildable.
3. **Isolated from memory_chunks.** Only `documents*` objects are touched.

Runs on a developer machine only -- embedding needs sentence-transformers, which is not
installed on an agent host.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence

from .config import EMBED_BATCH_SIZE, UPSERT_BATCH_SIZE, verify_taxonomy
from .contract import Document
from .owners import OwnerError, owner_column, owner_ids
from .supabase_client import get_supabase
from .kb_schema import db

# scripts/ on the path so `knowledge` resolves when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# A full_sync run that would tombstone more than this share of a source's live
# rows aborts rather than writing -- see the guard in upsert(). A connector
# whose default scope is narrower than the corpus it syncs against reads
# absence as deletion; this is the rail against that, not a policy on real
# mass deletions (allow_bulk_tombstone=True still permits those explicitly).
# Superseded section rows -- an absent id whose stored parent page is still in
# the fetch -- are EXEMPT from this share (split_superseded): renumbering a
# page's `##` headings moves hundreds of section ids at once without deleting a
# single page, and counting them tripped the guard for 13 nights straight
# (2026-10-24 to 2026-11-05). They are still soft-deleted, just not guarded.
BULK_TOMBSTONE_THRESHOLD = 0.10
# Rows asked for per request when reading what is already stored.
EXISTING_PAGE_SIZE = 500


class IngestError(RuntimeError):
    """Ingest could not complete."""


@dataclass(frozen=True, slots=True)
class IngestResult:
    """What a run actually did. Zero writes on an unchanged re-run."""

    source: str
    scanned: int
    inserted: int
    updated: int
    unchanged: int
    tombstoned: int
    revived: int
    embedded: int

    @property
    def wrote_anything(self) -> bool:
        return bool(self.inserted or self.updated or self.tombstoned or self.revived)

    def summary(self) -> str:
        return (
            f"[{self.source}] scanned={self.scanned} inserted={self.inserted} "
            f"updated={self.updated} unchanged={self.unchanged} "
            f"tombstoned={self.tombstoned} revived={self.revived} "
            f"embedded={self.embedded}"
        )


def _fetch_existing(sb, source: str) -> dict[str, dict]:
    """Map external_id -> {source_hash, deleted_at, embed_hash, review_status, parent_external_id}.

    `parent_external_id` lets the bulk-tombstone guard tell a renumbered section
    (its page still in the fetch) from a real deletion -- see split_superseded.
    """
    rows: list[dict] = []
    while True:
        # A page at a time: one request returns at most a fixed number of rows,
        # and a row left out here would be re-inserted as new (keeping an old
        # approval) and could never be tombstoned.
        try:
            resp = (
                db(sb)
                .table("documents")
                .select(
                    "external_id, source_hash, deleted_at, metadata, review_status, "
                    "parent_external_id"
                )
                .eq("source", source)
                .order("external_id")
                .range(len(rows), len(rows) + EXISTING_PAGE_SIZE - 1)
                .execute()
            )
        except Exception as error:
            raise IngestError(
                f"Could not read existing documents for source '{source}'. "
                "Has migration 0001_documents_table.sql been applied?"
            ) from error
        page = resp.data or []
        rows.extend(page)
        if len(page) < EXISTING_PAGE_SIZE:
            break

    return {
        row["external_id"]: {
            "source_hash": row["source_hash"],
            "deleted_at": row["deleted_at"],
            "embed_hash": (row.get("metadata") or {}).get("_embed_hash"),
            "review_status": row.get("review_status"),
            "parent_external_id": row.get("parent_external_id"),
        }
        for row in rows
    }


def _embed(texts: Sequence[str]) -> list[list[float]]:
    """Embed in batches via the backend-agnostic knowledge.embedder."""
    if not texts:
        return []

    from .embedder import EmbeddingError, embed_texts

    vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = list(texts[start : start + EMBED_BATCH_SIZE])
        try:
            vectors.extend(embed_texts(batch))
        except EmbeddingError as error:
            raise IngestError(
                f"Embedding failed on batch starting at index {start}: {error}"
            ) from error
    return vectors


def group_by_columns(rows: Sequence[dict]) -> list[list[dict]]:
    """Group rows so every group has an identical key set.

    PostgREST builds ONE INSERT per request using the UNION of keys across the
    payload, and fills a key a given row omits with NULL -- *not* with the
    column's DEFAULT. So a single row carrying an extra key rewrites every
    other row in the same request, and any NOT NULL DEFAULT column that the
    others omitted blows up.

    This is not hypothetical. The wiki connector failed for seven consecutive
    days (2026-08-15 to 2026-08-21) because `_review_reset` adds
    `review_status` to the rows whose prior approval was invalidated and to no
    others; `review_status` is NOT NULL DEFAULT 'unreviewed', so every
    non-resetting row in the batch was sent an explicit NULL and the whole
    batch was rejected. It was self-perpetuating: the batch never landed, so
    the changed row stayed changed-and-previously-approved, so the next run
    reset it again.

    Grouping by key set fixes that class of bug rather than that one column --
    a future NOT NULL DEFAULT column added to a subset of rows cannot
    reintroduce it. Order within a group is preserved.
    """
    groups: dict[frozenset, list[dict]] = {}
    for row in rows:
        groups.setdefault(frozenset(row.keys()), []).append(row)
    return list(groups.values())


def _upsert_rows(sb, rows: Sequence[dict]) -> None:
    for group in group_by_columns(rows):
        for start in range(0, len(group), UPSERT_BATCH_SIZE):
            batch = list(group[start : start + UPSERT_BATCH_SIZE])
            try:
                (
                    db(sb)
                    .table("documents")
                    .upsert(batch, on_conflict="source,external_id")
                    .execute()
                )
            except Exception as error:
                columns = ",".join(sorted(batch[0].keys())) if batch else "(empty)"
                raise IngestError(
                    f"Upsert failed on batch starting at index {start} "
                    f"(columns: {columns}): {error}"
                ) from error


def _patch_rows(sb, source: str, rows: Sequence[tuple[str, dict]]) -> None:
    """Update existing rows WITHOUT touching `embedding`.

    Never `.upsert()` here. A batched PostgREST upsert requires a uniform column
    set across the whole payload -- rows in the same call that carry `embedding`
    force every other row's missing `embedding` key to NULL rather than leaving
    it alone. `.update()` filtered to one row sets only the columns given, so a
    metadata-only write can never null out a stored vector.
    """
    for external_id, payload in rows:
        try:
            (
                db(sb)
                .table("documents")
                .update(payload)
                .eq("source", source)
                .eq("external_id", external_id)
                .execute()
            )
        except Exception as error:
            raise IngestError(
                f"Patch failed for {source}/{external_id}: {error}"
            ) from error


def _tombstone(sb, source: str, external_ids: Sequence[str]) -> int:
    """Soft-delete rows absent from a full sync. Never a hard delete."""
    if not external_ids:
        return 0

    stamp = datetime.now(timezone.utc).isoformat()
    tombstoned = 0
    for start in range(0, len(external_ids), UPSERT_BATCH_SIZE):
        batch = list(external_ids[start : start + UPSERT_BATCH_SIZE])
        try:
            resp = (
                db(sb)
                .table("documents")
                .update({"deleted_at": stamp})
                .eq("source", source)
                .in_("external_id", batch)
                .execute()
            )
        except Exception as error:
            raise IngestError(
                f"Tombstoning failed for source '{source}': {error}"
            ) from error
        tombstoned += len(resp.data or [])
    return tombstoned


def _assert_no_null_embeddings(sb, source: str) -> None:
    """Guard against the class of bug where a write nulls a live row's vector.

    Caught in production 2026-08-13: a batched upsert mixing rows with and
    without an `embedding` key forces the omitted key to NULL across the whole
    batch rather than leaving it alone (`_patch_rows` is the fix). This assert
    is the backstop so a similar mistake fails the run instead of shipping a
    row that is live but unfindable by semantic search.
    """
    try:
        resp = (
            db(sb)
            .table("documents")
            .select("external_id", count="exact")
            .eq("source", source)
            .is_("deleted_at", "null")
            .is_("embedding", "null")
            .execute()
        )
    except Exception as error:
        raise IngestError(
            f"Could not verify embeddings for source {source!r}: {error}"
        ) from error

    if resp.count:
        raise IngestError(
            f"{resp.count} live row(s) of source {source!r} have a NULL embedding "
            "after this run. This run's writes are not being rolled back -- "
            "investigate immediately; these rows are unfindable by search."
        )


def _refresh_stats(sb) -> None:
    """Rebuild BM25 stats for `documents` only.

    Deliberately NOT `refresh_memory_term_stats` and NOT `memory_search_stats`.
    Sharing those tables would have each indexer clobber the other's totals.
    """
    try:
        db(sb).rpc("refresh_documents_term_stats", {}).execute()
    except Exception as error:
        raise IngestError(
            "Could not refresh document BM25 stats. Has migration "
            "0003_documents_stats.sql been applied?"
        ) from error


def _validate_batch(docs: Sequence[Document], source: str) -> set[str]:
    """Reject a batch that cannot be safely synced. Returns the external_id set."""
    mismatched = {doc.source for doc in docs} - {source}
    if mismatched:
        raise IngestError(
            f"Documents carry source(s) {sorted(mismatched)} but the run is "
            f"scoped to '{source}'."
        )

    seen: set[str] = set()
    for doc in docs:
        if doc.external_id in seen:
            raise IngestError(
                f"Duplicate external_id '{doc.external_id}' emitted for source "
                f"'{source}'. external_id must be unique within a source."
            )
        seen.add(doc.external_id)
    return seen


def describe_absent(
    absent_ids: Sequence[str],
    present_ids: set[str],
    limit: int = 20,
) -> str:
    """Classify absent external_ids for a bulk-tombstone refusal message.

    A wiki section row has an id of the form `<page path>#NN-<slug>` (see the
    connector's `external_id=f"{external_id}#{index:02d}-{_slugify(heading)}"`).
    An absent id is a **moved section** when it has a `#` AND the page part is
    still in this fetch (`present_ids`) -- the page lives, only its section id
    changed, so absence is a rename, not a deletion. Everything else is **page
    absent**: a page row whose path is gone, or a section whose parent page is
    also gone.

    Returns a multi-line string with the one-line summary FIRST -- the agent host's
    health check truncates `last_error` to 200 chars, so the counts must lead --
    then up to `limit` sample page-absent paths (distinct, which is what tells
    an operator what to approve) and up to `limit` sample moved-section ids,
    each category capped with a `... and N more` line when truncated.
    """

    def page_of(external_id: str) -> str:
        return external_id.split("#", 1)[0]

    moved: list[str] = []
    page_absent: list[str] = []
    for external_id in absent_ids:
        if "#" in external_id and page_of(external_id) in present_ids:
            moved.append(external_id)
        else:
            page_absent.append(external_id)

    # Distinct page paths among the page-absent ids -- a page and its sections
    # collapse to one path, since that is the unit an operator approves.
    absent_pages: list[str] = []
    seen_pages: set[str] = set()
    for external_id in page_absent:
        page = page_of(external_id)
        if page not in seen_pages:
            seen_pages.add(page)
            absent_pages.append(page)

    # Breakdown by first path segment of the page part, top 10 by count.
    counts: dict[str, int] = {}
    for external_id in absent_ids:
        segment = page_of(external_id).split("/", 1)[0]
        counts[segment] = counts.get(segment, 0) + 1
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:10]
    by_dir = ", ".join(f"{segment}/: {count}" for segment, count in top)

    lines = [
        f"absent={len(absent_ids)} moved_sections={len(moved)} "
        f"page_absent={len(page_absent)} ({len(absent_pages)} distinct pages) "
        f"by_dir: {by_dir}"
    ]

    def _samples(label: str, items: list[str]) -> None:
        for item in items[:limit]:
            lines.append(f"{label}: {item}")
        extra = len(items) - limit
        if extra > 0:
            lines.append(f"... and {extra} more {label} id(s)")

    _samples("page absent", absent_pages)
    _samples("moved section", moved)
    return "\n".join(lines)


def split_superseded(
    absent_ids: Sequence[str],
    existing: dict[str, dict],
    seen: set[str],
) -> tuple[list[str], list[str]]:
    """Partition absent ids into (superseded, guarded) for the tombstone guard.

    A wiki section row stores its page's id in `parent_external_id` (set by the
    connector's `parent_external_id=external_id`). Section ids are index-prefixed
    (`<page>#NN-<slug>`), so adding or removing a `##` heading renumbers every
    section below it: the old section ids go absent while the page -- and a fresh
    set of section ids -- is re-emitted in the same run. That is a rename, not a
    deletion, and must not count toward the bulk-tombstone guard.

    An absent id is **superseded** when its stored `parent_external_id` is not
    None AND that parent id is in `seen` (the ids this fetch emitted) -- the page
    lives, only its sections were renumbered. Everything else is **guarded**: a
    page row, or a section whose parent page is itself gone. Uses the stored
    column only; it never parses `#` out of an id. Order is preserved from
    `absent_ids`.
    """
    superseded: list[str] = []
    guarded: list[str] = []
    for external_id in absent_ids:
        parent = (existing.get(external_id) or {}).get("parent_external_id")
        if parent is not None and parent in seen:
            superseded.append(external_id)
        else:
            guarded.append(external_id)
    return superseded, guarded


def upsert(
    documents: Iterable[Document],
    *,
    source: str,
    sb=None,
    full_sync: bool = True,
    dry_run: bool = False,
    verify_domains: bool = True,
    allow_bulk_tombstone: bool = False,
    confirmed_absent: Iterable[str] = (),
) -> IngestResult:
    """Upsert documents for one source.

    Args:
        documents: what the connector emitted. All must share `source`.
        source: the connector's source label, used to scope the sync.
        sb: an existing Supabase client, or None to build one.
        full_sync: tombstone external_ids absent from `documents`. Set False for
            incremental runs that carry only a subset.
        dry_run: report what would change without writing or embedding.
        verify_domains: assert the local taxonomy matches workspace.domains.
        allow_bulk_tombstone: required to proceed when a `full_sync` run would
            tombstone more than BULK_TOMBSTONE_THRESHOLD of that source's live
            rows. A connector that defaults to a narrower scope than the corpus
            it is syncing against (e.g. `include_sensitive=False` against a
            corpus indexed WITH sensitive rows) reads absence as deletion --
            this caught 87 live rows tombstoned by exactly that mismatch.
            Superseded section rows (an absent id whose stored
            `parent_external_id` is still in the fetch) do NOT count toward the
            threshold -- they are renumbered `##` sections of a living page, not
            a deletion -- so this flag is not needed to let them through.
        confirmed_absent: external_ids the connector has checked, one by one,
            are really gone at the source (for mail: the thread no longer
            carries a tag label). Like superseded sections they are tombstoned
            without counting toward the threshold: the guard exists for
            absence that might be a misread, and these were looked at. An id
            that is present in `documents` is never tombstoned, listed or not.
    """
    docs = list(documents)
    seen = _validate_batch(docs, source)

    sb = sb or get_supabase()
    if verify_domains:
        verify_taxonomy(sb)

    # Owners first: an owner who cannot be resolved stops the run before any
    # write. Asked only when a document names one (mail).
    try:
        owners = owner_ids(sb, docs)
    except OwnerError as error:
        raise IngestError(str(error)) from error

    existing = _fetch_existing(sb, source)

    to_write: list[Document] = []
    unchanged = 0
    inserted = 0
    updated = 0
    revived = 0
    # Changed content is no longer the content a human approved. Rows reset here
    # get review_status/reviewed_at/reviewed_by cleared when the row is written.
    reset_review_ids: set[str] = set()

    for doc in docs:
        prior = existing.get(doc.external_id)
        if prior is None:
            to_write.append(doc)
            inserted += 1
        elif prior["source_hash"] != doc.source_hash:
            to_write.append(doc)
            updated += 1
            if prior["review_status"] == "approved":
                reset_review_ids.add(doc.external_id)
        elif prior["deleted_at"] is not None:
            # Content is identical but the row is tombstoned -- revive it.
            # Checking deleted_at separately matters: matching content alone will
            # not unhide a soft-deleted row.
            to_write.append(doc)
            revived += 1
        else:
            unchanged += 1

    live_before = sum(1 for prior in existing.values() if prior["deleted_at"] is None)
    absent = sorted(
        external_id
        for external_id, prior in existing.items()
        if external_id not in seen and prior["deleted_at"] is None
    )
    tombstone_ids = absent if full_sync else []
    # Superseded section rows (parent page still in this fetch) are still
    # tombstoned, but are a rename, not a deletion -- only `guarded` ids count
    # toward the bulk-tombstone threshold.
    superseded, guarded = split_superseded(tombstone_ids, existing, seen)
    confirmed = frozenset(confirmed_absent)
    guarded = [external_id for external_id in guarded if external_id not in confirmed]

    if dry_run:
        return IngestResult(
            source=source,
            scanned=len(docs),
            inserted=inserted,
            updated=updated,
            unchanged=unchanged,
            tombstoned=len(tombstone_ids),
            revived=revived,
            embedded=0,
        )

    if (
        guarded
        and live_before
        and not allow_bulk_tombstone
        and (len(guarded) / live_before) > BULK_TOMBSTONE_THRESHOLD
    ):
        # Summary first (counts + per-dir), then the explanation, then samples:
        # the health check truncates last_error to 200 chars, so numbers lead.
        # Samples describe `guarded` -- the ids that actually block the run.
        # describe_absent uses a `#` heuristic for moved_sections; for
        # well-formed wiki data (parent_external_id always set) it produces
        # moved_sections=0 here because guarded rows have no parent in `seen`.
        summary, _, rest = describe_absent(guarded, seen).partition("\n")
        raise IngestError(
            f"Refusing to tombstone {len(guarded)}/{live_before} "
            f"({len(guarded) / live_before:.0%}) of source {source!r}'s live "
            f"rows -- above the {BULK_TOMBSTONE_THRESHOLD:.0%} threshold. "
            f"superseded={len(superseded)} {summary}\n"
            "This is either a genuine mass deletion (pass allow_bulk_tombstone=True "
            "to confirm) or the connector's scope is narrower than the corpus it is "
            "syncing against (e.g. a sensitive-content filter default that "
            "doesn't match how the corpus was last indexed) -- absence is being "
            "misread as deletion. Nothing was written."
            + (f"\n{rest}" if rest else "")
        )

    # Split the writes: only documents whose EMBEDDED TEXT changed need a vector.
    # A metadata-only change writes the row and leaves the stored embedding alone.
    needs_embedding = [
        doc
        for doc in to_write
        if (existing.get(doc.external_id) or {}).get("embed_hash") != doc.embed_hash
    ]
    # Membership by external_id, not by dataclass equality. `doc not in list`
    # compares every field of every document against every candidate -- O(n^2),
    # invisible at 857 rows and not at email volume.
    needs_embedding_ids = {doc.external_id for doc in needs_embedding}
    metadata_only = [doc for doc in to_write if doc.external_id not in needs_embedding_ids]

    embedded = 0
    if to_write:
        stamp = datetime.now(timezone.utc).isoformat()

        def _review_reset(external_id: str) -> dict:
            if external_id not in reset_review_ids:
                return {}
            return {"review_status": "unreviewed", "reviewed_at": None, "reviewed_by": None}

        if needs_embedding:
            vectors = _embed([doc.embed_text for doc in needs_embedding])
            embedded = len(vectors)
            embed_rows = [
                {
                    **doc.to_row(),
                    **owner_column(doc, owners),
                    "embedding": vector,
                    "deleted_at": None,
                    "indexed_at": stamp,
                    **_review_reset(doc.external_id),
                }
                for doc, vector in zip(needs_embedding, vectors)
            ]
            _upsert_rows(sb, embed_rows)

        # PATCH, not upsert -- see _patch_rows for why. These are existing rows
        # (metadata_only is only ever populated from `to_write` entries with a
        # `prior`), so no `embedding` key is safe to omit here.
        if metadata_only:
            patch_rows = [
                (
                    doc.external_id,
                    {
                        **doc.to_row(),
                        **owner_column(doc, owners),
                        "deleted_at": None,
                        "indexed_at": stamp,
                        **_review_reset(doc.external_id),
                    },
                )
                for doc in metadata_only
            ]
            _patch_rows(sb, source, patch_rows)

    tombstoned = _tombstone(sb, source, tombstone_ids)

    if to_write:
        _assert_no_null_embeddings(sb, source)

    result = IngestResult(
        source=source,
        scanned=len(docs),
        inserted=inserted,
        updated=updated,
        unchanged=unchanged,
        tombstoned=tombstoned,
        revived=revived,
        embedded=embedded,
    )

    # Stats only need rebuilding when the corpus actually moved.
    if result.wrote_anything:
        _refresh_stats(sb)

    return result
