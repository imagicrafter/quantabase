#!/usr/bin/env python3
"""`meeting_links` matches people exactly and never invents related pages.

    python -m pullers.meeting_links_test

Uses a throwaway wiki folder and a fake LLM -- no network.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.meeting_links import build_index, build_links, parse_llm_titles  # noqa: E402

PAGES = {
    "people/Sam Rivera.md": (
        '---\ntitle: Sam Rivera\naliases:\n  - Sam Rivera\n  - Sammy Rivera\n'
        'related: ["[[Rivera Partners]]", "[[Dana Lee]]"]\n---\nbody\n'
    ),
    "people/Dana Lee.md": (
        "---\ntitle: Dana Lee\nemail: dana@northwind.example\n"
        'related: ["[[Northwind Traders]]"]\n---\nbody\n'
    ),
    "projects/Rivera Partners.md": "---\ntitle: Rivera Partners\n---\nbody\n",
    "projects/Northwind Traders.md": "---\ntitle: Northwind Traders\n---\nbody\n",
    "concepts/Value Unlock.md": "---\ntitle: Value Unlock\n---\nbody\n",
}


def _index():
    tmp = Path(tempfile.mkdtemp())
    for rel, text in PAGES.items():
        path = tmp / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return build_index(tmp)


def _links(speakers=(), emails=(), llm=None):
    return build_links(
        title="Build session", summary_text="SOW for Dana", speakers=tuple(speakers),
        emails=tuple(emails), index=_index(), llm=llm,
    )


def test_exact_name_and_alias_match() -> None:
    links = _links(speakers=["Sam Rivera", "Sammy Rivera"])
    assert links.attendees == (("Sam Rivera", "[[Sam Rivera]]"), ("Sammy Rivera", "[[Sam Rivera]]"))


def test_first_name_alone_does_not_match() -> None:
    links = _links(speakers=["Dana"])
    assert links.attendees == (("Dana", None),)
    assert links.related == ()


def test_email_match_adds_person() -> None:
    links = _links(speakers=["Pat Owner"], emails=["dana@northwind.example", "owner@example.com"])
    assert ("Dana Lee", "[[Dana Lee]]") in links.attendees
    assert "[[Dana Lee]]" in links.related


def test_self_dropped_from_related() -> None:
    links = _links(speakers=["Pat Owner", "Sam Rivera"])
    assert all("Pat Owner" not in r for r in links.related)


def test_llm_titles_validated() -> None:
    links = _links(
        speakers=["Sam Rivera"],
        llm=lambda _prompt: '{"related": ["Northwind Traders", "Made Up Page", "[[Value Unlock]]"]}',
    )
    assert links.related == ("[[Sam Rivera]]", "[[Northwind Traders]]", "[[Value Unlock]]")
    assert links.llm_used


def test_llm_failure_falls_back_to_people_projects() -> None:
    def broken(_prompt: str) -> str:
        raise RuntimeError("down")

    links = _links(speakers=["Sam Rivera"], llm=broken)
    assert links.related == ("[[Sam Rivera]]", "[[Rivera Partners]]")
    assert not links.llm_used


def test_parse_llm_titles_handles_garbage() -> None:
    assert parse_llm_titles("no json here", {"A"}) == []
    assert parse_llm_titles('{"related": null}', {"A"}) == []
    assert parse_llm_titles('{"related": ["Northwind Traders (projects)"]}', {"Northwind Traders"}) == ["Northwind Traders"]
    assert parse_llm_titles('```json\n{"related": ["A", "B"]}\n```', {"A"}) == ["A"]


def test_verbatim_title_mention_links_page() -> None:
    links = build_links(
        title="Northwind Traders weekly", summary_text="", speakers=(), emails=(), index=_index(), llm=None,
    )
    assert "[[Northwind Traders]]" in links.related


TESTS = [
    test_verbatim_title_mention_links_page,
    test_exact_name_and_alias_match,
    test_first_name_alone_does_not_match,
    test_email_match_adds_person,
    test_self_dropped_from_related,
    test_llm_titles_validated,
    test_llm_failure_falls_back_to_people_projects,
    test_parse_llm_titles_handles_garbage,
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
