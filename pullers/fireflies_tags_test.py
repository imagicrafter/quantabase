"""Fireflies topics: the channel tags a meeting; the wiki meeting page, once it
exists and carries the frontmatter key, wins."""

from __future__ import annotations

import dataclasses
from datetime import date
from pathlib import Path

import pytest

from knowledge import engine_config
from knowledge.frontmatter import parse as parse_frontmatter
from pullers import fireflies, fireflies_tags, meeting_writeback
from pullers.meeting_page import MeetingInput, render_meeting_page

# Captured at import, before the test-wide stub in conftest replaces it.
REAL_PAGE_ROOT = fireflies._page_root
MEETING_DATE = "2026-01-05T15:00:00Z"
EXTERNAL_ID = "2026-01-05-consulting-sync.md"


def _raw(**changes) -> dict:
    base = {
        "id": "FF01",
        "title": "Consulting sync",
        "date": MEETING_DATE,
        "duration": 30,
        "sentences": [{"speaker_name": "Pat", "text": "Hello", "start_time": 0}],
    }
    return {**base, **changes}


def _channels(*titles: str) -> list[dict]:
    return [{"id": str(i), "title": title} for i, title in enumerate(titles)]


def _with_fireflies(config, **changes):
    ff = dataclasses.replace(config.sources.fireflies, **changes)
    return dataclasses.replace(config, sources=dataclasses.replace(config.sources, fireflies=ff))


def _write_page(root: Path, name: str, frontmatter: str) -> Path:
    folder = root / "meetings"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text(f"---\n{frontmatter}\n---\n\n## Summary\n\nText.\n", encoding="utf-8")
    return path


# --- to_document ---------------------------------------------------------------


def test_a_prefixed_channel_tags_the_meeting():
    doc = fireflies.to_document(_raw(channels=_channels("KX/Properties")))
    assert doc.domains == ("properties",)
    assert (doc.tag_source, doc.tag_signals) == ("container", ("properties",))
    assert doc.metadata["domain_match"] == "container"


def test_a_mapped_channel_tags_the_meeting(example_config):
    engine_config.set_config_for_tests(
        _with_fireflies(example_config, channels={"Sales Calls": "consulting"})
    )
    doc = fireflies.to_document(_raw(channels=_channels("sales calls", "Random")))
    assert (doc.domains, doc.tag_source) == (("consulting",), "container")


def test_the_title_is_not_a_tag_and_a_missing_channel_field_is_fine(example_config):
    doc = fireflies.to_document(_raw())
    assert (doc.domains, doc.tag_source) == (("unclassified",), "default")

    engine_config.set_config_for_tests(
        _with_fireflies(example_config, default_domain="consulting")
    )
    doc = fireflies.to_document(_raw(channels=None))
    assert (doc.domains, doc.tag_source) == (("consulting",), "source_default")


def test_an_unknown_channel_tag_is_unclassified():
    doc = fireflies.to_document(_raw(channels=_channels("kx/marketing")))
    assert doc.domains == ("unclassified",)
    assert doc.tag_signals == ("unknown_tag", "unknown_tag:marketing")


def test_a_shared_meeting_never_takes_the_other_sides_channel():
    doc = fireflies.to_document(_raw(channels=_channels("kx/consulting"), _shared=True))
    assert (doc.domains, doc.tag_source) == (("unclassified",), "default")


def test_the_meeting_pages_tag_wins_over_the_channel():
    raw = _raw(channels=_channels("kx/consulting"), _page_frontmatter={"domains": ["private"]})
    doc = fireflies.to_document(raw)
    assert (doc.domains, doc.tag_source) == (("private",), "content")

    no_key = _raw(channels=_channels("kx/consulting"), _page_frontmatter={"tags": ["meeting"]})
    assert fireflies.to_document(no_key).tag_source == "container"


# --- finding the page -----------------------------------------------------------


def test_pages_are_found_by_name_or_by_fireflies_id(tmp_path):
    _write_page(tmp_path, EXTERNAL_ID, "domains: [properties]")
    _write_page(tmp_path, "2026-01-05-renamed.md", 'fireflies_id: "FF02"\ndomains: private')
    raws = [
        _raw(),
        _raw(id="FF02", title="Other call"),
        _raw(id="FF03", title="No page"),
    ]
    stamped = fireflies_tags.stamp_pages(raws, tmp_path, fireflies._raw_external_id)
    assert stamped[0]["_page_frontmatter"]["domains"] == ["properties"]
    assert stamped[1]["_page_frontmatter"]["domains"] == "private"
    assert stamped[2]["_page_frontmatter"] is None
    assert "_page_frontmatter" not in raws[0], "inputs are not changed"


