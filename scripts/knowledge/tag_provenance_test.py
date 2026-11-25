"""A document carries how its topics were decided, and ingest stores it."""

from __future__ import annotations

import pytest

from knowledge import ingest
from knowledge.contract import Document, DocumentValidationError
from knowledge.tag_resolver import DomainAssignment, resolve


def _doc(**changes) -> Document:
    fields = {
        "source": "wiki",
        "external_id": "concepts/a.md",
        "title": "A",
        "body": "body of a",
        "domains": ("consulting",),
    }
    return Document(**{**fields, **changes})


def test_a_row_carries_the_tag_source_and_signals():
    row = _doc(tag_source="content", tag_signals=("consulting",)).to_row()
    assert row["tag_source"] == "content"
    assert row["tag_signals"] == ["consulting"]


def test_a_document_without_provenance_writes_nulls_and_keeps_its_old_hash():
    plain = _doc()
    row = plain.to_row()
    assert row["tag_source"] is None and row["tag_signals"] is None
    # Every row has the same keys, so a batch never mixes column sets.
    assert set(row) == set(_doc(tag_source="default").to_row())


def test_a_change_in_provenance_changes_the_row_hash():
    by_content = _doc(tag_source="content", tag_signals=("consulting",))
    by_folder = _doc(tag_source="container", tag_signals=("consulting",))
    other_signal = _doc(tag_source="content", tag_signals=("unknown_tag", "unknown_tag:x"))
    assert len({by_content.source_hash, by_folder.source_hash, other_signal.source_hash}) == 3
    assert by_content.source_hash == _doc(tag_source="content", tag_signals=("consulting",)).source_hash
    # Provenance is not embedded text: no re-embedding when only it changes.
    assert by_content.embed_hash == by_folder.embed_hash


@pytest.mark.parametrize(
    "changes",
    [
        {"tag_source": "keywords"},
        {"tag_source": 3},
        {"tag_source": "content", "tag_signals": ["consulting"]},
        {"tag_source": "content", "tag_signals": ("ok", 5)},
    ],
)
def test_bad_provenance_is_refused(changes):
    with pytest.raises(DocumentValidationError):
        _doc(**changes)


def test_with_assignment_copies_the_resolvers_answer(example_config):
    assignment = resolve("wiki", ["properties"], (), example_config)
    tagged = _doc().with_assignment(assignment)
    assert tagged.domains == ("properties",)
    assert (tagged.tag_source, tagged.tag_signals) == ("content", ("properties",))
    assert _doc().domains == ("consulting",)  # the original is untouched

    unknown = _doc().with_assignment(
        DomainAssignment(("unclassified",), "content", ("unknown_tag", "unknown_tag:x"))
    )
    assert unknown.to_row()["tag_signals"] == ["unknown_tag", "unknown_tag:x"]


def test_ingest_writes_both_columns(monkeypatch):
    written: list[dict] = []
    monkeypatch.setattr(ingest, "_fetch_existing", lambda sb, source: {})
    monkeypatch.setattr(ingest, "_embed", lambda texts: [[0.0] for _ in texts])
    monkeypatch.setattr(ingest, "_upsert_rows", lambda sb, rows: written.extend(rows))
    monkeypatch.setattr(ingest, "_tombstone", lambda sb, source, ids: 0)
    monkeypatch.setattr(ingest, "_assert_no_null_embeddings", lambda sb, source: None)
    monkeypatch.setattr(ingest, "_refresh_stats", lambda sb: None)

    docs = [
        _doc(tag_source="container", tag_signals=("consulting",)),
        _doc(external_id="concepts/b.md", domains=("unclassified",), tag_source="default"),
    ]
    ingest.upsert(docs, source="wiki", sb=object(), verify_domains=False)

    by_id = {row["external_id"]: row for row in written}
    assert by_id["concepts/a.md"]["tag_source"] == "container"
    assert by_id["concepts/a.md"]["tag_signals"] == ["consulting"]
    assert by_id["concepts/b.md"]["tag_source"] == "default"
    assert by_id["concepts/b.md"]["tag_signals"] == []
