"""`kbe pages import`: dates, attendees, the --map file, long files, one meeting in two files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kbe import cli, pages
from kbe.errors import KbeError
from kbe.pages_import import MAX_BODY, plan
from kbe.tests.helpers import make_context


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def by_path(result):
    return {p.path: p for p in result.pages}


def by_key(result):
    return {p.page["key"]: p for p in result.pages}


# ── dates ────────────────────────────────────────────────────────────────────

def test_created_and_updated_are_kept_in_utc(tmp_path):
    root = tmp_path / "wiki"
    write(root, "concepts/A.md", "---\ncreated: 2024-03-01\nupdated: 2025-01-15T10:00:00+02:00\n---\nx\n")
    write(root, "concepts/B.md", "---\ntimestamp: '2023-06-01T08:30:00Z'\n---\nx\n")
    write(root, "concepts/C.md", "---\ncreated: 2999-01-01\nupdated: not a date\n---\nx\n")
    write(root, "concepts/D.md", "---\ncreated: 2025-05-01\nupdated: 2025-04-01\n---\nx\n")
    found = by_path(plan(root))
    write(root, "concepts/E.md", "---\nupdated: 2025-04-01\n---\nx\n")
    e = by_path(plan(root))["concepts/E.md"].page
    assert e["created"] == e["updated"] == "2025-04-01T00:00:00+00:00"
    a = found["concepts/A.md"].page
    assert a["created"] == "2024-03-01T00:00:00+00:00"
    assert a["updated"] == "2025-01-15T08:00:00+00:00"
    b = found["concepts/B.md"].page
    assert b["created"] == b["updated"] == "2023-06-01T08:30:00+00:00"
    c = found["concepts/C.md"]
    assert "created" not in c.page and "updated" not in c.page
    assert "created date is in the future: not kept" in c.notes
    d = found["concepts/D.md"]
    assert d.page["updated"] == d.page["created"] == "2025-05-01T00:00:00+00:00"
    assert any("later than updated" in n for n in d.notes)


def test_dry_run_counts_dated_pages(tmp_path):
    root = tmp_path / "wiki"
    write(root, "concepts/A.md", "---\nupdated: 2024-03-01\n---\nx\n")
    write(root, "concepts/B.md", "---\ntitle: B\n---\nx\n")
    ctx, seen = make_context(tmp_path)
    cli.main(["pages", "import", str(root), "--owner", "o@example.com"], ctx)
    assert "Dates: 1 pages keep their created/updated dates; the rest are dated today." in seen


# ── attendees ────────────────────────────────────────────────────────────────

@pytest.fixture
def meeting_vault(tmp_path: Path) -> Path:
    root = tmp_path / "wiki"
    write(root, "people/Ann Lee.md", "---\ntype: person\nemail: ann@acme.com\nemails: [ann@acme.com, a.lee@mail.example]\n---\nx\n")
    write(root, "people/Sam.md", "---\ntype: person\ntitle: Sam Ortiz\naliases: [Sammy]\n---\nx\n")
    write(root, "people/Jo A.md", "---\ntype: person\naliases: [Jo]\n---\nx\n")
    write(root, "people/Jo B.md", "---\ntype: person\naliases: [Jo]\n---\nx\n")
    write(root, "meetings/m.md", """---
