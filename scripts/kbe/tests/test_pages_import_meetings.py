"""`kbe pages import`: a meeting is matched by its key only (migration 0079).

A recurring meeting has the same title every week but a new meeting id (or,
without an id, a new date in its date-slug key). Matching it to an earlier
page by name dropped its notes. Drawers whose key rule is `source_id` now
send `key_only: true`, and the database looks for the key alone.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kbe import pages
from kbe.errors import KbeError
from kbe.pages_import import Drawer, load_drawers, plan
from kbe.tests.helpers import make_context

OWNER = "o@example.com"


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def meeting(when: str, ident: str | None, title: str = "Pat / Sam sync-up") -> str:
    id_line = f'meeting_id: "{ident}"\n' if ident else ""
    return f"---\ntitle: {title}\ntype: meeting\ndate: {when}\n{id_line}---\nNotes for {when}.\n"


@pytest.fixture
def recurring(tmp_path: Path) -> Path:
    root = tmp_path / "wiki"
    write(root, "people/Pat.md", "---\ntitle: Pat\ntype: person\nemail: pat@example.com\n---\nx\n")
    write(root, "people/Zed.md", "---\ntitle: Pat\ntype: person\n---\nsame name, no email\n")
    write(root, "meetings/2025-06-03-sync.md", meeting("2025-06-03", "01ab"))
    write(root, "meetings/2025-06-10-sync.md", meeting("2025-06-10", "01cd"))
    write(root, "meetings/2025-06-17-sync.md", meeting("2025-06-17", None))
    write(root, "meetings/2025-06-18-sync.md", meeting("2025-06-18", None))
    return root


def by_key(result):
    return {p.page["key"]: p.page for p in result.pages}


def test_every_recurring_meeting_is_its_own_page(recurring):
    keys = by_key(plan(recurring))
    assert {"meeting:01ab", "meeting:01cd", "meeting:2025-06-17-pat-sam-sync-up",
            "meeting:2025-06-18-pat-sam-sync-up"} <= set(keys)


def test_source_id_drawers_are_sent_key_only_and_the_rest_are_not(recurring):
    keys = by_key(plan(recurring))
    assert all(keys[k].get("key_only") is True for k in keys if k.startswith("meeting:"))
    assert all("key_only" not in keys[k] for k in keys if not k.startswith("meeting:"))


def test_key_only_follows_the_template_rule_not_the_drawer_name(tmp_path):
    root = tmp_path / "wiki"
    write(root, "calls/a.md", "---\ntitle: Weekly\ntype: call\ncall_id: c1\n---\nx\n")
    write(root, "notes/b.md", "---\ntitle: Weekly\ntype: meeting\n---\nx\n")
    drawers = {
        "calls": Drawer(id="calls", key_kind="source_id", prefix="call", fields=()),
        "meetings": Drawer(id="meetings", key_kind="slug", prefix="meeting", fields=()),
    }
    result = plan(root, drawers=drawers)
    sent = {p.page["drawer"]: p.page for p in result.pages}
    assert sent["calls"].get("key_only") is True
    assert "key_only" not in sent["meetings"]


def test_the_base_template_gives_meetings_a_source_id_rule():
    assert load_drawers()["meetings"].key_kind == "source_id"


class FakeEngine:
    """page_import as the database runs it: the key first, then (unless the
    page is key-only or a restore) a page of the same name in the same drawer."""

    def __init__(self, knows_key_only: bool = True):
        self.pages: dict[str, dict] = {}
        self.knows_key_only = knows_key_only
        self.calls: list[dict] = []

    def call(self, function, args=None):
        assert function == "page_import"
        page = args["p_page"]
        self.calls.append(page)
        flag = {"key_only": bool(page.get("key_only"))} if self.knows_key_only else {}
        if page["key"] in self.pages:
            return {"status": "exists", "key": page["key"], **flag}
        if not (self.knows_key_only and page.get("key_only")):
            same = [k for k, p in self.pages.items()
                    if p["drawer"] == page["drawer"] and p["title"].lower() == page["title"].lower()]
            if same:
                return {"status": "matched", "key": same[0], "how": "name",
                        "proposed": page["key"], **flag}
        self.pages = {**self.pages, page["key"]: page}
        return {"status": "created", "key": page["key"], **flag}


def test_apply_files_each_recurring_meeting_and_still_matches_people_by_name(recurring, tmp_path):
    ctx, seen = make_context(tmp_path)
    engine = FakeEngine()
    counts = pages.apply(engine, plan(recurring), OWNER, ctx)
    assert {k for k in engine.pages if k.startswith("meeting:")} == {
        "meeting:01ab", "meeting:01cd", "meeting:2025-06-17-pat-sam-sync-up",
        "meeting:2025-06-18-pat-sam-sync-up"}
    assert counts == {"created": 5, "exists": 0, "matched": 1, "refused": 0}
    assert not any("matched meetings/" in line for line in seen)


def test_a_rerun_creates_the_meetings_an_older_import_dropped(recurring, tmp_path):
    ctx, _ = make_context(tmp_path)
    engine = FakeEngine()
    result = plan(recurring)
    # What the old import left: every page but the meetings it matched by name.
    dropped = {"meeting:01cd", "meeting:2025-06-17-pat-sam-sync-up", "meeting:2025-06-18-pat-sam-sync-up"}
    engine.pages = {p.page["key"]: p.page for p in result.pages
                    if p.page["key"] not in dropped and p.page["key"] != "person:pat"}
    before = dict(engine.pages)
    counts = pages.apply(engine, result, OWNER, ctx)
    assert counts == {"created": 3, "exists": 2, "matched": 1, "refused": 0}
    assert set(engine.pages) == set(before) | dropped
    assert all(engine.pages[k] is before[k] for k in before)


def test_apply_stops_when_the_database_would_match_meetings_by_name(recurring, tmp_path):
    ctx, _ = make_context(tmp_path)
    engine = FakeEngine(knows_key_only=False)
    with pytest.raises(KbeError, match="0079"):
        pages.apply(engine, plan(recurring), OWNER, ctx)
    assert engine.calls[-1]["drawer"] == "meetings"
    assert sum(1 for p in engine.calls if p["drawer"] == "meetings") == 1


def test_an_import_with_no_meetings_needs_no_new_migration(tmp_path):
    root = tmp_path / "wiki"
    write(root, "concepts/Idea.md", "---\ntitle: Idea\ntype: concept\n---\nx\n")
    ctx, _ = make_context(tmp_path)
    counts = pages.apply(FakeEngine(knows_key_only=False), plan(root), OWNER, ctx)
    assert counts["created"] == 1
