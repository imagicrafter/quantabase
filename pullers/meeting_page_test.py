#!/usr/bin/env python3
"""`meeting_page` renders OKF meeting pages and round-trips the notes block.

    python -m pullers.meeting_page_test

Pure function tests -- no Fireflies API, no database, no git.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from knowledge.frontmatter import parse as parse_frontmatter  # noqa: E402
from pullers.meeting_page import (  # noqa: E402
    MeetingInput,
    headings,
    parse_notes_block,
    parse_transcript_lines,
    render_meeting_page,
    render_notes_block,
)

TODAY = date(2026, 10, 15)

SUMMARY = {
    "short_summary": "The team planned Dana's Ledger transition.",
    "gist": "The team planned Dana's transition from the old system to Ledger and refined the SOW.",
    "overview": "- **Ledger Transition:** Rebuild the import engine.",
    "notes": "## **Ledger Transition**\n\n- **Overhaul** ensures Claude works with Ledger (00:06)",
    "shorthand_bullet": "📧 **Customer Data** (00:26 - 06:29)\nAddressed Dana's email.",
    "action_items": "**Pat Owner**\nUpdate Claude to integrate Ledger (14:13)",
    "keywords": ["Ledger transition", "Statement of Work"],
}

LINES = (
    "**Pat Owner** [00:00]: Hey.",
    "**Sam Rivera** [00:02]: So the SOW: $20,000 total.",
)


def _input(**overrides) -> MeetingInput:
    base = dict(
        fireflies_id="01M499J3RTAEV39KFD1AK4J6C3",
        title='Pat & Sam: "Build" Sessions',
        date_str="2026-10-06",
        duration_minutes=32,
        external_id="2026-10-06-pat-sam-build-sessions.md",
        summary=SUMMARY,
        transcript_lines=LINES,
        speakers=("Pat Owner", "Sam Rivera"),
        attendee_emails=(),
        domain_tags=("northwind",),
    )
    return MeetingInput(**{**base, **overrides})


def _render(inp: MeetingInput | None = None, **kwargs) -> str:
    return render_meeting_page(
        inp or _input(),
        attendees=kwargs.get("attendees", (("Sam Rivera", "[[Sam Rivera]]"), ("Pat Owner", None))),
        related=kwargs.get("related", ("[[Sam Rivera]]", "[[Northwind Traders]]")),
        today=TODAY,
        created=kwargs.get("created"),
    )


def test_frontmatter_has_okf_and_meeting_fields() -> None:
    fm = parse_frontmatter(_render()).frontmatter
    for key in (
        "title", "aliases", "type", "date", "created", "updated", "timestamp", "tags",
        "related", "description", "sources", "generated", "verified", "status",
        "fireflies_id", "duration_minutes", "attendees",
    ):
        assert key in fm, f"missing frontmatter key {key}"
    assert fm["type"] == "meeting"
    assert fm["title"] == 'Pat & Sam: "Build" Sessions'
    assert fm["related"] == ["[[Sam Rivera]]", "[[Northwind Traders]]"]
    assert fm["generated"]["by"] == "kb-engine puller-fireflies"
    assert fm["sources"] == ["fireflies-01M499J3RTAEV39KFD1AK4J6C3"]
    assert fm["attendees"] == ["Sam Rivera", "Pat Owner"]
    assert "northwind" in fm["tags"] and "meeting" in fm["tags"]
    assert str(fm["date"]) == "2026-10-06"


def test_description_capped_at_140() -> None:
    long = dict(SUMMARY, gist="x" * 400)
    fm = parse_frontmatter(_render(_input(summary=long))).frontmatter
    assert len(fm["description"]) <= 140


def test_sections_in_order_and_notes_demoted() -> None:
    page = _render()
    order = [h for h in headings(page)]
    assert order == [
        "Summary", "Overview", "Notes", "Topics", "Action Items", "Keywords",
        "Attendees", "Transcript", "Source",
    ], order
    assert "#### **Ledger Transition**" in page
    assert "\n## **Ledger" not in page


def test_empty_fields_drop_their_section() -> None:
    page = _render(_input(summary={"overview": "Only an overview."}))
    assert headings(page) == ["Overview", "Attendees", "Transcript", "Source"]


def test_transcript_and_attendee_links() -> None:
    page = _render()
    assert "**Sam Rivera** [00:02]: So the SOW: $20,000 total." in page
    assert "- [[Sam Rivera]]" in page
    assert "- Pat Owner" in page
    assert "https://app.fireflies.ai/view/01M499J3RTAEV39KFD1AK4J6C3" in page


def test_created_is_preserved() -> None:
    fm = parse_frontmatter(_render(created="2026-10-07")).frontmatter
    assert str(fm["created"]) == "2026-10-07"
    assert str(fm["updated"]) == "2026-10-15"


def test_notes_block_round_trip() -> None:
    block = render_notes_block(SUMMARY)
    body = f"# Transcript: x\n\n{block}\n\n---\n\n" + "\n".join(LINES)
    parsed = parse_notes_block(body)
    for key in ("short_summary", "overview", "notes", "shorthand_bullet", "action_items"):
        assert parsed[key].strip() == SUMMARY[key].strip(), key
    assert parsed["keywords"] == SUMMARY["keywords"]


def test_notes_block_absent_returns_empty() -> None:
    assert parse_notes_block("# Transcript: x\n\n---\n\n**A** [00:00]: hi") == {}


def test_parse_transcript_lines_and_speakers() -> None:
    body = "# Transcript: x\n**Date:** d\n\n---\n\n" + "\n".join(LINES) + "\nnot a line"
    lines, speakers = parse_transcript_lines(body)
    assert lines == LINES
    assert speakers == ("Pat Owner", "Sam Rivera")


def test_from_raw_builds_input() -> None:
    raw = {
        "id": "abc", "title": "Client Scope", "date": 1759622400000, "duration": 31.6,
        "speakers": [{"name": "Dana Lee"}, {"name": "Pat Owner"}],
        "meeting_attendees": [{"displayName": "", "email": "dana@northwind.example"}],
        "participants": ["owner@example.com", "dana@northwind.example"],
        "sentences": [{"speaker_name": "Dana Lee", "text": "Hi", "start_time": 1.0}],
        "summary": {"overview": "o", "keywords": ["k"]},
    }
    inp = MeetingInput.from_raw(raw, external_id="2025-10-05-client-scope.md", domain_tags=())
    assert inp.duration_minutes == 32
    assert inp.speakers == ("Dana Lee", "Pat Owner")
    assert inp.attendee_emails == ("dana@northwind.example", "owner@example.com")
    assert inp.transcript_lines == ("**Dana Lee** [00:01]: Hi",)


TESTS = [
    test_frontmatter_has_okf_and_meeting_fields,
    test_description_capped_at_140,
    test_sections_in_order_and_notes_demoted,
    test_empty_fields_drop_their_section,
    test_transcript_and_attendee_links,
    test_created_is_preserved,
    test_notes_block_round_trip,
    test_notes_block_absent_returns_empty,
    test_parse_transcript_lines_and_speakers,
    test_from_raw_builds_input,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:  # noqa: BLE001 -- report every failure
            failed += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
