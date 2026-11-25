"""Step 10 -- build a batch of the highest-priority unreviewed rows for review.

A "review batch" is a `workspace.review_batches` row (the envelope: who it was
sent to, a reply token) plus numbered `workspace.review_items` rows (one per
document). `review_apply.apply_pending()` reads the `decision` a reviewer
writes onto each item; this module only ever creates items with `decision`
still null.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .supabase_client import get_supabase
from .triage import priority_score
from .kb_schema import db

# Matched to `--max-candidates 40` on the `distil` step of
# tasks/workflows/knowledge-capture.yaml. `distil` writes at most this many
# new `metadata.distill` rows per run, ordered by the same priority as here,
# so at most this many new REVIEWABLE rows exist per run. Setting this
# higher than the distil cap re-creates the pool mismatch this fix exists to
# close: the queue would draw from unreviewed rows generally rather than
# from what was actually distilled, and drift back toward blanks. If either
# number changes, change both.
DEFAULT_BATCH_SIZE = 40
REPLY_TOKEN_BYTES = 8
PAGE_SIZE = 500


class NotReviewableError(RuntimeError):
    """A row without `metadata.distill` was about to be queued.

    Means the eligibility filter and what a reviewer actually sees have
    diverged -- exactly the defect this module was fixed for once already
    (2026-08-14: `distillation` column checked instead of `metadata.distill`,
    240 items queued, 160 blank). Raising here turns a repeat into a failed,
    visible run instead of a queue that silently fills with blanks again.
    """


def is_reviewable(row: dict) -> bool:
    """True when this row carries a real LLM-written WHAT/WHY/TERMS summary.

    NOT the same as `row["distillation"]` being non-null. Every connector
    writes a placeholder into that column at ingest time -- the wiki
    connector writes frontmatter summary plus heading outline, the drive
    connector writes `"Google Doc in <folder>. <first 400 chars>"` -- so
    that column is non-null for nearly every row regardless of whether an
    LLM ever looked at it. `metadata.distill` is written exclusively by
    `apply_distillations.py`, and only after a generation's terms pass
    verbatim-source verification. That is the actual "worth a human's time"
    signal.
    """
    return "distill" in (row.get("metadata") or {})


@dataclass(frozen=True, slots=True)
class BatchItem:
    item_number: int
    document_id: str
    title: str
    source: str
    tier: int
    domains: tuple[str, ...]
    what: str
    why: str
    terms: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Batch:
    id: str
    reply_token: str
    items: tuple[BatchItem, ...] = field(default_factory=tuple)


def _generate_reply_token() -> str:
    return secrets.token_hex(REPLY_TOKEN_BYTES)


def _fetch_reviewable_rows(sb) -> list[dict]:
    """Every unreviewed row that actually carries a real summary.

    Filters on `metadata->'distill'` via jsonb containment (`cs`), NOT on the
    `distillation` column -- that column is populated by connectors at
    ingest time (a placeholder, not a summary) and is therefore non-null for
    nearly the entire corpus regardless of whether anything has been
    distilled. Confirmed against production 2026-08-14: the containment
    filter and an in-Python `is_reviewable()` check over the same unreviewed
    pool agreed exactly (160/1000).

    `is_reviewable()` is applied again after the fetch, defensively -- if a
    PostgREST client upgrade ever changes `cs` semantics, this still filters
    correctly rather than trusting the query silently.
    """
    rows: list[dict] = []
    offset = 0
    while True:
        resp = (
            db(sb)
            .table("documents")
            .select(
                "id, source, title, tier, domains, label_source, "
                "distillation, metadata, source_created_at"
            )
            .eq("review_status", "unreviewed")
            .is_("deleted_at", "null")
            .filter("metadata", "cs", '{"distill": {}}')
            .range(offset, offset + PAGE_SIZE - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return [row for row in rows if is_reviewable(row)]


def _already_queued_document_ids(sb) -> frozenset[str]:
    """Documents sitting in an open (undecided, unapplied) review item.

    Prevents the same document appearing in two batches at once -- a
    document only re-enters the pool once its open item is decided and
    applied, or its batch expires (Step 12, out of this task's scope).
    """
    resp = (
        db(sb)
        .table("review_items")
        .select("document_id")
        .is_("applied_at", "null")
        .execute()
    )
    return frozenset(row["document_id"] for row in (resp.data or []))


def _split_distillation(text: str) -> tuple[str, str, tuple[str, ...]]:
    """Split a rendered distillation back into (what, why, terms).

    `Distillation.render()` in distill.py is the inverse: `what`, then `why`,
    then an optional `Key terms: a, b, c` line. Best-effort -- this is
    display only, never re-parsed back into the database.
    """
    lines = [line for line in (text or "").splitlines() if line.strip()]
    what = lines[0] if lines else ""
    why = ""
    terms: tuple[str, ...] = ()
    for line in lines[1:]:
        if line.startswith("Key terms:"):
            terms = tuple(t.strip() for t in line[len("Key terms:") :].split(",") if t.strip())
        elif not why:
            why = line
    return what, why, terms


def build_batch(size: int = DEFAULT_BATCH_SIZE, *, sb=None) -> Batch:
    """Select the top-priority unreviewed rows and create a review batch.

    Creates one `workspace.review_batches` row and up to `size` numbered
    `workspace.review_items` rows, ordered by `triage.priority_score` --
    the same consequence-if-wrong ranking used to prioritise distillation.

    `sb`: an existing Supabase client, or None to build the service-role one.
    The default exists only for pre-cutover callers on a long-lived host
    (`workflows/build_review_batch.py`); it should be deleted once
    `tasks/workflows/knowledge-review.yaml` retires (plan Step 7).
    `pullers/runner.py` always passes its `kb_ingest`-scoped client.
    """
    sb = sb or get_supabase()

    rows = _fetch_reviewable_rows(sb)
    already_queued = _already_queued_document_ids(sb)
    candidates = [row for row in rows if row["id"] not in already_queued]
    candidates.sort(key=lambda row: -priority_score(row))
    selected = candidates[:size]

    # Belt-and-braces: `_fetch_reviewable_rows` should make this impossible,
    # but this is exactly the class of bug that shipped once already (a
    # correct-looking predicate that silently wasn't). A future regression
    # here fails the run loudly instead of queuing blanks for two days
    # before anyone notices.
    not_reviewable = [row["id"] for row in selected if not is_reviewable(row)]
    if not_reviewable:
        raise NotReviewableError(
            f"{len(not_reviewable)} selected row(s) lack metadata.distill and "
            f"would queue as blanks: {not_reviewable}"
        )

    reply_token = _generate_reply_token()
    batch_row = (
        db(sb)
        .table("review_batches")
        .insert(
            {
                "reply_token": reply_token,
                "channel": "cli",
                "recipient": "terminal",
                "item_count": len(selected),
            }
        )
        .execute()
    ).data[0]
    batch_id = batch_row["id"]

    items: list[BatchItem] = []
    if selected:
        item_rows = []
        for index, row in enumerate(selected, start=1):
            what, why, terms = _split_distillation(row.get("distillation") or "")
            item_rows.append(
                {
                    "batch_id": batch_id,
                    "item_number": index,
                    "document_id": row["id"],
                }
            )
            items.append(
                BatchItem(
                    item_number=index,
                    document_id=row["id"],
                    title=row.get("title") or "",
                    source=row.get("source") or "",
                    tier=row.get("tier") or 4,
                    domains=tuple(row.get("domains") or ()),
                    what=what,
                    why=why,
                    terms=terms,
                )
            )
        db(sb).table("review_items").insert(item_rows).execute()

    return Batch(id=batch_id, reply_token=reply_token, items=tuple(items))


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", type=int, default=DEFAULT_BATCH_SIZE)
    args = parser.parse_args()

    batch = build_batch(args.size)
    print(f"batch {batch.id} (reply token {batch.reply_token}): {len(batch.items)} items")
    for item in batch.items:
        print(f"  {item.item_number:3d}  [{item.source}/tier{item.tier}] {item.title[:70]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
