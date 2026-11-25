#!/usr/bin/env python3
"""`meeting_writeback` picks create / regenerate / skip safely.

    python -m pullers.meeting_writeback_test

Writes into a throwaway folder with push=False -- no git, no network, no LLM.
"""

from __future__ import annotations

import sys
import tempfile
from datetime import date
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from knowledge.frontmatter import parse as parse_frontmatter  # noqa: E402
from pullers.meeting_page import MeetingInput  # noqa: E402
from pullers.meeting_writeback import decide_action, stored_page_ids, write_pages  # noqa: E402

OLD_TEMPLATE = """---
title: "Build Session"
type: meeting
date: 2026-10-06
created: 2026-10-07
tags: [meeting]
related: []
fireflies_id: abc
---

## Overview

- **Old overview** line.

## Action Items

Do the thing (01:00)

## Keywords

SOW, Ledger

## Attendees

"""

HAND_PAGE = """---
title: "Build Session"
type: meeting
related: ["[[Northwind Traders]]"]
---

## Decisions

Hand-written, keep me.
"""

PEOPLE = {"people/Sam Rivera.md": "---\ntitle: Sam Rivera\n---\nx\n"}


def _wiki(pages: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp())
    for rel, text in {**PEOPLE, **pages}.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def _inp(external_id="2026-10-06-build-session.md", lines=2, summary=None) -> MeetingInput:
    return MeetingInput(
        fireflies_id="abc", title="Build Session", date_str="2026-10-06", duration_minutes=30,
        external_id=external_id,
        summary=summary if summary is not None else {"overview": "New overview", "notes": "Full notes"},
        transcript_lines=tuple(f"**Sam Rivera** [00:0{i}]: line {i}" for i in range(lines)),
        speakers=("Sam Rivera", "Pat Owner"),
    )


def _write(root: Path, inputs, **kwargs):
    return write_pages(inputs, root=root, today=date(2026, 10, 15), llm=None, push=False, **kwargs)


def test_decide_action() -> None:
    assert decide_action(None)[0] == "create"
    assert decide_action(OLD_TEMPLATE)[0] == "regenerate"
    assert decide_action(HAND_PAGE)[0] == "skip"


def test_create_new_page() -> None:
    root = _wiki({})
    receipt = _write(root, [_inp()])
    page = (root / "meetings/2026-10-06-build-session.md").read_text()
    fm = parse_frontmatter(page).frontmatter
    assert receipt.written == ["meetings/2026-10-06-build-session.md"]
    assert fm["related"] == ["[[Sam Rivera]]"]
    assert "**Sam Rivera** [00:01]: line 1" in page
    assert receipt.page_ids == {"2026-10-06-build-session.md": "meetings/2026-10-06-build-session.md"}


def test_old_template_regenerated_keeping_created() -> None:
    root = _wiki({"meetings/2026-10-06-build-session.md": OLD_TEMPLATE})
    _write(root, [_inp()])
    page = (root / "meetings/2026-10-06-build-session.md").read_text()
    assert str(parse_frontmatter(page).frontmatter["created"]) == "2026-10-07"
    assert "Full notes" in page and "Old overview" not in page


def test_old_template_summary_reused_when_notes_gone() -> None:
    root = _wiki({"meetings/2026-10-06-build-session.md": OLD_TEMPLATE})
    _write(root, [_inp(summary={})])
    page = (root / "meetings/2026-10-06-build-session.md").read_text()
    assert "Old overview" in page and "SOW, Ledger" in page


def test_hand_page_skipped_untouched() -> None:
    root = _wiki({"meetings/2026-10-06-build-session.md": HAND_PAGE})
    receipt = _write(root, [_inp()])
    assert (root / "meetings/2026-10-06-build-session.md").read_text() == HAND_PAGE
    assert receipt.skipped and receipt.page_ids["2026-10-06-build-session.md"]


def test_second_run_is_unchanged_and_keeps_human_sections() -> None:
    root = _wiki({})
    _write(root, [_inp()])
    path = root / "meetings/2026-10-06-build-session.md"
    path.write_text(path.read_text() + "\n## My Notes\n\nKeep this.\n")
    receipt = write_pages([_inp()], root=root, today=date(2026, 10, 20), llm=None, push=False)
    assert "## My Notes" in path.read_text()
    second = write_pages([_inp()], root=root, today=date(2026, 10, 21), llm=None, push=False)
    assert second.unchanged == ["meetings/2026-10-06-build-session.md"], (receipt.summary(), second.summary())


def test_duplicate_recordings_collapse_to_longest() -> None:
    root = _wiki({})
    receipt = _write(root, [
        _inp(external_id="2026-10-06-build-session.md", lines=2),
        _inp(external_id="2026-10-06-build-session-1405.md", lines=9),
    ])
    assert receipt.written == ["meetings/2026-10-06-build-session.md"]
    assert "line 8" in (root / "meetings/2026-10-06-build-session.md").read_text()
    assert set(receipt.page_ids) == {"2026-10-06-build-session.md", "2026-10-06-build-session-1405.md"}


def test_dry_run_writes_nothing() -> None:
    root = _wiki({})
    receipt = _write(root, [_inp()], dry_run=True)
    assert not (root / "meetings").exists()
    assert receipt.previews and not receipt.page_ids


