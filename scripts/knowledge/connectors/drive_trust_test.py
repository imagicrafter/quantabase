"""Drive: whose tags count, which kinds of file are indexed, and the body read."""

from __future__ import annotations

import dataclasses

import pytest

from knowledge import engine_config
from knowledge.config import (
    DRIVE_INDEXED_MIMES,
    DRIVE_MIME_DOC,
    DRIVE_MIME_FOLDER,
    DRIVE_MIME_SHEET,
)
from knowledge.connectors import drive, drive_topics
from knowledge.tag_resolver import IGNORED_FOREIGN_TAG

ROOT = "MY-DRIVE-ROOT"


def _with_drive(config, **changes):
    updated = dataclasses.replace(config.sources.drive, **changes)
    return dataclasses.replace(config, sources=dataclasses.replace(config.sources, drive=updated))


def _folder(folder_id, parent=ROOT, description=None, **owner):
    return {"id": folder_id, "name": folder_id, "mimeType": DRIVE_MIME_FOLDER,
            "parents": [parent], "description": description, **owner}


def _file(file_id, parent=ROOT, description=None, mime=DRIVE_MIME_DOC, **owner):
    return {"id": file_id, "name": file_id, "mimeType": mime, "parents": [parent],
            "description": description, "modifiedTime": "2026-01-01T00:00:00Z", **owner}


ITEMS = [
    _folder("mine", description="kx/consulting", ownedByMe=True),
    _folder("theirs", description="kx/properties", ownedByMe=False),
    _folder("unknown-owner", description="kx/properties"),
    _file("my-tag", description="kx/private", ownedByMe=True),
    _file("their-tag", description="kx/private", ownedByMe=False),
    _file("no-owner-field", description="kx/private"),
    _file("their-untagged", ownedByMe=False),
    _file("in-mine", "mine", ownedByMe=False),
    _file("in-theirs", "theirs", ownedByMe=True),
    _file("in-unknown", "unknown-owner", ownedByMe=True),
    _file("their-tag-in-mine", "mine", "kx/private", ownedByMe=False),
    _file("a-sheet", mime=DRIVE_MIME_SHEET, ownedByMe=True),
    _file("a-pdf", mime="application/pdf", ownedByMe=True),
    _file("a-picture", mime="image/png", ownedByMe=True),
]


@pytest.fixture
def collect(monkeypatch):
    monkeypatch.setattr(drive, "_drive_service", lambda: object())
    monkeypatch.setattr(drive, "_list_all", lambda service: [dict(item) for item in ITEMS])
    monkeypatch.setattr(drive, "_root_ids", lambda service: frozenset({ROOT}))

    def run(**kwargs):
        documents, _ = drive.collect(include_sensitive=True, fetch_bodies=False, **kwargs)
        return {d.external_id: d for d in documents}

    return run


def test_the_listing_asks_who_owns_each_item():
    assert "ownedByMe" in drive.FILE_FIELDS


def test_owner_is_the_default_and_the_owners_own_tags_count(collect, example_config):
    assert example_config.sources.drive.trust_tags_from == "owner"
    docs = collect()
    assert (docs["my-tag"].domains, docs["my-tag"].tag_source) == (("private",), "content")
    assert docs["in-mine"].domains == ("consulting",), "the folder is the owner's"
    assert IGNORED_FOREIGN_TAG not in docs["my-tag"].tag_signals
    assert IGNORED_FOREIGN_TAG not in docs["in-mine"].tag_signals


def test_a_tag_on_someone_elses_file_is_ignored_and_recorded(collect):
    docs = collect()
    for file_id in ("their-tag", "no-owner-field"):
        assert docs[file_id].domains == ("unclassified",), file_id
        assert docs[file_id].tag_source == "default"
        assert docs[file_id].tag_signals == (IGNORED_FOREIGN_TAG,)
    assert docs["their-untagged"].tag_signals == (), "nothing was ignored"


