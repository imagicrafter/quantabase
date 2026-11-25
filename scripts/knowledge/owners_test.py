"""Who owns a document: the contract, the lookup, and what ingest writes."""

from __future__ import annotations

import dataclasses

import pytest

from knowledge import ingest, owners
from knowledge.contract import Document, DocumentValidationError


def _doc(external_id: str, owner: str | None = None, source: str = "gmail", **changes) -> Document:
    return Document(
        source=source, external_id=external_id, title=f"title {external_id}",
        body=f"body of {external_id}", domains=("consulting",), owner_email=owner, **changes,
    )


class _Rpc:
    def __init__(self, sb, name, args):
        self._sb, self._name, self._args = sb, name, args

    def execute(self):
        self._sb.calls.append((self._name, self._args))
        if self._sb.fail:
            raise RuntimeError("database is away")
        email = self._args["p_email"]
        return type("Resp", (), {"data": self._sb.people.get(email)})()


class _Sb:
    """Answers principal_id_for_email only. `schema()` returns itself."""

    def __init__(self, people=None, fail=False):
        self.people = people or {}
        self.fail = fail
        self.calls = []

    def schema(self, _name):
        return self

    def rpc(self, name, args):
        return _Rpc(self, name, args)


# --- the contract -------------------------------------------------------------


def test_a_document_has_no_owner_unless_given_one():
    assert _doc("a", source="wiki").owner_email is None
    assert "owner_principal_id" not in _doc("a", source="wiki").to_row()
    assert "owner_email" not in _doc("a", "pat@example.com").to_row()


def test_the_owner_is_stored_lower_cased_and_must_be_an_address():
    assert _doc("a", " Pat@Example.com ").owner_email == "pat@example.com"
    for bad in ("", "   ", "pat", 7):
        with pytest.raises(DocumentValidationError, match="owner_email"):
            _doc("a", bad)


def test_the_hash_moves_with_the_owner_and_only_then():
    plain = _doc("a", source="wiki")
    assert _doc("a", "pat@example.com").source_hash != _doc("a", "sam@example.com").source_hash
    assert _doc("a", "pat@example.com").source_hash != _doc("a").source_hash
    # A document with no owner keeps the hash it always had.
    assert plain.source_hash == dataclasses.replace(plain, owner_email=None).source_hash


# --- the lookup ---------------------------------------------------------------


def test_owner_ids_asks_once_per_address():
    sb = _Sb({"pat@example.com": "id-pat"})
    docs = [_doc("a", "pat@example.com"), _doc("b", "pat@example.com"), _doc("c", source="wiki")]
    assert owners.owner_ids(sb, docs) == {"pat@example.com": "id-pat"}
    assert sb.calls == [("principal_id_for_email", {"p_email": "pat@example.com"})]


def test_owner_ids_asks_nothing_when_no_document_has_an_owner():
    sb = _Sb()
    assert owners.owner_ids(sb, [_doc("a", source="wiki")]) == {}
    assert sb.calls == []


def test_an_owner_who_is_not_a_person_on_this_engine_stops_the_run():
    sb = _Sb({"pat@example.com": "id-pat"})
    with pytest.raises(owners.OwnerError, match="not an active person"):
        owners.owner_ids(sb, [_doc("a", "pat@example.com"), _doc("b", "ghost@example.com")])


def test_a_lookup_that_fails_stops_the_run_without_naming_the_address_as_unknown():
    with pytest.raises(owners.OwnerError, match="could not be looked up"):
        owners.owner_ids(_Sb(fail=True), [_doc("a", "pat@example.com")])


def test_owner_column_is_added_only_to_rows_that_have_an_owner():
    ids = {"pat@example.com": "id-pat"}
    assert owners.owner_column(_doc("a", "pat@example.com"), ids) == {"owner_principal_id": "id-pat"}
    assert owners.owner_column(_doc("a", source="wiki"), ids) == {}
    with pytest.raises(owners.OwnerError):
        owners.owner_column(_doc("a", "sam@example.com"), ids)


# --- ingest -------------------------------------------------------------------


