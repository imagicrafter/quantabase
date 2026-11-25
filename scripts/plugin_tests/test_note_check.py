"""send-session: the note is validated, scrubbed and its quotes checked
against the session before anything is sent."""

from __future__ import annotations

import copy

import pytest

from plugin_tests.helpers import fake, load

nc = load("note_check")

TRANSCRIPT = {
    "owner": ["ok, let's ship 2.0 on Dec 1 instead", "Plan the **release**  please"],
    "assistant": ["One option is a nightly export to the shared drive.", "Use `kbe db migrate` — it’s safe."],
}

NOTE = {
    "items": [
        {
            "label": "decided",
            "text": "Release 2.0 ships on 2026-12-01.",
            "quotes": [{"who": "owner", "text": "ok, let's ship 2.0 on Dec 1 instead"}],
            "pages": [{"key": "project:northwind", "title": "Northwind", "whats_new": "new date"}],
        },
        {
            "label": "idea",
            "text": "A nightly export was floated.",
            "quotes": [{"who": "assistant", "text": "One option is a nightly export to the shared drive."}],
            "new_pages": [{"drawer": "decisions", "title": "Nightly export", "why": "may become one"}],
        },
    ],
}

HEADER = {"session_id": "abc-123", "project": "demo", "started_at": "2026-11-24T09:00:00Z", "ended_at": "2026-11-24T11:30:00Z"}


def _note(**over):
    return {**copy.deepcopy(NOTE), **HEADER, **over}


def test_a_good_note_passes_and_renders():
    result = nc.check_note(_note(), TRANSCRIPT)
    assert result.errors == []
    assert result.redactions == 0
    md = nc.render(result.note)
    assert md.startswith("# Session note: demo\n")
    assert "## 1. [decided] Release 2.0 ships on 2026-12-01." in md
    assert '> Owner: "ok, let\'s ship 2.0 on Dec 1 instead"' in md
    assert "- project:northwind (Northwind): new date" in md
    assert "- decisions: Nightly export: may become one" in md


@pytest.mark.parametrize("change, message", [
    (lambda n: n["items"][0].update(label="maybe"), "label"),
    (lambda n: n.update(items=[]), "1 to 30 items"),
    (lambda n: n["items"][0].update(quotes=[]), "1 to 3 quotes"),
    (lambda n: n["items"][0]["quotes"].append({"who": "bob", "text": "x"}), "who"),
    (lambda n: n["items"][0].update(text="t" * 601), "600"),
    (lambda n: n["items"][0]["pages"][0].update(key="a b"), "key"),
    (lambda n: n["items"][0]["pages"][0].update(patches=[]), "unknown field"),
    (lambda n: n["items"][1]["new_pages"][0].update(drawer="Bad Drawer"), "drawer"),
    (lambda n: n.update(topics=["x"]), "unknown field"),
    (lambda n: n.update(session_id="../x"), "session_id"),
])
def test_shape_errors_are_named(change, message):
    note = _note()
    change(note)
    errors = nc.check_note(note, TRANSCRIPT).errors
    assert errors and any(message in e for e in errors), errors


def test_a_quote_not_in_the_session_is_refused_with_its_place():
    note = _note()
    note["items"][0]["quotes"][0]["text"] = "we will ship on Dec 1"
    errors = nc.check_note(note, TRANSCRIPT).errors
    assert errors == ['item 1, quote 1: not found word for word in what the owner wrote: "we will ship on Dec 1"']


def test_a_quote_must_come_from_the_named_speaker():
    note = _note()
    note["items"][1]["quotes"][0]["who"] = "owner"
    assert "item 2, quote 1" in nc.check_note(note, TRANSCRIPT).errors[0]


def test_quotes_match_across_spacing_typography_and_markdown():
    note = _note()
    note["items"][0]["quotes"] = [{"who": "owner", "text": "Plan the release please"},
                                  {"who": "assistant", "text": "Use kbe db migrate - it's safe."}]
    assert nc.check_note(note, TRANSCRIPT).errors == []


@pytest.mark.parametrize("quote", ["**", '""', "ok", "``yes``"])
def test_quotes_too_short_to_check_are_refused(quote):
    note = _note()
    note["items"][0]["quotes"] = [{"who": "owner", "text": quote}]
    assert any("too short" in e for e in nc.check_note(note, TRANSCRIPT).errors)


