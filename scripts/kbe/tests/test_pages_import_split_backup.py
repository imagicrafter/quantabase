"""Split parts through the nightly backup and back with `--from-backup`.

fixtures/backup_split/pages.json holds one meeting split into three linked
parts (made by the splitter, checked below) plus another person's page whose
title clashes with part 2, so the backup names that part's file
"Long Call (part 2) (owner)". vault/ is what the backup renderer writes for
them (kept exact by engine/tests/backup/roundtrip-fixture.test.ts). A restore
must give the same parts back: keys, titles and bodies, link lines included.
"""

from __future__ import annotations

import json
from pathlib import Path

from kbe.pages_import import load_drawers, part_key_for, plan
from kbe.pages_import_backup import plan_backup
from kbe.pages_import_split import join_parts, split_pages

FIXTURE = Path(__file__).parent / "fixtures" / "backup_split"
VAULT = FIXTURE / "vault"
OWNER = "owner@example.com"
ORIGINAL = "".join(f"{i:08d} " + "x" * 11 + "\n" for i in range(6)) + "the end, no newline"
WIKI_FILE = ("---\ntype: meeting\ntitle: Long Call\nfireflies_id: FF-LONG\ndate: 2026-11-03\n"
             "created: 2026-11-03\nupdated: 2026-11-04\n---\n" + ORIGINAL)


def fixture_parts() -> list[dict]:
    data = json.loads((FIXTURE / "pages.json").read_text(encoding="utf-8"))
    return [p for p in data["pages"] if p["owner"] == OWNER]


def test_the_fixture_is_what_the_splitter_makes(tmp_path):
    root = tmp_path / "wiki"
    (root / "meetings").mkdir(parents=True)
    (root / "meetings" / "call.md").write_text(WIKI_FILE, encoding="utf-8")
    made, splits = split_pages(plan(root).pages, part_key_for(load_drawers()), limit=100, size=65)
    assert splits == [("meetings/call.md", 3)]
    want = [(p["key"], p["title"], p["body"]) for p in fixture_parts()]
    assert [(p.page["key"], p.page["title"], p.page["body"]) for p in made] == want


def test_a_restored_backup_gives_the_same_parts_back():
    result = plan_backup(VAULT, owner=OWNER, keep_topics=True)
    back = {p.page["key"]: p.page for p in result.pages}
    parts = fixture_parts()
    assert set(back) == {p["key"] for p in parts}
    for src in parts:
        got = back[src["key"]]
        assert (got["title"], got["body"]) == (src["title"], src["body"]), src["key"]
        assert got["tags"] == src["tags"] and got["topics"] == src["topics"], src["key"]
    assert join_parts([back[p["key"]]["body"] for p in parts]) == ORIGINAL
    assert result.splits == []


def test_the_backup_names_a_clashing_part_differently_and_the_restore_still_links_it():
    text = (VAULT / "meetings" / "Long Call (part 3).md").read_text(encoding="utf-8")
    assert "> Continued from [[Long Call (part 2) (owner)|Long Call (part 2)]]" in text
    back = {p.page["key"]: p.page for p in plan_backup(VAULT, owner=OWNER).pages}
    assert back["meeting:2026-11-03-long-call-part-3"]["body"].startswith(
        "> Continued from [[meeting:2026-11-03-long-call-part-2|Long Call (part 2)]]\n\n")