type: meeting
fireflies_id: M1
attendees: ["A.Lee@mail.example", "[[Sammy]]", Jo, owner@example.com, Sammy]
---
Notes.
""")
    write(root, "meetings/n.md", "---\ntype: meeting\nfireflies_id: M2\nattendees: 'Ann Lee; Zed'\n---\nx\n")
    return root


def test_attendees_in_the_import_become_links(meeting_vault):
    result = plan(meeting_vault)
    m = by_key(result)["meeting:m1"].page
    assert m["related"] == ["ann@acme.com", "person:sam-ortiz"]
    assert m["attendees"] == ["Jo", "owner@example.com"]  # ambiguous name; no page: for the database
    n = by_key(result)["meeting:m2"].page
    assert n["related"] == ["ann@acme.com"] and n["attendees"] == ["Zed"]
    assert ("meetings/m.md", "Jo", "") in result.attendees
    assert ("meetings/m.md", "A.Lee@mail.example", "ann@acme.com") in result.attendees
    assert not any(p.page["drawer"] == "people" and "owner" in p.page["key"] for p in result.pages)


def test_attendees_report_and_json(meeting_vault, tmp_path):
    ctx, seen = make_context(tmp_path)
    cli.main(["pages", "import", str(meeting_vault), "--owner", "o@example.com"], ctx)
    line = next(s for s in seen if s.startswith("Meeting attendees:"))
    assert line.startswith("Meeting attendees: 3 link to a person page in this import; 3 are looked up")
    ctx, seen = make_context(tmp_path)
    cli.main(["pages", "import", str(meeting_vault), "--owner", "o@example.com", "--json"], ctx)
    data = json.loads(seen[0])
    assert {"path": "meetings/n.md", "attendee": "Zed", "links_to": None} in data["attendees"]


class Store:
    def __init__(self, matched=None):
        self.calls, self.matched = [], dict(matched or {})

    def call(self, function, args=None):
        self.calls.append(args["p_page"])
        key = args["p_page"]["key"]
        flag = {"key_only": bool(args["p_page"].get("key_only"))}  # a 0079 database
        if key in self.matched:
            return {"status": "matched", "key": self.matched[key], "how": "name", **flag}
        return {"status": "created", "key": key, **flag}


def test_apply_saves_people_first_and_follows_matched_pages(meeting_vault, tmp_path):
    ctx, _ = make_context(tmp_path)
    store = Store(matched={"person:sam-ortiz": "sam@ortiz.example"})
    pages.apply(store, plan(meeting_vault), "o@example.com", ctx)
    drawers = [p["drawer"] for p in store.calls]
    assert drawers == sorted(drawers, key=lambda d: d != "people")
    meeting = next(p for p in store.calls if p["key"] == "meeting:m1")
    assert meeting["related"] == ["ann@acme.com", "sam@ortiz.example"]
    assert meeting["attendees"] == ["Jo", "owner@example.com"]


# ── one meeting in two files; long files ─────────────────────────────────────

def test_two_files_for_one_meeting_keep_the_newer_with_a_note(tmp_path):
    root = tmp_path / "wiki"
    write(root, "meetings/a.md", "---\ntitle: Kickoff (draft)\ntype: meeting\nfireflies_id: X9\n"
                                 "updated: 2025-02-01\ntags: [a]\n---\nOld notes.\n")
    write(root, "meetings/b.md", "---\ntitle: Kickoff\ntype: meeting\nfireflies_id: x9\n"
                                 "updated: 2025-03-01\ntags: [b]\n---\nNew notes.\n")
    result = plan(root)
    assert result.skipped == []
    [page] = result.pages
    assert page.path == "meetings/b.md" and page.merged == ("meetings/a.md",)
    body = page.page["body"]
    assert body.startswith("New notes.")
    assert "## Note: Kickoff (draft)\n\n_From `meetings/a.md`, 2025-02-01._\n\nOld notes." in body
    assert page.page["tags"] == ["b", "a"] and page.page["created"] == "2025-02-01T00:00:00+00:00"
    assert {"source": "import", "source_id": "meetings/a.md"} in page.page["sources"]
    assert result.combined == [("meetings/a.md", "meetings/b.md", "same meeting id meeting:x9: a note on the newer page")]


def test_a_repeated_key_that_is_not_a_meeting_is_still_skipped(tmp_path):
    root = tmp_path / "wiki"
    write(root, "people/A.md", "---\ntype: person\nemail: a@x.com\n---\nx\n")
    write(root, "people/B.md", "---\ntype: person\nemail: a@x.com\n---\nx\n")
    assert plan(root).skipped == [("people/B.md", "same key a@x.com as people/A.md")]


def test_long_files_are_split_not_shortened(tmp_path):
    root = tmp_path / "wiki"
    write(root, "concepts/Big.md", "---\ntitle: Big\n---\n" + "word " * 50_000)
    one, two = plan(root).pages
    assert one.page["key"] == "concept:big" and two.page["key"] == "concept:big-part-2"
    assert all(len(p.page["body"]) <= MAX_BODY for p in (one, two))
    assert not any("shortened" in n for p in (one, two) for n in p.notes)


# ── frontmatter carried over ─────────────────────────────────────────────────

def test_summary_fireflies_id_and_field_aliases(tmp_path):
    root = tmp_path / "wiki"
    write(root, "meetings/m.md", "---\ntype: meeting\nfireflies_id: F1\nsummary: Short.\n"
                                 "company: Acme\nduration_minutes: 45\n---\nx\n")
    result = plan(root)
    page = result.pages[0].page
    assert page["description"] == "Short."
    assert page["fields"] == {"organisation": "Acme"}
    assert {"source": "fireflies", "source_id": "F1"} in page["sources"]
    assert result.dropped_keys == {"duration_minutes": 1}


# ── --map ────────────────────────────────────────────────────────────────────

@pytest.fixture
def map_vault(tmp_path: Path) -> Path:
    root = tmp_path / "wiki"
    write(root, "projects/Acme.md", "---\ntitle: Acme\ntype: project\nwebsite: acme-old.com\n"
                                    "created: 2023-01-01\n---\nAcme body.\n")
    write(root, "concepts/Acme notes.md", "---\ntitle: Acme notes\nupdated: 2025-06-01\n"
                                          "tags: [acme]\n---\nMore about Acme.\n")
    write(root, "concepts/Acme history.md", "---\ntitle: Acme history\n---\nFounded long ago.\n")
    write(root, "misc/Globex.md", "---\ntype: recipe\n---\nGlobex.\n")
    return root


MAP = """files:
  projects/Acme.md:
    drawer: organisations
    key: Acme.com
    aliases: [Acme Corp]
  ./concepts/Acme notes.md:
    merge_into: projects/Acme.md
  concepts/Acme history.md:
    merge_into: projects/Acme.md
  misc/Globex.md:
    drawer: organisations
    key: globex.com