def _run_upsert(monkeypatch, docs, existing, sb, **kwargs):
    """upsert() with the database helpers replaced; returns what it wrote."""
    written = {"rows": [], "patches": [], "tombstoned": []}
    monkeypatch.setattr(ingest, "_fetch_existing", lambda sb, source: existing)
    monkeypatch.setattr(ingest, "verify_taxonomy", lambda sb: None)
    monkeypatch.setattr(ingest, "_embed", lambda texts: [[0.0] for _ in texts])
    monkeypatch.setattr(ingest, "_upsert_rows", lambda sb, rows: written["rows"].extend(rows))
    monkeypatch.setattr(
        ingest, "_patch_rows", lambda sb, source, rows: written["patches"].extend(rows)
    )

    def tombstone(sb, source, ids):
        written["tombstoned"].extend(ids)
        return len(ids)

    monkeypatch.setattr(ingest, "_tombstone", tombstone)
    monkeypatch.setattr(ingest, "_assert_no_null_embeddings", lambda sb, source: None)
    monkeypatch.setattr(ingest, "_refresh_stats", lambda sb: None)
    result = ingest.upsert(docs, source=docs[0].source if docs else "gmail", sb=sb, **kwargs)
    return result, written


def _live(doc: Document | None = None) -> dict:
    return {
        "source_hash": doc.source_hash if doc else "stale",
        "deleted_at": None,
        "embed_hash": doc.embed_hash if doc else None,
        "review_status": "approved",
        "parent_external_id": None,
    }


def test_ingest_writes_the_owner_of_an_email_row(monkeypatch):
    sb = _Sb({"pat@example.com": "id-pat"})
    _, written = _run_upsert(monkeypatch, [_doc("t1", "pat@example.com")], {}, sb)
    assert [row["owner_principal_id"] for row in written["rows"]] == ["id-pat"]


def test_ingest_writes_the_owner_on_a_metadata_only_change_too(monkeypatch):
    sb = _Sb({"pat@example.com": "id-pat"})
    doc = _doc("t1", "pat@example.com")
    existing = {"t1": {**_live(doc), "source_hash": "older"}}
    _, written = _run_upsert(monkeypatch, [doc], existing, sb)
    assert written["rows"] == []
    assert written["patches"][0][1]["owner_principal_id"] == "id-pat"


def test_ingest_leaves_the_owner_column_alone_for_other_sources(monkeypatch):
    sb = _Sb()
    _, written = _run_upsert(monkeypatch, [_doc("a.md", source="wiki")], {}, sb)
    assert "owner_principal_id" not in written["rows"][0]
    assert sb.calls == []


def test_ingest_writes_nothing_when_the_owner_is_unknown(monkeypatch):
    sb = _Sb()
    with pytest.raises(ingest.IngestError, match="not an active person"):
        _run_upsert(monkeypatch, [_doc("t1", "ghost@example.com")], {"old": _live()}, sb)


# --- label removed: the tombstone guard ---------------------------------------


def _mailbox(count: int) -> tuple[list[Document], dict]:
    docs = [_doc(f"t{i}", "pat@example.com") for i in range(count)]
    return docs, {doc.external_id: _live(doc) for doc in docs}


def test_an_absent_thread_is_tombstoned_when_few_are_absent(monkeypatch):
    docs, existing = _mailbox(20)
    existing["gone"] = _live()
    result, written = _run_upsert(
        monkeypatch, docs, existing, _Sb({"pat@example.com": "id"}), full_sync=True
    )
    assert written["tombstoned"] == ["gone"] and result.tombstoned == 1


def test_many_absent_threads_are_refused_unless_confirmed(monkeypatch):
    docs, existing = _mailbox(4)
    existing.update({"gone1": _live(), "gone2": _live()})
    sb = _Sb({"pat@example.com": "id"})
    with pytest.raises(ingest.IngestError, match="Refusing to tombstone 2/6"):
        _run_upsert(monkeypatch, docs, existing, sb, full_sync=True)


def test_confirmed_removals_do_not_count_toward_the_guard(monkeypatch):
    docs, existing = _mailbox(4)
    existing.update({"gone1": _live(), "gone2": _live()})
    result, written = _run_upsert(
        monkeypatch, docs, existing, _Sb({"pat@example.com": "id"}),
        full_sync=True, confirmed_absent=frozenset({"gone1", "gone2"}),
    )
    assert sorted(written["tombstoned"]) == ["gone1", "gone2"] and result.tombstoned == 2