def test_every_item_needs_a_quote_from_the_owner_or_claude():
    note = _note()
    note["items"][0]["quotes"] = [{"who": "tool", "text": "3 passed"}]
    assert any("owner or assistant" in e for e in nc.check_note(note, TRANSCRIPT).errors)


@pytest.mark.parametrize("stamp", ["yesterday", "2026-13-40T00:00:00Z", 5])
def test_bad_dates_are_refused_before_asking(stamp):
    assert any("started_at" in e for e in nc.check_note(_note(started_at=stamp), TRANSCRIPT).errors)


def test_dates_render_in_utc_like_the_engine():
    result = nc.check_note(_note(started_at="2026-11-24T10:00:00+05:00"), TRANSCRIPT)
    assert "Session abc-123, 2026-11-24 05:00 to 2026-11-24 11:30 UTC." in nc.render(result.note)


def test_a_new_page_key_is_checked_like_a_page_key():
    note = _note()
    note["items"][1]["new_pages"][0]["key"] = "a b"
    assert any("new page 1: key" in e for e in nc.check_note(note, TRANSCRIPT).errors)
    note["items"][1]["new_pages"][0]["key"] = 7
    assert any("new page 1: key" in e for e in nc.check_note(note, TRANSCRIPT).errors)


def test_tool_quotes_are_short_and_not_checked():
    note = _note()
    note["items"][0]["quotes"].append({"who": "tool", "text": "3 passed"})
    result = nc.check_note(note, TRANSCRIPT)
    assert result.errors == [] and result.unchecked == 1
    note["items"][0]["quotes"][1] = {"who": "tool", "text": "x" * 201}
    assert any("200" in e for e in nc.check_note(note, TRANSCRIPT).errors)


def test_without_a_transcript_quotes_are_not_checked():
    note = _note()
    note["items"][0]["quotes"][0]["text"] = "anything at all"
    result = nc.check_note(note, None)
    assert result.errors == [] and result.unchecked == 2


def test_secrets_in_the_note_are_scrubbed_everywhere_before_checking():
    key = fake("sk-" + "ant-", "api03-A1b2C3d4E5f6G7h8I9j0K1l2M3n4")
    note = _note()
    note["items"][0]["text"] = f"Set the key {key}"
    note["items"][0]["pages"][0]["whats_new"] = f"token=abc123def456"  # gitleaks:allow (made-up)
    note["items"][0]["quotes"] = [{"who": "owner", "text": f"use {key}"}]
    transcript = {"owner": [f"use {key}"], "assistant": TRANSCRIPT["assistant"]}
    scrubbed_transcript = {r: [load("session_scrub").scrub(t)[0] for t in ts] for r, ts in transcript.items()}
    result = nc.check_note(note, scrubbed_transcript)
    assert result.errors == []
    assert result.redactions == 3
    assert key not in nc.render(result.note) and "abc123def456" not in nc.render(result.note)


def test_the_note_has_a_size_ceiling():
    note = _note(items=[{"label": "fact", "text": "t" * 600,
                         "quotes": [{"who": "owner", "text": "q q " * 100}] * 3} for _ in range(30)])
    errors = nc.check_note(note, TRANSCRIPT).errors
    assert any("too long" in e for e in errors)


def test_unicode_survives():
    transcript = {"owner": ["Résumé für 東京 🚀 approved"], "assistant": []}
    note = _note()
    note["items"] = [{"label": "fact", "text": "Le résumé 東京 🚀", "quotes": [{"who": "owner", "text": "Résumé für 東京 🚀 approved"}]}]  # noqa: E501
    result = nc.check_note(note, transcript)
    assert result.errors == []
    assert "東京 🚀" in nc.render(result.note)


def test_not_a_note_at_all():
    assert nc.check_note(["x"], TRANSCRIPT).errors == ["the note must be a JSON object"]


def test_renders_exactly_as_the_engine_does():
    """The same fixture the Engine's test renders (engine/tests/sources/fixtures)."""
    import json
    from pathlib import Path
    here = Path(__file__).resolve().parents[2] / "engine" / "tests" / "sources" / "fixtures"
    note = json.loads((here / "session-note.json").read_text(encoding="utf-8"))
    assert nc.render(note) == (here / "session-note.md").read_text(encoding="utf-8")