def test_a_tag_on_someone_elses_folder_is_ignored_for_files_under_it(collect):
    docs = collect()
    for file_id in ("in-theirs", "in-unknown"):
        assert docs[file_id].domains == ("unclassified",), file_id
        assert docs[file_id].tag_signals == (IGNORED_FOREIGN_TAG,)


def test_an_ignored_file_tag_falls_to_the_owners_folder_tag(collect):
    doc = collect()["their-tag-in-mine"]
    assert (doc.domains, doc.tag_source) == (("consulting",), "container")
    assert doc.tag_signals == ("consulting", IGNORED_FOREIGN_TAG)


def test_an_ignored_tag_is_treated_as_no_tag_so_the_default_applies(collect, example_config):
    engine_config.set_config_for_tests(_with_drive(example_config, default_domain="consulting"))
    doc = collect()["their-tag"]
    assert (doc.domains, doc.tag_source) == (("consulting",), "source_default")
    assert doc.tag_signals == (IGNORED_FOREIGN_TAG,)


def test_anyone_trusts_every_tag_and_records_nothing(collect, example_config):
    engine_config.set_config_for_tests(_with_drive(example_config, trust_tags_from="anyone"))
    docs = collect()
    assert docs["their-tag"].domains == ("private",)
    assert docs["no-owner-field"].domains == ("private",)
    assert docs["in-theirs"].domains == ("properties",)
    assert all(IGNORED_FOREIGN_TAG not in d.tag_signals for d in docs.values())


def test_an_unexpected_trust_value_is_treated_as_owner(example_config):
    config = _with_drive(example_config, trust_tags_from="everyone")
    _views, ignored = drive_topics.apply_tag_trust(ITEMS, config)
    assert "their-tag" in ignored and "theirs" in ignored and "my-tag" not in ignored


def test_tag_trust_never_changes_the_listing_it_was_given(example_config):
    before = [dict(item) for item in ITEMS]
    views, _ = drive_topics.apply_tag_trust(ITEMS, example_config)
    assert ITEMS == before
    assert next(v for v in views if v["id"] == "their-tag")["description"] is None


# --- which kinds of file -------------------------------------------------------


def test_the_default_kinds_are_docs_sheets_and_slides(collect, example_config):
    assert drive.wanted_mimes(example_config) == DRIVE_INDEXED_MIMES
    docs = collect()
    assert "a-sheet" in docs and "my-tag" in docs
    assert "a-pdf" not in docs and "a-picture" not in docs


def test_include_mime_from_the_config_selects_the_kinds(collect, example_config):
    engine_config.set_config_for_tests(_with_drive(example_config, include_mime=("docs", "pdf")))
    docs = collect()
    assert "a-pdf" in docs and "my-tag" in docs
    assert "a-sheet" not in docs and "a-picture" not in docs
    assert docs["a-pdf"].body.splitlines()[1] == "Type: PDF"


def test_an_explicit_list_wins_and_an_empty_config_list_means_the_default(example_config):
    assert drive.wanted_mimes(example_config, ["image/png"]) == ("image/png",)
    empty = _with_drive(example_config, include_mime=())
    assert drive.wanted_mimes(empty) == DRIVE_INDEXED_MIMES


# --- the body -------------------------------------------------------------------


class _Service:
    def __init__(self, payload=None, error=None):
        self.payload, self.error = payload, error

    def files(self):
        return self

    def export(self, **_kwargs):
        return self

    def execute(self):
        if self.error:
            raise self.error
        return self.payload


def test_a_doc_body_is_read_through_the_drive_export():
    assert drive._fetch_body(_Service(b"Hello there"), "f") == "Hello there"


def test_an_unreadable_doc_gives_an_empty_body_not_a_failed_run():
    assert drive._fetch_body(_Service(error=RuntimeError("403")), "f") == ""


def test_a_missing_sign_in_is_a_connector_error_that_names_the_setting(monkeypatch):
    monkeypatch.setattr(drive.drive_client, "read_settings", lambda: {})
    with pytest.raises(drive.DriveConnectorError, match="DRIVE_TOKEN_JSON_B64"):
        drive._drive_service()