def test_only_the_unconfirmed_part_is_held_to_the_guard(monkeypatch):
    docs, existing = _mailbox(4)
    existing.update({"gone1": _live(), "gone2": _live(), "gone3": _live()})
    sb = _Sb({"pat@example.com": "id"})
    with pytest.raises(ingest.IngestError, match="Refusing to tombstone 2/7"):
        _run_upsert(monkeypatch, docs, existing, sb, full_sync=True,
                    confirmed_absent=frozenset({"gone1"}))


def test_a_confirmation_never_tombstones_a_thread_that_is_present(monkeypatch):
    docs, existing = _mailbox(3)
    _, written = _run_upsert(
        monkeypatch, docs, existing, _Sb({"pat@example.com": "id"}),
        full_sync=True, confirmed_absent=frozenset({"t0", "t1", "never-indexed"}),
    )
    assert written["tombstoned"] == []


def test_a_relabelled_thread_comes_back(monkeypatch):
    doc = _doc("t1", "pat@example.com")
    existing = {"t1": {**_live(doc), "deleted_at": "2026-11-01T00:00:00Z"}}
    result, written = _run_upsert(
        monkeypatch, [doc], existing, _Sb({"pat@example.com": "id"}), full_sync=True
    )
    assert result.revived == 1
    assert written["patches"][0][1]["deleted_at"] is None


# --- approval does not survive a change ---------------------------------------


def _written(written: dict) -> dict:
    """The one row a run wrote, whichever way it was written."""
    return written["rows"][0] if written["rows"] else written["patches"][0][1]


@pytest.mark.parametrize(
    "change",
    [
        {"domains": ("properties",)},                       # the label now names another topic
        {"body": "body of t1, with a new reply"},           # the thread grew
    ],
)
def test_an_approved_thread_goes_back_to_review_when_it_changes(monkeypatch, change):
    before = _doc("t1", "pat@example.com")
    after = dataclasses.replace(before, **change)
    existing = {"t1": _live(before)}
    _, written = _run_upsert(
        monkeypatch, [after], existing, _Sb({"pat@example.com": "id-pat", "sam@example.com": "s"})
    )
    row = _written(written)
    assert row["review_status"] == "unreviewed" and row["reviewed_by"] is None


def test_an_approved_thread_goes_back_to_review_when_its_owner_changes(monkeypatch):
    before = _doc("t1", "pat@example.com")
    after = _doc("t1", "sam@example.com")
    sb = _Sb({"pat@example.com": "id-pat", "sam@example.com": "id-sam"})
    _, written = _run_upsert(monkeypatch, [after], {"t1": _live(before)}, sb)
    row = _written(written)
    assert row["owner_principal_id"] == "id-sam" and row["review_status"] == "unreviewed"


def test_an_unchanged_approved_thread_is_left_alone(monkeypatch):
    doc = _doc("t1", "pat@example.com")
    result, written = _run_upsert(
        monkeypatch, [doc], {"t1": _live(doc)}, _Sb({"pat@example.com": "id-pat"})
    )
    assert result.unchanged == 1 and written == {"rows": [], "patches": [], "tombstoned": []}


# --- reading what is already stored -------------------------------------------


class _Pages:
    """A `documents` table that hands rows back a page at a time."""

    def __init__(self, rows):
        self.rows = sorted(rows, key=lambda row: row["external_id"])
        self.asked = []
        self._range = (0, len(self.rows))

    def schema(self, _name):
        return self

    def table(self, _name):
        return self

    def select(self, *_columns):
        return self

    def eq(self, *_filter):
        return self

    def order(self, column):
        assert column == "external_id"
        return self

    def range(self, start, end):
        self._range = (start, end)
        self.asked.append((start, end))
        return self

    def execute(self):
        start, end = self._range
        return type("Resp", (), {"data": self.rows[start : end + 1]})()


def test_existing_rows_are_read_past_one_page(monkeypatch):
    monkeypatch.setattr(ingest, "EXISTING_PAGE_SIZE", 3)
    rows = [
        {"external_id": f"t{i}", "source_hash": "h", "deleted_at": None, "metadata": {},
         "review_status": "approved", "parent_external_id": None}
        for i in range(7)
    ]
    table = _Pages(rows)
    existing = ingest._fetch_existing(table, "gmail")
    assert sorted(existing) == [f"t{i}" for i in range(7)]
    assert table.asked == [(0, 2), (3, 5), (6, 8)]
