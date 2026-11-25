"""Each connector takes its topics from tags at the source, never from names."""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from knowledge import engine_config
from knowledge.config import DRIVE_MIME_DOC, DRIVE_MIME_FOLDER
from knowledge.connectors import drive, gmail, transcripts, wiki


def _with_source(config, source: str, **changes):
    updated = dataclasses.replace(getattr(config.sources, source), **changes)
    return dataclasses.replace(
        config, sources=dataclasses.replace(config.sources, **{source: updated})
    )


# --- wiki ---------------------------------------------------------------------


def _page(tmp_path: Path, frontmatter: str, name: str = "consulting-plan.md"):
    folder = tmp_path / "concepts"
    folder.mkdir(exist_ok=True)
    path = folder / name
    path.write_text(f"---\n{frontmatter}\n---\n\nSome text about consulting.\n", encoding="utf-8")
    documents, audit = wiki._page_to_documents(path, tmp_path)
    return documents[0], audit


def test_wiki_topics_come_from_the_frontmatter_key(tmp_path):
    doc, audit = _page(tmp_path, "title: Plan\ndomains: [properties, private]")
    assert doc.domains == ("private", "properties")
    assert (doc.tag_source, doc.tag_signals) == ("content", ("private", "properties"))
    assert doc.metadata["domain_match"] == "content"
    assert audit.matched_by == "content"


def test_wiki_ignores_free_form_tags_titles_and_file_names(tmp_path):
    doc, _ = _page(tmp_path, "title: Consulting plan\ntags: [consulting, properties]")
    assert doc.domains == ("unclassified",)
    assert (doc.tag_source, doc.tag_signals) == ("default", ())


def test_wiki_default_topic_and_unknown_tag(tmp_path, example_config):
    engine_config.set_config_for_tests(
        _with_source(example_config, "wiki", default_domain="consulting")
    )
    untagged, _ = _page(tmp_path, "title: Plan")
    assert (untagged.domains, untagged.tag_source) == (("consulting",), "source_default")

    mistyped, _ = _page(tmp_path, "title: Plan\ndomains: consluting")
    assert mistyped.domains == ("unclassified",)
    assert mistyped.tag_signals == ("unknown_tag", "unknown_tag:consluting")


def test_wiki_unreadable_tag_or_frontmatter_never_takes_the_default(tmp_path, example_config):
    engine_config.set_config_for_tests(
        _with_source(example_config, "wiki", default_domain="consulting")
    )
    garbled, _ = _page(tmp_path, "title: Plan\ndomains:\n  private: true")
    assert garbled.domains == ("unclassified",)
    assert garbled.tag_signals == ("unknown_tag", "unknown_tag:?unreadable")

    folder = tmp_path / "concepts"
    for name, text in (
        ("unclosed.md", "---\ndomains: [private]\n\nText that never closes the block.\n"),
        ("bom.md", "\ufeff---\ndomains: [private]\n---\n\nText.\n"),
    ):
        (folder / name).write_text(text, encoding="utf-8")
        documents, _audit = wiki._page_to_documents(folder / name, tmp_path)
        assert documents[0].domains == ("unclassified",), name
        assert "unknown_tag" in documents[0].tag_signals


def test_wiki_key_name_follows_the_config(tmp_path, example_config):
    tagging = dataclasses.replace(example_config.tagging, frontmatter_key="topics")
    engine_config.set_config_for_tests(dataclasses.replace(example_config, tagging=tagging))
    doc, _ = _page(tmp_path, "topics: [consulting]\ndomains: [properties]")
    assert doc.domains == ("consulting",)


def test_wiki_sections_carry_the_pages_tag(tmp_path):
    folder = tmp_path / "concepts"
    folder.mkdir()
    path = folder / "long.md"
    sections = "\n\n".join(f"## Part {n}\n\n" + ("word " * 1500) for n in range(3))
    path.write_text(f"---\ndomains: [private]\n---\n\n{sections}\n", encoding="utf-8")
    documents, _ = wiki._page_to_documents(path, tmp_path)
    assert len(documents) > 1
    assert {(d.domains, d.tag_source) for d in documents} == {(("private",), "content")}


# --- drive --------------------------------------------------------------------