def test_another_recordings_page_is_used_only_when_it_agrees(tmp_path):
    """Two different calls can share a title and a day. The second one's
    payload is suffixed, and the page named for the pair carries the FIRST
    one's id -- so it is not certainly the second one's page."""
    _write_page(tmp_path, EXTERNAL_ID, 'fireflies_id: "FF01"\ndomains: [consulting]')
    second = _raw(id="FF09", _external_id_suffix="1502")

    def topics(channels):
        (stamped,) = fireflies_tags.stamp_pages(
            [{**second, "channels": channels}], tmp_path, fireflies._raw_external_id
        )
        assert stamped["_page_frontmatter"] is None and stamped["_page_doubtful"]
        doc = fireflies.to_document(stamped)
        return doc.domains, doc.tag_source, doc.tag_signals

    # Its own channel says something else: neither answer is safe.
    assert topics(_channels("kx/private")) == (("unclassified",), "default", ("ambiguous_page",))
    assert topics(None) == (("unclassified",), "default", ("ambiguous_page",))
    # Its own channel agrees with the page: that topic, from its own channel.
    assert topics(_channels("kx/consulting")) == (("consulting",), "container", ("consulting",))


def test_a_first_recording_whose_page_names_another_id_is_doubtful_too(tmp_path):
    _write_page(tmp_path, EXTERNAL_ID, 'fireflies_id: "FF09"\ndomains: [consulting]')
    (stamped,) = fireflies_tags.stamp_pages(
        [_raw(channels=_channels("kx/private"))], tmp_path, fireflies._raw_external_id
    )
    assert fireflies.to_document(stamped).domains == ("unclassified",)


def test_a_doubtful_page_without_a_tag_changes_nothing(tmp_path):
    _write_page(tmp_path, EXTERNAL_ID, 'fireflies_id: "FF09"\ntags: [meeting]')
    (stamped,) = fireflies_tags.stamp_pages(
        [_raw(channels=_channels("kx/private"))], tmp_path, fireflies._raw_external_id
    )
    doc = fireflies.to_document(stamped)
    assert (doc.domains, doc.tag_source) == (("private",), "container")


def test_two_pages_claiming_one_recording_with_different_tags_is_unclassified(tmp_path):
    _write_page(tmp_path, "2026-01-05-one.md", 'fireflies_id: "FF01"\ndomains: [consulting]')
    _write_page(tmp_path, "2026-01-05-two.md", 'fireflies_id: "FF01"\ndomains: [private]')
    (stamped,) = fireflies_tags.stamp_pages([_raw()], tmp_path, fireflies._raw_external_id)
    doc = fireflies.to_document(stamped)
    assert (doc.domains, doc.tag_signals) == (("unclassified",), ("ambiguous_page",))


def test_a_page_whose_frontmatter_cannot_be_read_never_falls_back_to_the_channel(tmp_path):
    folder = tmp_path / "meetings"
    folder.mkdir()
    (folder / EXTERNAL_ID).write_text("---\ndomains: [private]\nnever closed\n", encoding="utf-8")
    (stamped,) = fireflies_tags.stamp_pages(
        [_raw(channels=_channels("kx/consulting"))], tmp_path, fireflies._raw_external_id
    )
    doc = fireflies.to_document(stamped)
    assert doc.domains == ("unclassified",) and "unknown_tag" in doc.tag_signals


def test_fetch_reads_page_tags_from_the_checkout(tmp_path, monkeypatch):
    _write_page(tmp_path, EXTERNAL_ID, "domains: [properties]")
    monkeypatch.setattr(fireflies, "_page_root", lambda: tmp_path)
    monkeypatch.setattr(fireflies, "_list_stubs", lambda from_date: [{"id": "FF01"}])
    monkeypatch.setattr(fireflies.time, "sleep", lambda _s: None)
    monkeypatch.setattr(
        fireflies, "_gql",
        lambda query, variables=None: {"transcript": _raw(channels=_channels("kx/consulting"))},
    )
    raws, _cursor = fireflies.fetch({"last_checked": "2026-01-04T00:00:00+00:00"})
    doc = fireflies.to_document(list(raws)[0])
    assert (doc.domains, doc.tag_source) == (("properties",), "content")


def test_fetch_fails_rather_than_guess_when_the_checkout_is_unavailable(monkeypatch):
    def unavailable():
        raise RuntimeError("git is down")

    monkeypatch.setattr(fireflies, "_page_root", unavailable)
    monkeypatch.setattr(fireflies, "_list_stubs", lambda from_date: [{"id": "FF01"}])
    monkeypatch.setattr(fireflies.time, "sleep", lambda _s: None)
    monkeypatch.setattr(fireflies, "_gql", lambda query, variables=None: {"transcript": _raw()})
    with pytest.raises(RuntimeError, match="git is down"):
        fireflies.fetch({"last_checked": "2026-01-04T00:00:00+00:00"})


def test_no_wiki_repo_means_no_page_lookup(example_config):
    wiki = dataclasses.replace(example_config.sources.wiki, enabled=False, repo=None)
    engine_config.set_config_for_tests(
        dataclasses.replace(
            example_config, sources=dataclasses.replace(example_config.sources, wiki=wiki)
        )
    )
    assert REAL_PAGE_ROOT() is None