create:
  - name: Initech
    domain: initech.example
    aliases: [Initech Inc]
  - name: Globex again
    domain: globex.com
"""


def test_map_refiles_merges_and_creates(map_vault, tmp_path):
    (tmp_path / "map.yaml").write_text(MAP)
    result = plan(map_vault, map_file=tmp_path / "map.yaml")
    found = by_key(result)
    acme = found["acme.com"]
    assert acme.page["drawer"] == "organisations"
    assert acme.page["aliases"] == ["Acme Corp", "Acme history", "Acme notes"]
    assert acme.page["fields"]["domains"] == ["acme-old.com"]
    assert acme.merged == ("concepts/Acme history.md", "concepts/Acme notes.md")
    body = acme.page["body"]
    assert body.startswith("## Acme\n\n_From `projects/Acme.md`._\n\nAcme body.")
    assert "## Acme history\n\n_From `concepts/Acme history.md`._\n\nFounded long ago." in body
    assert "## Acme notes\n\n_From `concepts/Acme notes.md`, 2025-06-01._\n\nMore about Acme." in body
    assert body.count("## Acme\n") == 1
    assert acme.page["created"] == "2023-01-01T00:00:00+00:00"
    assert acme.page["updated"] == "2025-06-01T00:00:00+00:00"
    assert acme.page["tags"] == ["acme"]
    assert found["globex.com"].path == "misc/Globex.md"
    stub = found["initech.example"]
    assert stub.page["title"] == "Initech" and stub.page["aliases"] == ["Initech Inc"]
    assert stub.page["drawer"] == "organisations" and stub.page["body"] == ""
    assert ("(map) Globex again", "same key globex.com as misc/Globex.md") in result.skipped
    assert len(result.combined) == 2


def test_dry_run_shows_the_map(map_vault, tmp_path):
    (tmp_path / "map.yaml").write_text(MAP)
    ctx, seen = make_context(tmp_path)
    cli.main(["pages", "import", str(map_vault), "--owner", "o@example.com",
              "--map", str(tmp_path / "map.yaml")], ctx)
    text = "\n".join(seen)
    assert "Map:\n  concepts/Acme history.md -> merged into projects/Acme.md" in text
    assert "  projects/Acme.md -> organisations acme.com (aliases: Acme Corp)" in text
    assert "  create organisations initech.example: Initech (aliases: Initech Inc)" in text
    assert "  concepts/Acme notes.md -> projects/Acme.md (merged by the map)" in text
    assert ctx.runner.calls == []


def test_merge_into_a_file_that_is_not_imported_is_skipped(map_vault, tmp_path):
    (tmp_path / "map.yaml").write_text("files:\n  concepts/Acme notes.md:\n    merge_into: misc/Globex.md\n")
    result = plan(map_vault, map_file=tmp_path / "map.yaml")
    assert ("concepts/Acme notes.md", "merge_into misc/Globex.md is not imported") in result.skipped


@pytest.mark.parametrize("text, problem", [
    ("files:\n  nope.md:\n    drawer: organisations\n", "nope.md: no such Markdown file"),
    ("files:\n  projects/Acme.md:\n    drawer: organisations\n    key: not a domain\n", "must be a web domain"),
    ("files:\n  projects/Acme.md:\n    drawer: shelves\n", "no drawer 'shelves'"),
    ("files:\n  projects/Acme.md:\n    colour: red\n", "use only drawer, key, aliases, merge_into (not colour)"),
    ("files:\n  projects/Acme.md:\n    merge_into: projects/Acme.md\n", "cannot merge into itself"),
    ("files:\n  concepts/Acme notes.md:\n    merge_into: concepts/Acme history.md\n"
     "  concepts/Acme history.md:\n    merge_into: projects/Acme.md\n", "is itself merged into another page"),
    ("files:\n  concepts/Acme notes.md:\n    merge_into: projects/Acme.md\n    key: x.com\n",
     "merge_into takes no drawer or key"),
    ("create:\n  - name: X\n", "needs a domain"),
    ("create:\n  - domain: x.com\n", "needs a name"),
    ("create: {}\n", "create: must be a list"),
    ("pages: []\n", "must have only `files:` and `create:`"),
    ("files: [\n", "not valid YAML"),
])
def test_map_problems_are_listed(map_vault, tmp_path, text, problem):
    (tmp_path / "map.yaml").write_text(text)
    with pytest.raises(KbeError, match=None) as caught:
        plan(map_vault, map_file=tmp_path / "map.yaml")
    assert problem in str(caught.value)


def test_map_file_must_be_readable(map_vault, tmp_path):
    with pytest.raises(KbeError, match="Could not read the map file"):
        plan(map_vault, map_file=tmp_path / "missing.yaml")
