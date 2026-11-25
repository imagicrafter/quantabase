#!/usr/bin/env python3
"""A failed wiki write-back must never clear a stored `wiki_page_id`.

    python -m pullers.fireflies_keep_page_id_test

Fake Supabase + patched write-back -- never touches Fireflies or the knowledge
repo. A re-index rebuilds every document with `wiki_page_id = None`; when the
write-back fails, `before_upsert` must carry over the value already stored on
the row so `ingest.upsert` does not overwrite a recorded link with None.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
from unittest import mock

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers import fireflies, knowledge_repo, meeting_writeback  # noqa: E402

RAW = {
    "id": "ff1",
    "title": "Client Imports Checkpoint",
    "date": "2026-10-15T15:00:00Z",
    "duration": 30,
    "sentences": [{"text": "hi", "speaker_name": "A", "start_time": 0}],
    "summary": {},
}
STORED_PAGE = "meetings/2026-10-15-client-imports-checkpoint.md"


class _Query:
    def __init__(self, store):
        self.store, self.filters, self.in_values, self.payload = store, {}, None, None

    def select(self, *_a): return self
    def eq(self, k, v): self.filters[k] = v; return self
    def is_(self, *_a): return self
    def gte(self, *_a): return self
    def limit(self, *_a): return self
    def in_(self, key, values): self.in_values = (key, list(values)); return self
    def update(self, payload): self.payload = payload; return self

    def execute(self):
        if self.store.raise_on_execute:
            raise RuntimeError("supabase down")

        class R:
            pass
        r = R()
        if self.payload is not None:
            self.store.updates.append((self.filters.get("external_id"), self.payload))
            r.data = []
            return r
        rows = self.store.rows
        for key, value in self.filters.items():
            rows = [row for row in rows if row.get(key) == value]
        if self.in_values is not None:
            key, values = self.in_values
            rows = [row for row in rows if row.get(key) in values]
        r.data = rows
        return r


class FakeSb:
    def __init__(self, rows, *, raise_on_execute=False):
        self.rows, self.updates, self.raise_on_execute = rows, [], raise_on_execute

    def schema(self, _s): return self
    def table(self, _name): return _Query(self)


def _stored_row(external_id, page_id):
    return {"source": "fireflies", "external_id": external_id,
            "metadata": {"fireflies_id": "ff1", "wiki_page_id": page_id}}


def _no_writeback():
    """resolve_root raises (no GITHUB_TOKEN); self_heal is a no-op."""
    return (
        mock.patch.object(
            knowledge_repo, "resolve_root",
            side_effect=knowledge_repo.KnowledgeRepoError("no token"),
        ),
        mock.patch.object(meeting_writeback, "self_heal_rows", return_value=[]),
    )


def test_failed_writeback_keeps_stored_link() -> None:
    doc = fireflies.to_document(RAW)
    assert doc.metadata["wiki_page_id"] is None
    sb = FakeSb([_stored_row(doc.external_id, STORED_PAGE)])
    resolve, heal = _no_writeback()
    with resolve, heal:
        documents, info = fireflies.before_upsert([RAW], [doc], sb)
    assert documents[0].metadata["wiki_page_id"] == STORED_PAGE
    assert info.get("wiki_error")


def test_no_stored_link_stays_none() -> None:
    doc = fireflies.to_document(RAW)
    sb = FakeSb([_stored_row(doc.external_id, None)])
    resolve, heal = _no_writeback()
    with resolve, heal:
        documents, _info = fireflies.before_upsert([RAW], [doc], sb)
    assert documents[0].metadata["wiki_page_id"] is None


def test_new_link_wins_over_stored() -> None:
    doc = fireflies.to_document(RAW)
    stamped = replace(doc, metadata={**doc.metadata, "wiki_page_id": "meetings/new.md"})
    sb = FakeSb([_stored_row(doc.external_id, "meetings/old.md")])
    result = fireflies.keep_stored_page_ids([stamped], sb)
    assert result[0].metadata["wiki_page_id"] == "meetings/new.md"


def test_lookup_error_does_not_raise() -> None:
    doc = fireflies.to_document(RAW)
    sb = FakeSb([_stored_row(doc.external_id, STORED_PAGE)], raise_on_execute=True)
    result = fireflies.keep_stored_page_ids([doc], sb)
    assert result == [doc]
    assert result[0].metadata["wiki_page_id"] is None


TESTS = [
    test_failed_writeback_keeps_stored_link,
    test_no_stored_link_stays_none,
    test_new_link_wins_over_stored,
    test_lookup_error_does_not_raise,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
