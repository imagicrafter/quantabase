"""The puller contract.

A puller is the source-specific half of ingest, and nothing else. Locking,
cursors, content hashing, bronze capture, embedding, upsert, tombstoning,
triage, distillation and the review queue are shared and already written --
see `pullers/runner.py`. A new source should be ~150 lines: `fetch()` and
`to_document()`.
"""

from __future__ import annotations

from typing import Any, Iterable, Protocol

from knowledge.contract import Document


class SkipPayload(Exception):
    """`to_document()` raises this for a payload that holds nothing to store.

    Not an error: it tells the runner to drop this one raw payload and carry
    on (incremental sources only), so the cursor still advances past it. Any
    OTHER exception from `to_document()` is a bug and must fail the run. See
    `pullers/runner.py::build_documents`.
    """

    def __init__(self, external_id: str | None, reason: str):
        super().__init__(reason)
        self.external_id = external_id
        self.reason = reason


class Puller(Protocol):
    """SOURCE, fetch(), to_document(). That is the entire per-source surface."""

    SOURCE: str

    def fetch(self, cursor: dict, *, sb: Any = None) -> tuple[Iterable[Any], dict]:
        """Call the source API. Return raw payloads and the NEW cursor.

        Raw payloads go to bronze verbatim -- never summarise here. The
        returned cursor is not persisted by the puller; `runner.py` writes it
        only after every payload in the batch has been converted, synced, or
        skipped via `SkipPayload` (incremental sources only).

        `sb`: the `kb_ingest`-scoped Supabase client the runner is using for
        this run. Any DB touch a puller makes (bronze capture, its own cursor
        reads) must use this client, never the service-role default.
        """
        ...

    def to_document(self, raw: Any) -> Document:
        """Raw payload -> Document. Assign domains here.

        `Document.__post_init__` validates on construction, so an invalid
        document cannot reach the runner's bronze/ingest steps.

        May raise `SkipPayload` for a payload that holds nothing to store; the
        runner drops it and advances the cursor past it (incremental sources
        only). Any other exception is treated as a bug and fails the run.
        """
        ...