def _folder(folder_id, name, parent=None, description=None, mine=True):
    return {
        "id": folder_id, "name": name, "mimeType": DRIVE_MIME_FOLDER,
        "parents": [parent] if parent else [], "description": description,
        "ownedByMe": mine,
    }


def _file(file_id, name, parent, description=None, mine=True):
    return {
        "id": file_id, "name": name, "mimeType": DRIVE_MIME_DOC,
        "parents": [parent] if parent else [], "description": description,
        "modifiedTime": "2026-01-01T00:00:00Z", "ownedByMe": mine,
    }


DRIVE_ITEMS = [
    _folder("root", "Work", description="All work kx/consulting"),
    _folder("mid", "Homes", "root", "kx/properties"),
    _folder("leaf", "2026", "mid"),
    _folder("typo", "Oops", "root", "kx/consluting"),
    _file("own", "consulting notes", "leaf", "Mine only. KX/Private"),
    _file("deep", "consulting notes", "leaf"),
    _file("top", "properties list", "root"),
    _file("bad", "plan", "typo"),
    _file("loose", "consulting properties private", None),
    _file("at-root", "plan", "MY-DRIVE-ROOT"),
    _file("gap", "plan", "not-listed"),
    _folder("under-gap", "Sub", "not-listed"),
    _file("deep-gap", "plan", "under-gap"),
    _folder("tagged-under-gap", "Sub", "not-listed", "kx/properties"),
    _file("tagged-gap", "plan", "tagged-under-gap"),
    {**_file("two-same", "plan", "mid"), "parents": ["mid", "leaf"]},
    {**_file("two-differ", "plan", "mid"), "parents": ["mid", "root"]},
]


@pytest.fixture
def drive_docs(monkeypatch):
    monkeypatch.setattr(drive, "_drive_service", lambda: object())
    monkeypatch.setattr(drive, "_list_all", lambda service: list(DRIVE_ITEMS))
    monkeypatch.setattr(drive, "_root_ids", lambda service: frozenset({"MY-DRIVE-ROOT"}))

    def collect():
        documents, audits = drive.collect(include_sensitive=True, fetch_bodies=False)
        return {d.external_id: d for d in documents}, {a.file_id: a for a in audits}

    return collect


def test_drive_asks_for_the_description_field():
    assert "description" in drive.FILE_FIELDS


def test_drive_file_tag_beats_folder_and_nearest_folder_wins(drive_docs):
    docs, audits = drive_docs()
    assert (docs["own"].domains, docs["own"].tag_source) == (("private",), "content")
    assert (docs["deep"].domains, docs["deep"].tag_source) == (("properties",), "container")
    assert (docs["top"].domains, docs["top"].tag_source) == (("consulting",), "container")
    assert audits["deep"].matched_by == "container"
    assert docs["deep"].metadata["domain_match"] == "container"


def test_drive_unknown_folder_tag_and_untagged_files_are_unclassified(drive_docs):
    docs, _ = drive_docs()
    assert docs["bad"].domains == ("unclassified",)
    assert docs["bad"].tag_signals == ("unknown_tag", "unknown_tag:consluting")
    # Names full of topic words are not tags.
    assert (docs["loose"].domains, docs["loose"].tag_source) == (("unclassified",), "default")


def test_drive_default_topic_applies_only_to_untagged_files(drive_docs, example_config):
    engine_config.set_config_for_tests(
        _with_source(example_config, "drive", default_domain="properties")
    )
    docs, _ = drive_docs()
    assert (docs["loose"].domains, docs["loose"].tag_source) == (("properties",), "source_default")
    assert docs["bad"].domains == ("unclassified",)
    assert docs["top"].domains == ("consulting",)


def test_drive_missing_folder_above_a_file_blocks_the_default(drive_docs, example_config):
    engine_config.set_config_for_tests(
        _with_source(example_config, "drive", default_domain="consulting")
    )
    docs, _ = drive_docs()
    # Directly in My Drive, or with no parent at all: the default applies.
    assert (docs["at-root"].domains, docs["at-root"].tag_source) == (("consulting",), "source_default")
    assert docs["loose"].domains == ("consulting",)
    # A folder above the file is not in the listing: it may be tagged, so no default.
    for file_id in ("gap", "deep-gap"):
        assert docs[file_id].domains == ("unclassified",), file_id
        assert docs[file_id].tag_signals == ("folder_chain_incomplete",)
    # A tag found below the gap is still the nearest tag.
    assert (docs["tagged-gap"].domains, docs["tagged-gap"].tag_source) == (("properties",), "container")


