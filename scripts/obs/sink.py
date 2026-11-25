"""Where events land: `workspace.events`, written as the `kb_ingest` role."""

from __future__ import annotations
from knowledge.kb_schema import db


class SupabaseSink:
    """Insert one event row. The client is built lazily and reused."""

    def __init__(self, client=None) -> None:
        self._client = client

    def write(self, row: dict) -> None:
        if self._client is None:
            from knowledge.supabase_client import get_supabase_ingest

            self._client = get_supabase_ingest()
        db(self._client).table("events").insert(row).execute()
