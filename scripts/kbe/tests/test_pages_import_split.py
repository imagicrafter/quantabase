"""`kbe pages import`: a body over the database's limit is split into linked parts.

Nothing is ever cut: joining the parts' bodies without their link lines gives
the original back exactly.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from kbe import cli
from kbe.pages_import import Planned, load_drawers, part_key_for, plan
from kbe.pages_import_combine import MAX_BODY
from kbe.pages_import_split import (
    MAX_TITLE, PART_SIZE, join_parts, link_line, part_title, split_pages, split_text,
)
from kbe.tests.helpers import make_context

LINE = re.compile(r"^> Continued (?:from|in) \[\[([^\]|]+)\|([^\]]+)\]\]$")


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def numbered(count: int, width: int = 60) -> str:
    """`count` distinct lines, each `width` characters plus its newline."""
    return "".join(f"{i:08d} " + "x" * (width - 9) + "\n" for i in range(count))


# ── the split itself ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("text", [
    numbered(10),
    numbered(10).rstrip("\n"),                       # the last part ends with no newline
    numbered(10).replace("\n", "\r\n"),              # Windows line ends
    "short\n" + "y" * 250 + "\nend",                 # one line longer than a part
    "\n\n\nblank lines first\n\n\n",
    "café 東京 " * 30 + "\n" + "über\n" * 40,
])
def test_split_text_cuts_on_line_ends_and_loses_nothing(text):
    pieces = split_text(text, size=100)
    assert "".join(pieces) == text
    assert all(0 < len(p) <= 100 for p in pieces)
    # Every cut but those inside a line longer than a part is at a line end.
    for piece in pieces[:-1]:
        assert piece.endswith("\n") or len(piece) == 100


def test_split_text_keeps_a_short_text_whole():
    assert split_text("one\ntwo", size=100) == ("one\ntwo",)
    assert split_text("", size=100) == ("",)


def test_the_part_size_leaves_room_for_the_link_lines():
    longest = link_line("from", "k" * 200, "t" * MAX_TITLE) + "\n\n\n\n" + link_line("in", "k" * 200, "t" * MAX_TITLE)
    assert PART_SIZE + len(longest) <= MAX_BODY
    assert PART_SIZE < MAX_BODY


def test_part_titles_stay_within_the_title_limit():
    assert part_title("Weekly sync", 2) == "Weekly sync (part 2)"
    long = part_title("t" * MAX_TITLE, 12)
    assert len(long) == MAX_TITLE and long.endswith(" (part 12)")


def test_link_lines_name_the_key_and_show_a_safe_title():
    assert link_line("in", "meeting:x", "A [b] | c") == "> Continued in [[meeting:x|A b c]]"
    assert link_line("from", "concept:y", "Y") == "> Continued from [[concept:y|Y]]"


# ── a wiki import ────────────────────────────────────────────────────────────

def big_wiki(tmp_path: Path, lines: int = 7_000, tail: str = "the very end, no newline") -> tuple[Path, str]:
    root = tmp_path / "wiki"
    body = numbered(lines) + tail
    write(root, "concepts/Big.md", "---\ntitle: Big Idea\naliases: [Large]\ntags: [a, b]\n"
                                   "created: 2025-01-02\nupdated: 2025-03-04\n---\n" + body)
    write(root, "concepts/Small.md", "---\ntitle: Small\n---\nsee [[Big Idea]]\n")
    return root, body


def test_a_long_page_becomes_linked_parts_and_nothing_is_lost(tmp_path):
    root, body = big_wiki(tmp_path)
    assert len(body) > 2 * PART_SIZE
    result = plan(root, topics=["Ops"])
    parts = [p for p in result.pages if p.path.startswith("concepts/Big.md")]
    assert [p.path for p in parts] == ["concepts/Big.md", "concepts/Big.md (part 2)", "concepts/Big.md (part 3)"]
    assert join_parts([p.page["body"] for p in parts]) == body
    assert all(len(p.page["body"]) <= MAX_BODY for p in parts)
    assert result.splits == [("concepts/Big.md", 3)]
    assert not any("shortened" in n for p in result.pages for n in p.notes)


def test_part_one_keeps_the_page_and_the_others_share_dates_tags_and_topics(tmp_path):
    root, _ = big_wiki(tmp_path)
    one, two, three = [p.page for p in plan(root, topics=["ops"]).pages if p.path.startswith("concepts/Big.md")]
    assert one["key"] == "concept:big-idea" and one["title"] == "Big Idea" and one["aliases"] == ["Large"]
    assert (two["title"], three["title"]) == ("Big Idea (part 2)", "Big Idea (part 3)")
    assert (two["key"], three["key"]) == ("concept:big-idea-part-2", "concept:big-idea-part-3")
    for part in (two, three):
        assert part["drawer"] == "concepts" and part["aliases"] == []
        assert part["tags"] == ["a", "b"] and part["topics"] == ["ops"]
        assert part["created"] == one["created"] and part["updated"] == one["updated"]
        assert part["status"] == one["status"]


def test_each_part_links_to_the_next_and_back(tmp_path):
    root, _ = big_wiki(tmp_path)
    one, two, three = [p.page for p in plan(root).pages if p.path.startswith("concepts/Big.md")]

    def first(page):
        return LINE.match(page["body"].split("\n", 1)[0])

    def last(page):
        return LINE.match(page["body"].rsplit("\n", 1)[-1])

    assert first(one) is None and last(three) is None
    assert last(one).groups() == (two["key"], two["title"])
    assert first(two).groups() == (one["key"], one["title"])
    assert last(two).groups() == (three["key"], three["title"])
    assert first(three).groups() == (two["key"], two["title"])
    assert one["body"].endswith(f"\n\n> Continued in [[{two['key']}|Big Idea (part 2)]]")
    assert three["body"].startswith(f"> Continued from [[{two['key']}|Big Idea (part 2)]]\n\n")


def test_a_meeting_part_never_carries_the_meeting_id(tmp_path):
    root = tmp_path / "wiki"
    body = numbered(4_000)
    write(root, "meetings/call.md", "---\ntype: meeting\ntitle: Long Call\nfireflies_id: FF-9\n"
                                    "date: 2025-05-06\nattendees: [Pat]\n---\n" + body)
    one, two = plan(root).pages
    assert one.page["key"] == "meeting:ff-9"
    assert two.page["key"] == "meeting:2025-05-06-long-call-part-2"
    assert "ff-9" not in two.page["key"]
    assert two.page["sources"] == [{"source": "import", "source_id": "meetings/call.md"}]
    assert two.page["fields"] == {"date": "2025-05-06"}
    assert "attendees" not in two.page
    assert join_parts([one.page["body"], two.page["body"]]) == body


def test_a_person_part_carries_no_address_to_match_on(tmp_path):
    root = tmp_path / "wiki"
    write(root, "people/Pat.md", "---\ntype: person\ntitle: Pat\nemails: [p@x.com, q@x.com]\n---\n" + numbered(4_000))
    one, two = plan(root).pages
    assert one.page["key"] == "p@x.com" and one.page["fields"]["emails"] == ["q@x.com"]
    assert two.page["key"] == "person:pat-part-2"
    assert "emails" not in two.page["fields"]


def test_a_part_key_already_taken_gets_a_number(tmp_path):
    root, _ = big_wiki(tmp_path)
    write(root, "concepts/Other.md", "---\ntitle: Big Idea (part 2)\n---\nx\n")
    found = plan(root).pages
    keys = [p.page["key"] for p in found]
    assert "concept:big-idea-part-2" in keys and "concept:big-idea-part-2-2" in keys
    assert len(keys) == len(set(keys))
    titles = [p.page["title"].lower() for p in found]
    assert len(titles) == len(set(titles)), "a part never shares a name the database would match on"


def test_two_files_for_one_meeting_combine_then_split_without_loss(tmp_path):
    root = tmp_path / "wiki"
    old, new = numbered(2_600), numbered(2_600, width=61)
    write(root, "meetings/a.md", "---\ntype: meeting\ntitle: Kickoff\nmeeting_id: X9\nupdated: 2025-02-01\n---\n" + old)
    write(root, "meetings/b.md", "---\ntype: meeting\ntitle: Kickoff\nmeeting_id: X9\nupdated: 2025-03-01\n---\n" + new)
    result = plan(root)
    assert result.combined and result.splits == [("meetings/b.md", 2)]
    joined = join_parts([p.page["body"] for p in result.pages])
    assert old.strip() in joined and new.strip() in joined
    assert joined.startswith(new.rstrip())
    assert all(len(p.page["body"]) <= MAX_BODY for p in result.pages)


def test_a_map_merge_over_the_limit_is_split_not_cut(tmp_path):
    root = tmp_path / "wiki"
    write(root, "concepts/A.md", "---\ntitle: A\n---\n" + numbered(2_000))
    write(root, "concepts/B.md", "---\ntitle: B\n---\n" + numbered(2_000, width=70))
    the_map = tmp_path / "map.yaml"
    the_map.write_text('files:\n  "concepts/B.md":\n    merge_into: "concepts/A.md"\n', encoding="utf-8")
    result = plan(root, map_file=the_map)
    joined = join_parts([p.page["body"] for p in result.pages])
    assert numbered(2_000).strip() in joined and numbered(2_000, width=70).strip() in joined
    assert result.splits == [("concepts/A.md", 2)]


def test_dry_run_lists_each_split(tmp_path):
    root, _ = big_wiki(tmp_path)
    ctx, seen = make_context(tmp_path)
    assert cli.main(["pages", "import", str(root), "--owner", "o@example.com"], ctx) == 0
    text = "\n".join(seen)
    assert "Split into linked parts, nothing cut (1):" in text
    assert "  concepts/Big.md -> 3 parts" in text
    assert "shortened" not in text
    ctx, seen = make_context(tmp_path)
    assert cli.main(["pages", "import", str(root), "--owner", "o@example.com", "--json"], ctx) == 0
    assert json.loads(seen[0])["splits"] == [{"path": "concepts/Big.md", "parts": 3}]


def test_split_pages_with_a_small_limit(tmp_path):
    """The same split, small: what the backup fixture is made from."""
    root = tmp_path / "wiki"
    write(root, "concepts/S.md", "---\ntitle: S\n---\n" + numbered(5, width=20) + "tail")
    pages = plan(root).pages
    split, splits = split_pages(pages, part_key_for(load_drawers()), limit=50, size=45)
    assert splits == [("concepts/S.md", 3)]
    assert [p.page["key"] for p in split] == ["concept:s", "concept:s-part-2", "concept:s-part-3"]
    assert join_parts([p.page["body"] for p in split]) == numbered(5, width=20) + "tail"
    assert isinstance(split[0], Planned) and split[0].path == "concepts/S.md"