def test_drive_file_in_several_folders_needs_them_to_agree(drive_docs):
    docs, _ = drive_docs()
    assert docs["two-same"].domains == ("properties",)
    assert docs["two-differ"].domains == ("unclassified",)
    assert docs["two-differ"].tag_signals == ("ambiguous_folder",)


def test_drive_folder_cycle_is_never_a_complete_chain(example_config):
    config = _with_source(example_config, "drive", default_domain="consulting")
    looped = drive._folders_by_id([_folder("a", "A", "b"), _folder("b", "B", "a")])
    got = drive._assignment(_file("f", "plan", "a"), looped, frozenset(), config)
    assert got.domains == ("unclassified",) and got.signals == ("folder_chain_incomplete",)


def test_drive_root_lookup_failure_stops_the_run():
    class Broken:
        def files(self):
            raise ConnectionError("down")

    with pytest.raises(drive.DriveConnectorError, match="Drive root"):
        drive._root_ids(Broken())


def test_drive_ancestors_are_nearest_first_and_survive_a_cycle():
    folders = drive._folders_by_id(DRIVE_ITEMS)
    assert [f["id"] for f in drive._ancestors("leaf", folders)] == ["leaf", "mid", "root"]
    assert drive._ancestors(None, folders) == []
    assert drive._ancestors("missing", folders) == []
    looped = drive._folders_by_id([_folder("a", "A", "b"), _folder("b", "B", "a")])
    assert [f["id"] for f in drive._ancestors("a", looped)] == ["a", "b"]
    assert drive._folder_paths(DRIVE_ITEMS)["leaf"] == "Work/Homes/2026"


# --- transcripts (local files) -------------------------------------------------


def test_transcript_uses_the_meeting_pages_tag_when_the_page_exists(tmp_path, monkeypatch):
    monkeypatch.setattr(transcripts, "capture", lambda **_kwargs: None)
    monkeypatch.setattr(transcripts, "WORKSPACE_ROOT", tmp_path / "workspace")
    meetings = tmp_path / "knowledge" / "meetings"
    meetings.mkdir(parents=True)
    (meetings / "2026-01-05-consulting-sync.md").write_text(
        "---\ndomains: [properties]\n---\n\nNotes.\n", encoding="utf-8"
    )
    folder = tmp_path / "transcripts"
    folder.mkdir()
    tagged = folder / "2026-01-05-consulting-sync.md"
    tagged.write_text("# Transcript: Consulting sync\n\nhello\n", encoding="utf-8")
    untagged = folder / "2026-01-06-consulting-other.md"
    untagged.write_text("# Transcript: Consulting other\n\nhello\n", encoding="utf-8")

    doc, audit = transcripts._transcript_to_document(tagged)
    assert (doc.domains, doc.tag_source) == (("properties",), "content")
    assert audit.matched_by == "content"
    doc, _ = transcripts._transcript_to_document(untagged)
    assert (doc.domains, doc.tag_source) == (("unclassified",), "default")


# --- gmail --------------------------------------------------------------------
# The connector's own tests are in gmail_test.py. This one pins the shared rule:
# the label, not the words in the mail, decides the topic.


def test_gmail_topics_come_from_label_names_only(example_config):
    from knowledge.connectors.gmail_fake import message
    from knowledge.engine_config_gmail import Mailbox

    mailbox = Mailbox("owner@example.com", "owner@example.com")
    messages = [message("m1", ["L1"], subject="consulting properties private")]
    labelled = gmail.thread_to_document(
        "t1", messages, ["kx/properties"], example_config, mailbox, mailbox.owner_email)
    assert labelled.domains == ("properties",)
    assert (labelled.tag_source, labelled.tag_signals) == ("content", ("properties",))
    assert labelled.metadata["domain_match"] == "content"