def test_existing_page_found_by_fireflies_id() -> None:
    renamed = OLD_TEMPLATE.replace("fireflies_id: abc", 'fireflies_id: "abc"')
    root = _wiki({"meetings/2026-10-06-calendar-title.md": renamed})
    receipt = _write(root, [_inp()])
    assert receipt.written == ["meetings/2026-10-06-calendar-title.md"]
    assert not (root / "meetings/2026-10-06-build-session.md").exists()


def test_recap_page_with_links_is_not_old_template() -> None:
    recap = OLD_TEMPLATE.replace("related: []", 'related: ["[[Northwind Traders]]"]')
    assert decide_action(recap)[0] == "skip"
    described = OLD_TEMPLATE.replace("tags: [meeting]", "tags: [meeting]\ndescription: hand")
    assert decide_action(described)[0] == "skip"
    no_id = OLD_TEMPLATE.replace("fireflies_id: abc\n", "")
    assert decide_action(no_id)[0] == "skip"


def test_mis_stamped_duplicate_loses_to_exact_name() -> None:
    wrong = OLD_TEMPLATE.replace('title: "Build Session"', 'title: "Ledger Kickoff"')
    root = _wiki({
        "meetings/2026-10-01-ledger-kickoff.md": wrong,       # same fireflies_id, wrong event
        "meetings/2026-10-06-build-session.md": OLD_TEMPLATE,  # named for the recording
    })
    receipt = _write(root, [_inp()])
    assert receipt.written == ["meetings/2026-10-06-build-session.md"], receipt.written
    assert (root / "meetings/2026-10-01-ledger-kickoff.md").read_text() == wrong


def test_regenerate_adds_newly_matched_people_to_stored_related() -> None:
    root = _wiki({})
    _write(root, [_inp()])
    path = root / "meetings/2026-10-06-build-session.md"
    path.write_text(path.read_text().replace('related: ["[[Sam Rivera]]"]', 'related: ["[[Northwind Traders]]"]'))
    (root / "people/Dana Lee.md").write_text("---\ntitle: Dana Lee\naliases:\n  - Dana Marie Lee\n---\nx\n")
    inp = MeetingInput(**{**{f: getattr(_inp(), f) for f in _inp().__dataclass_fields__},
                          "speakers": ("Sam Rivera", "Dana Marie Lee")})
    _write(root, [inp])
    related = parse_frontmatter(path.read_text()).frontmatter["related"]
    assert related == ["[[Northwind Traders]]", "[[Sam Rivera]]", "[[Dana Lee]]"], related


# ---------------------------------------------------------------------------
# stored_page_ids — direct unit tests (M1 / M2 from review)
# ---------------------------------------------------------------------------

class _StoredQuery:
    def __init__(self, rows):
        self._rows, self._filters, self._in_values = rows, {}, None

    def select(self, *_): return self
    def eq(self, k, v): self._filters[k] = v; return self
    def in_(self, key, values): self._in_values = (key, list(values)); return self

    def execute(self):
        rows = self._rows
        for k, v in self._filters.items():
            rows = [r for r in rows if r.get(k) == v]
        if self._in_values:
            key, values = self._in_values
            rows = [r for r in rows if r.get(key) in values]
        class R:
            pass
        r = R(); r.data = rows; return r


class _StoredSb:
    def __init__(self, rows): self._rows = rows
    def schema(self, _): return self
    def table(self, _): return _StoredQuery(self._rows)


def test_stored_page_ids_returns_recorded_links() -> None:
    sb = _StoredSb([
        {"source": "fireflies", "external_id": "a.md", "metadata": {"wiki_page_id": "meetings/a.md"}},
        {"source": "fireflies", "external_id": "b.md", "metadata": {"wiki_page_id": None}},
        {"source": "fireflies", "external_id": "c.md", "metadata": {}},
    ])
    result = stored_page_ids(sb, ["a.md", "b.md", "c.md"])
    assert result == {"a.md": "meetings/a.md"}  # None and missing excluded


def test_stored_page_ids_empty_input() -> None:
    assert stored_page_ids(_StoredSb([]), []) == {}


def test_stored_page_ids_paginates_large_batches() -> None:
    ids = [f"{i:04d}.md" for i in range(101)]
    rows = [
        {"source": "fireflies", "external_id": id_, "metadata": {"wiki_page_id": f"meetings/{id_}"}}
        for id_ in ids
    ]
    sb = _StoredSb(rows)
    result = stored_page_ids(sb, ids)
    assert len(result) == 101
    assert result["0000.md"] == "meetings/0000.md"
    assert result["0100.md"] == "meetings/0100.md"


TESTS = [
    test_regenerate_adds_newly_matched_people_to_stored_related,
    test_mis_stamped_duplicate_loses_to_exact_name,
    test_recap_page_with_links_is_not_old_template,
    test_existing_page_found_by_fireflies_id,
    test_decide_action,
    test_create_new_page,
    test_old_template_regenerated_keeping_created,
    test_old_template_summary_reused_when_notes_gone,
    test_hand_page_skipped_untouched,
    test_second_run_is_unchanged_and_keeps_human_sections,
    test_duplicate_recordings_collapse_to_longest,
    test_dry_run_writes_nothing,
    test_stored_page_ids_returns_recorded_links,
    test_stored_page_ids_empty_input,
    test_stored_page_ids_paginates_large_batches,
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
