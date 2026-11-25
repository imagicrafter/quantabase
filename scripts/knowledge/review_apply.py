"""Step 11 -- apply human review decisions from `workspace.review_items`.

Four verbs, none of them ever WIDENS `domains` on their own -- `relabel` sets
`domains` to exactly what the reviewer chose, which is a human decision, not a
generation; nothing here ever writes a model's `proposed_label` straight into
`domains` (see `labels.arbitrate`).

Idempotency: `applied_at` is set in the same `.update()` call as every other
field on a `review_items` row, so a row that already has `applied_at` is never
selected again -- replaying a batch (a duplicate email reply, a re-run after a
crash) is a no-op. The `distillation_rejections` insert this may also perform
is naturally idempotent too: its primary key is `(source, external_id,
content_hash)`, so a repeat insert for the same content just conflicts and is
ignored rather than erroring the run.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .contract import embed_hash_for, embed_text_for
from .distill import content_hash
from .embedder import embed_texts
from .supabase_client import get_supabase
from .kb_schema import db

VALID_DECISIONS = frozenset({"approve", "regenerate", "exclude", "relabel"})


@dataclass(frozen=True, slots=True)
class AppliedItem:
    batch_id: str
    item_number: int
    document_id: str
    decision: str


@dataclass(frozen=True, slots=True)
class SkippedItem:
    batch_id: str
    item_number: int
    document_id: str
    decision: str | None
    reason: str


@dataclass(slots=True)
class ApplyResult:
    applied: list[AppliedItem] = field(default_factory=list)
    skipped: list[SkippedItem] = field(default_factory=list)
    re_embedded: int = 0

    def counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for item in self.applied:
            counts[item.decision] = counts.get(item.decision, 0) + 1
        return counts


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_note(note: str | None) -> dict[str, Any]:
    """`note` carries the reviewer's structured extras.

    `review_items` has no dedicated column for "which domain did the reviewer
    pick" or "did they edit the distillation text" -- migration 0009 does not
    have one and this task may not add a migration. `note` is reused as a
    small JSON envelope: `{"domain": "consulting"}` for a relabel, optionally
    `{"distillation": "..."}` if a reviewer edited the summary text. A bare
    string (e.g. a CLI that just writes the chosen domain name) is accepted
    as shorthand for `{"domain": note}`.
    """
    if not note:
        return {}
    try:
        parsed = json.loads(note)
    except (json.JSONDecodeError, TypeError):
        return {"domain": note.strip()}
    if isinstance(parsed, dict):
        return parsed
    return {"domain": str(parsed).strip()}


def _fetch_pending_items(sb) -> list[dict]:
    resp = (
        db(sb)
        .table("review_items")
        .select(
            "batch_id, item_number, document_id, decision, note, "
            "review_batches(recipient)"
        )
        .not_.is_("decision", "null")
        .is_("applied_at", "null")
        .execute()
    )
    return resp.data or []


def _fetch_documents(sb, document_ids: list[str]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    unique_ids = sorted(set(document_ids))
    for start in range(0, len(unique_ids), 100):
        chunk = unique_ids[start : start + 100]
        resp = (
            db(sb)
            .table("documents")
            .select(
                "id, source, external_id, title, body, distillation, "
                "domains, metadata"
            )
            .in_("id", chunk)
            .execute()
        )
        for row in resp.data or []:
            found[row["id"]] = row
    return found


def _mark_applied(sb, item: dict, decision: str) -> None:
    """Stamp `review_items.applied_at` alongside the decision it applied to."""
    (
        db(sb)
        .table("review_items")
        .update({"applied_at": _now_iso()})
        .eq("batch_id", item["batch_id"])
        .eq("item_number", item["item_number"])
        .execute()
    )


def _insert_rejection(sb, *, source: str, external_id: str, doc_hash: str, action: str) -> None:
    try:
        (
            db(sb)
            .table("distillation_rejections")
            .insert(
                {
                    "source": source,
                    "external_id": external_id,
                    "content_hash": doc_hash,
                    "action": action,
                }
            )
            .execute()
        )
    except Exception as error:
        # Primary key (source, external_id, content_hash) already present --
        # this exact content was already recorded under this verb. That is a
        # replay, not a failure.
        if "duplicate" not in str(error).lower() and "23505" not in str(error):
            raise


def _maybe_reembed(
    sb, document_id: str, title: str, current_distillation: str | None, extras: dict
) -> str | None:
    """Re-embed and return the new distillation text, or None if unchanged."""
    new_text = extras.get("distillation")
    if not isinstance(new_text, str) or not new_text.strip():
        return None
    new_text = new_text.strip()
    if new_text == (current_distillation or "").strip():
        return None

    current = (
        db(sb)
        .table("documents")
        .select("metadata")
        .eq("id", document_id)
        .single()
        .execute()
    ).data
    metadata = {**(current.get("metadata") or {}), "_embed_hash": embed_hash_for(title, new_text)}

    vector = embed_texts([embed_text_for(title, new_text)])[0]
    (
        db(sb)
        .table("documents")
        .update(
            {
                "distillation": new_text,
                "embedding": vector,
                "metadata": metadata,
            }
        )
        .eq("id", document_id)
        .execute()
    )
    return new_text


def apply_pending(*, sb=None) -> ApplyResult:
    """Apply every decided-but-unapplied `review_items` row.

    Reads `workspace.review_items` where `decision IS NOT NULL AND
    applied_at IS NULL`, applies the verb to `workspace.documents` (and to
    `workspace.distillation_rejections` for `regenerate` / `exclude`), then
    stamps `applied_at`.

    `sb`: an existing Supabase client, or None to build the service-role one.
    The default exists only for pre-cutover callers on a long-lived host
    (`workflows/apply_review_decisions.py`); it should be deleted once
    `tasks/workflows/knowledge-review.yaml` retires (plan Step 7).
    `pullers/runner.py` always passes its `kb_ingest`-scoped client.
    """
    sb = sb or get_supabase()
    result = ApplyResult()

    pending = _fetch_pending_items(sb)
    if not pending:
        return result

    documents = _fetch_documents(sb, [item["document_id"] for item in pending])

    for item in pending:
        batch_id = item["batch_id"]
        item_number = item["item_number"]
        document_id = item["document_id"]
        decision = item.get("decision")

        if decision not in VALID_DECISIONS:
            result.skipped.append(
                SkippedItem(batch_id, item_number, document_id, decision, "unknown decision verb")
            )
            continue

        doc = documents.get(document_id)
        if doc is None:
            result.skipped.append(
                SkippedItem(batch_id, item_number, document_id, decision, "document not found")
            )
            continue

        extras = _parse_note(item.get("note"))
        title = doc.get("title") or ""
        body = doc.get("body") or ""
        current_hash = content_hash(title, body)

        try:
            if decision == "approve":
                recipient = ((item.get("review_batches") or {}).get("recipient")) or None
                (
                    db(sb)
                    .table("documents")
                    .update(
                        {
                            "review_status": "approved",
                            "reviewed_at": _now_iso(),
                            "reviewed_by": recipient,
                        }
                    )
                    .eq("id", document_id)
                    .execute()
                )
                if _maybe_reembed(sb, document_id, title, doc.get("distillation"), extras):
                    result.re_embedded += 1

            elif decision == "relabel":
                domain = extras.get("domain")
                if not domain:
                    result.skipped.append(
                        SkippedItem(
                            batch_id, item_number, document_id, decision,
                            "relabel decision carries no domain in `note`",
                        )
                    )
                    continue
                recipient = ((item.get("review_batches") or {}).get("recipient")) or None
                (
                    db(sb)
                    .table("documents")
                    .update(
                        {
                            "domains": [domain],
                            "label_source": "human_confirmed",
                            "review_status": "approved",
                            "reviewed_at": _now_iso(),
                            "reviewed_by": recipient,
                        }
                    )
                    .eq("id", document_id)
                    .execute()
                )
                if _maybe_reembed(sb, document_id, title, doc.get("distillation"), extras):
                    result.re_embedded += 1

            elif decision == "regenerate":
                metadata = dict(doc.get("metadata") or {})
                metadata.pop("distill", None)
                (
                    db(sb)
                    .table("documents")
                    .update({"review_status": "unreviewed", "metadata": metadata})
                    .eq("id", document_id)
                    .execute()
                )
                _insert_rejection(
                    sb,
                    source=doc["source"],
                    external_id=doc["external_id"],
                    doc_hash=current_hash,
                    action="regenerate",
                )

            elif decision == "exclude":
                (
                    db(sb)
                    .table("documents")
                    .update({"review_status": "excluded"})
                    .eq("id", document_id)
                    .execute()
                )
                _insert_rejection(
                    sb,
                    source=doc["source"],
                    external_id=doc["external_id"],
                    doc_hash=current_hash,
                    action="exclude",
                )

        except Exception as error:
            result.skipped.append(
                SkippedItem(batch_id, item_number, document_id, decision, f"write failed: {error}")
            )
            continue

        _mark_applied(sb, item, decision)
        result.applied.append(AppliedItem(batch_id, item_number, document_id, decision))

    return result


def main() -> int:
    result = apply_pending()
    counts = result.counts()
    print(f"applied: {len(result.applied)} {counts}")
    print(f"re-embedded: {result.re_embedded}")
    print(f"skipped: {len(result.skipped)}")
    for item in result.skipped:
        print(f"  {item.batch_id}#{item.item_number} ({item.decision}): {item.reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