# --- the channel field ----------------------------------------------------------


def test_the_transcript_query_asks_for_channels():
    assert "channels" in fireflies._TRANSCRIPT_QUERY
    assert "channels" not in fireflies._TRANSCRIPT_QUERY_NO_CHANNELS


def test_an_api_that_refuses_the_channel_field_is_asked_again_without_it(monkeypatch):
    asked: list[bool] = []

    def gql(query, variables=None):
        asked.append("channels" in query)
        if "channels" in query:
            raise fireflies.FirefliesConnectorError(
                'Fireflies API error: Cannot query field "channels" on type "Transcript"'
            )
        return {"transcript": _raw()}

    monkeypatch.setattr(fireflies, "_gql", gql)
    assert fireflies._fetch_transcript("FF01")["id"] == "FF01"
    assert fireflies._fetch_transcript("FF01")["id"] == "FF01"
    assert asked == [True, False, False], "the field is tried once per process"


def test_any_other_api_error_still_fails(monkeypatch):
    def gql(query, variables=None):
        raise fireflies.FirefliesConnectorError("Fireflies API error: rate limited")

    monkeypatch.setattr(fireflies, "_gql", gql)
    with pytest.raises(fireflies.FirefliesConnectorError, match="rate limited"):
        fireflies._fetch_transcript("FF01")


# --- the page carries the tag ----------------------------------------------------


def _input(**changes) -> MeetingInput:
    base = dict(
        fireflies_id="FF01", title="Consulting sync", date_str="2026-01-05",
        duration_minutes=30, external_id=EXTERNAL_ID, summary={"short_summary": "Talked."},
        transcript_lines=("**Pat** [00:00]: Hello",), speakers=("Pat",),
        attendee_emails=(), domain_tags=("consulting",), page_topics=("consulting",),
    )
    return MeetingInput(**{**base, **changes})


def _render(inp: MeetingInput, **kwargs) -> dict:
    page = render_meeting_page(
        inp, attendees=(), related=(), today=date(2026, 1, 6), **kwargs
    )
    return parse_frontmatter(page).frontmatter


def test_a_new_page_is_written_with_its_topics():
    assert _render(_input(), topics=("consulting",))["domains"] == ["consulting"]
    assert _render(_input(), topics=("consulting",), topics_key="areas")["areas"] == ["consulting"]
    assert "domains" not in _render(_input())


def test_only_a_real_tag_is_ever_written_into_a_page():
    def doc(**changes):
        return fireflies.to_document(_raw(**changes))

    assert fireflies_tags.writable_topics(doc(channels=_channels("kx/properties"))) == ("properties",)
    assert fireflies_tags.writable_topics(doc(_page_frontmatter={"domains": "private"})) == ("private",)
    assert fireflies_tags.writable_topics(doc()) == ()
    assert fireflies_tags.writable_topics(doc(channels=_channels("kx/nope"))) == ()


def test_a_source_default_is_not_frozen_into_a_page(example_config):
    engine_config.set_config_for_tests(
        _with_fireflies(example_config, default_domain="consulting")
    )
    doc = fireflies.to_document(_raw())
    assert doc.domains == ("consulting",)
    assert fireflies_tags.writable_topics(doc) == ()


def test_a_stored_row_never_supplies_a_pages_tag(tmp_path):
    row = {
        "external_id": EXTERNAL_ID, "title": "Consulting sync", "body": "",
        "metadata": {"fireflies_id": "FF01"}, "domains": ["consulting"],
        "tag_source": "container",
    }
    inp = MeetingInput.from_row(row)
    assert inp.domain_tags == ("consulting",) and inp.page_topics == ()
    index = meeting_writeback.build_index(tmp_path)
    page = meeting_writeback._render_one(inp, None, "create", index, date(2026, 1, 6), None)
    assert "domains" not in parse_frontmatter(page).frontmatter


def test_an_untagged_meeting_writes_no_key(tmp_path):
    assert fireflies_tags.page_topics(None, ("unclassified",), "domains") == ()
    assert fireflies_tags.page_topics(None, ("consulting", "private"), "domains") == (
        "consulting", "private",
    )


def test_a_tag_already_on_the_page_is_kept_when_the_page_is_rewritten(tmp_path):
    existing = "---\ndomains: [private]\n---\n\nold\n"
    assert fireflies_tags.page_topics(existing, ("consulting",), "domains") == ("private",)

    index = meeting_writeback.build_index(tmp_path)
    first = meeting_writeback._render_one(_input(), None, "create", index, date(2026, 1, 6), None)
    assert parse_frontmatter(first).frontmatter["domains"] == ["consulting"]

    edited = first.replace('domains: ["consulting"]', "domains: [private]")
    assert edited != first
    again = meeting_writeback._render_one(
        _input(page_topics=("properties",)), edited, "regenerate", index, date(2026, 1, 7), None
    )
    assert parse_frontmatter(again).frontmatter["domains"] == ["private"]
