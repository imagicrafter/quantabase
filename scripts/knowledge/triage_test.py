"""Triage rules: what is skipped, and the order of what is kept.

Every rule comes from the row and the Engine config. No topic name, folder
name or document template is special.
"""

from __future__ import annotations

from knowledge import triage as triage_module
from knowledge.triage import MIN_BODY_CHARS, priority_score, triage

LONG_BODY = "A decision was recorded and the reasons are set out below. " * 12
MACHINE_REPORT_BODY = (
    "Weekly report 2026-07-31\n"
    "Name: Example Co. Theme: sample Generated: 2026-07-31T07:00:38\n\n" + LONG_BODY
)


def _row(doc_id: str, *, title: str = "A page", body: str = LONG_BODY, **extra) -> dict:
    return {
        "id": doc_id,
        "source": "drive",
        "external_id": doc_id,
        "title": title,
        "body": body,
        "metadata": {},
        "parent_external_id": None,
        "source_created_at": "2026-07-31T07:00:38Z",
        **extra,
    }


def _ids(result) -> tuple[set[str], dict[str, str]]:
    return {c.doc_id for c in result.candidates}, {s.doc_id: s.reason for s in result.skipped}


def test_a_long_enough_document_is_a_candidate() -> None:
    kept, skipped = _ids(triage([_row("a")]))
    assert kept == {"a"} and skipped == {}


def test_a_short_body_is_skipped_with_a_reason() -> None:
    kept, skipped = _ids(triage([_row("a", body="x" * (MIN_BODY_CHARS - 1))]))
    assert kept == set()
    assert skipped == {"a": "body too short to summarise"}


def test_placeholder_titles_are_skipped() -> None:
    rows = [
        _row("a", title="Untitled document"),
        _row("b", title="Copy of plan", body=LONG_BODY + "b"),
        _row("c", title="Backup of notes", body=LONG_BODY + "c"),
    ]
    kept, skipped = _ids(triage(rows))
    assert kept == set()
    assert set(skipped.values()) == {"untitled placeholder", "duplicate copy", "backup copy"}


def test_no_rule_skips_a_document_for_its_template_or_folder() -> None:
    """A machine-written report is a document like any other."""
    row = _row("a", title="2026-07-31 report", body=MACHINE_REPORT_BODY,
               metadata={"folder_path": "Reports"})
    kept, skipped = _ids(triage([row]))
    assert kept == {"a"} and skipped == {}


def test_a_section_and_an_excluded_row_are_skipped() -> None:
    section = _row("s", parent_external_id="parent")
    excluded = _row("e", body=LONG_BODY + "e")
    key = ("drive", "e", triage_module._current_content_hash(excluded))
    kept, skipped = _ids(triage([section, excluded], excluded_keys=frozenset({key})))
    assert kept == set()
    assert skipped["s"] == "section of a larger document"
    assert skipped["e"] == "excluded by prior human review"


def test_identical_bodies_collapse_to_one_candidate() -> None:
    rows = [_row("a", title="First"), _row("b", title="Second")]
    kept, skipped = _ids(triage(rows))
    assert len(kept) == 1 and len(skipped) == 1
    assert next(iter(skipped.values())).startswith("byte-identical to")


def test_priority_bands_come_from_the_config_not_from_topic_names(monkeypatch) -> None:
    monkeypatch.setattr(triage_module, "configured_sensitive_domains", lambda: ("private",))
    disputed = _row("d", label_source="model_proposed", domains=["open"])
    sensitive = _row("s", domains=["private"])
    dropped = _row("t", domains=["open"], metadata={"distill": {"dropped_terms": 2}})
    plain = _row("p", domains=["client-example"], tier=1)
    scores = [priority_score(row) for row in (disputed, sensitive, dropped, plain)]
    assert scores == sorted(scores, reverse=True)
    assert int(scores[0]) == 300 and int(scores[1]) == 200 and int(scores[2]) == 100
    assert scores[3] < 1.0, "a topic id gives no priority on its own"


def test_candidates_are_ordered_by_priority(monkeypatch) -> None:
    monkeypatch.setattr(triage_module, "configured_sensitive_domains", lambda: ("private",))
    rows = [
        _row("plain", domains=["open"]),
        _row("sensitive", domains=["private"], body=LONG_BODY + "s"),
        _row("disputed", label_source="model_proposed", domains=["open"], body=LONG_BODY + "d"),
    ]
    assert [c.doc_id for c in triage(rows).candidates] == ["disputed", "sensitive", "plain"]
