"""`kbe pages import`: plan an existing wiki as pages, report, then apply after a yes."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kbe import cli, pages
from kbe.errors import KbeError
from kbe.pages_import import derive_key, load_drawers, plan, slug, split_frontmatter
from kbe.tests.helpers import make_context

DB_LINE = "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n"


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "wiki"
    write(root, "people/Ann Lee.md", """---
title: Ann Lee
aliases:
  - Ann
type: person
email: Ann@Acme.com
role: CFO
tags: [client, "#finance"]
related: ["[[Acme]]", "[[Website rebuild|site]]"]
created: 2026-01-02
---
## Summary

Works at [[Acme]].
""")
    write(root, "people/Bob.md", "---\ntype: person\n---\nNo email here.\n")
    write(root, "projects/Acme.md", """---
title: Acme
type: company
website: https://www.acme.com/about
description: A client
status: current
---
Body.
""")
    write(root, "projects/Website rebuild.md", "---\ntype: project\nstatus: active\nnext_step: Launch\n---\nScope.\n")
    write(root, "meetings/2026-01-05-kickoff.md", """---
title: Kickoff
type: meeting
date: 2026-01-05
fireflies_id: "AbC123"
duration_minutes: 30
attendees: [Ann]
---
Notes.
""")
    write(root, "meetings/2026-01-06-same.md", "---\ntitle: Kickoff again\ntype: meeting\nfireflies_id: abc123\n---\nx\n")
    write(root, "meetings/no-id.md", "---\ntitle: Chat\ntype: meeting\ndate: 2026-02-01\n---\nx\n")
    write(root, "concepts/Retro.md", "---\ntype: retrospective\n---\nLessons.\n")
    write(root, "misc/Odd.md", "---\ntype: recipe\n---\nx\n")
    write(root, "concepts/Bad.md", "---\ntitle: [unclosed\n---\nx\n")
    write(root, "notes/Plain.md", "Just text, no frontmatter.\n")
    write(root, "index.md", "# index\n")
    write(root, "log.md", "# log\n")
    write(root, "templates/Person.md", "---\ntype: person\n---\n")
    write(root, ".obsidian/x.md", "---\ntype: person\n---\n")
    write(root, "sources/raw.md", "raw\n")
    return root


def by_path(result):
    return {p.path: p for p in result.pages}


def test_templates_give_every_drawer_and_its_key_rule():
    drawers = load_drawers()
    assert drawers["people"].key_kind == "email"
    assert drawers["organisations"].key_kind == "domain"
    assert drawers["meetings"].key_kind == "source_id"
    assert drawers["projects"].prefix == "project"
    assert drawers["playbooks"].prefix == "playbook"
    assert "deals" in drawers and "properties" in drawers


def test_plan_maps_type_and_folder_to_drawers_and_skips_the_rest(vault):
    result = plan(vault)
    found = by_path(result)
    assert set(found) == {
        "people/Ann Lee.md", "people/Bob.md", "projects/Acme.md", "projects/Website rebuild.md",
        "meetings/2026-01-05-kickoff.md", "meetings/no-id.md", "concepts/Retro.md",
    }
    assert found["projects/Acme.md"].page["drawer"] == "organisations"  # type wins over folder
    assert found["concepts/Retro.md"].page["drawer"] == "playbooks"
    skipped = dict(result.skipped)
    assert skipped["misc/Odd.md"] == 'no drawer for type "recipe"'
    assert skipped["concepts/Bad.md"] == "the frontmatter is not valid YAML"
    assert skipped["notes/Plain.md"] == 'no drawer for type "notes"'
    assert "meetings/2026-01-06-same.md" not in skipped
    assert result.combined[0][:2] == ("meetings/2026-01-06-same.md", "meetings/2026-01-05-kickoff.md")
    assert not any(p.startswith(("templates/", ".obsidian/", "sources/")) or p in ("index.md", "log.md")
                   for p in list(found) + list(skipped))
    assert result.by_drawer() == {"meetings": 2, "organisations": 1, "people": 2, "playbooks": 1, "projects": 1}


def test_keys_follow_the_template_rules_with_reported_fallbacks(vault):
    found = by_path(plan(vault))
    assert found["people/Ann Lee.md"].page["key"] == "ann@acme.com"
    assert found["people/Bob.md"].page["key"] == "person:bob"
    assert "no email" in found["people/Bob.md"].notes[0]
    assert found["projects/Acme.md"].page["key"] == "acme.com"
    assert found["projects/Website rebuild.md"].page["key"] == "project:website-rebuild"
    assert found["meetings/2026-01-05-kickoff.md"].page["key"] == "meeting:abc123"
    assert found["meetings/no-id.md"].page["key"] == "meeting:2026-02-01-chat"
    assert found["concepts/Retro.md"].page["key"] == "playbook:retro"


def test_header_fields_links_and_body(vault):
    ann = by_path(plan(vault, topics=["Clients"]))["people/Ann Lee.md"].page
    assert ann["title"] == "Ann Lee"
    assert ann["aliases"] == ["Ann"]
    assert ann["tags"] == ["client", "finance"]
    assert ann["related"] == ["Acme", "Website rebuild"]
    assert ann["fields"] == {"role": "CFO"}
    assert ann["topics"] == ["clients"]
    assert ann["status"] == "unreviewed"
    assert ann["sources"][0] == {"source": "import", "source_id": "people/Ann Lee.md"}
    assert ann["body"].startswith("## Summary")
    assert "[[Acme]]" in ann["body"]
    acme = by_path(plan(vault))["projects/Acme.md"].page
    assert acme["status"] == "current" and acme["description"] == "A client"
    assert acme["topics"] == []
    site = by_path(plan(vault))["projects/Website rebuild.md"].page
    assert site["fields"] == {"status": "active", "next_step": "Launch"}
    meeting = by_path(plan(vault))["meetings/2026-01-05-kickoff.md"].page
    assert meeting["fields"] == {"date": "2026-01-05"}


def test_dropped_frontmatter_keys_are_counted(vault):
    result = plan(vault)
    assert result.dropped_keys["duration_minutes"] == 1
    assert "created" not in result.dropped_keys and "attendees" not in result.dropped_keys
    assert "fireflies_id" not in result.dropped_keys
    assert "role" not in result.dropped_keys


def test_small_parts():
    assert slug("Laurie's  Email!") == "laurie-s-email"
    assert split_frontmatter("no header") == ({}, "no header", None)
    assert split_frontmatter("---\n- a\n---\nx")[2] == "the frontmatter is not a mapping"
    drawers = load_drawers()
    assert derive_key(drawers["organisations"], {"domain": "WWW.Example.org"}, "X") == ("example.org", None)
    assert derive_key(drawers["people"], {"emails": ["bad", "a@b.co"]}, "X") == ("a@b.co", None)


def test_dry_run_reports_and_touches_nothing(vault, tmp_path):
    ctx, seen = make_context(tmp_path)
    assert cli.main(["pages", "import", str(vault), "--owner", "Owner@Example.com"], ctx) == 0
    text = "\n".join(seen)
    assert "Would file 7 pages for owner@example.com; skip 3 files." in text
    assert "Topics: none (pages stay the owner's alone)" in text
    assert "Dry run: nothing was saved." in text
    assert ctx.runner.calls == []


def test_json_plan(vault, tmp_path):
    ctx, seen = make_context(tmp_path)
    cli.main(["pages", "import", str(vault), "--owner", "o@example.com", "--json"], ctx)
    data = json.loads(seen[0])
    assert {p["key"] for p in data["pages"]} >= {"ann@acme.com", "acme.com"}
    assert any(s["path"] == "misc/Odd.md" for s in data["skipped"])


def test_owner_must_be_an_email(vault, tmp_path):
    ctx, _ = make_context(tmp_path)
    assert cli.main(["pages", "import", str(vault), "--owner", "nobody"], ctx) == 2


def test_apply_needs_a_yes(vault, tmp_path):
    ctx, _ = make_context(tmp_path)
    (tmp_path / "local.env").write_text(DB_LINE)
    assert cli.main(["pages", "import", str(vault), "--owner", "o@example.com", "--apply"], ctx) == 1
    assert ctx.runner.calls == []


class Store:
    def __init__(self, existing=(), refuse=(), matched=None):
        self.calls, self.existing, self.refuse = [], set(existing), set(refuse)
        self.matched = dict(matched or {})

    def call(self, function, args=None):
        self.calls.append((function, args))
        key = args["p_page"]["key"]
        flag = {"key_only": bool(args["p_page"].get("key_only"))}  # a 0079 database
        if key in self.refuse:
            raise KbeError("The database refused workspace.page_import:\nERROR:  a page can only be filed under topics you hold")
        if key in self.matched:
            return {"status": "matched", "key": self.matched[key], "how": "name", "proposed": key, **flag}
        return {"status": "exists" if key in self.existing else "created", "key": key, **flag}


def test_apply_saves_each_page_and_counts(vault, tmp_path):
    ctx, seen = make_context(tmp_path)
    store = Store(existing={"acme.com"}, refuse={"person:bob"})
    counts = pages.apply(store, plan(vault), "o@example.com", ctx)
    assert counts == {"created": 5, "exists": 1, "matched": 0, "refused": 1}
    assert all(fn == "page_import" and args["p_owner_email"] == "o@example.com" for fn, args in store.calls)
    assert any("refused people/Bob.md: ERROR:  a page can only be filed under topics you hold" in line for line in seen)


def test_apply_goes_through_the_direct_connection(vault, tmp_path, monkeypatch):
    ctx, seen = make_context(tmp_path, confirm=lambda _q: True)
    (tmp_path / "local.env").write_text(DB_LINE)
    store = Store()
    monkeypatch.setattr(pages, "_store", lambda _ctx: store)
    assert cli.main(["pages", "import", str(vault), "--owner", "o@example.com", "--apply"], ctx) == 0
    assert len(store.calls) == 7
    assert "Done: 7 created, 0 already there (left alone), 0 matched an existing page (left alone), 0 refused." in seen[-1]


def test_db_store_sends_the_page_as_bound_json(tmp_path):
    from kbe import config_store, pg
    from kbe.tests.helpers import FakeRunner
    from kbe import proc

    runner = FakeRunner({"": proc.ProcResult(0, '{"status": "created", "key": "x"}', "")})
    store = config_store.DbStore(pg.connect({"KBE_DATABASE_URL": "postgresql://u:p@h/db"}, runner), role=None)
    page = {"key": "x", "drawer": "concepts", "title": "It's $1 ; drop", "body": "$$ quote"}
    assert store.call("page_import", {"p_owner_email": "o@example.com", "p_page": page}) == {"status": "created", "key": "x"}
    sql = runner.calls[-1]["stdin"]
    assert "workspace.page_import(p_owner_email => 'o@example.com', p_page => $kbe_" in sql
    assert "::jsonb" in sql


def test_apply_reports_pages_that_match_an_existing_page(vault, tmp_path):
    """The database matches by key, known address/domain and name (0067): never a second page."""
    ctx, seen = make_context(tmp_path)
    store = Store(matched={"person:bob": "bob@acme.com"})
    counts = pages.apply(store, plan(vault), "o@example.com", ctx)
    assert counts["matched"] == 1 and counts["created"] == 6
    assert any("matched people/Bob.md: person:bob is your page bob@acme.com (name)" in line for line in seen)


def test_other_addresses_and_domains_become_identities(tmp_path):
    root = tmp_path / "wiki"
    write(root, "people/Pat.md", "---\ntype: person\nemails: [pat@acme.com, Pat.R@Gmail.com, bad]\n---\nx\n")
    write(root, "organisations/Acme.md", "---\ntype: company\nwebsite: [https://acme.com, acme-corp.com]\n---\nx\n")
    found = by_path(plan(root))
    assert found["people/Pat.md"].page["key"] == "pat@acme.com"
    assert found["people/Pat.md"].page["fields"]["emails"] == ["pat.r@gmail.com"]
    assert found["organisations/Acme.md"].page["fields"]["domains"] == ["acme-corp.com"]


def test_source_entries_that_are_objects_stay_objects(tmp_path):
    root = tmp_path / "w"
    write(root, "concepts/Idea.md", """---
type: concept
sources:
  - source: drive
    source_id: doc-1
  - plain-text-source
---
x
""")
    page = plan(root).pages[0].page
    assert page["sources"] == [
        {"source": "import", "source_id": "concepts/Idea.md"},
        {"source": "drive", "source_id": "doc-1"},
        {"source": "import", "source_id": "plain-text-source"},
    ]


def test_a_page_status_is_not_also_a_status_field(tmp_path):
    root = tmp_path / "w"
    write(root, "projects/A.md", "---\ntype: project\nstatus: current\n---\nx\n")
    write(root, "projects/B.md", "---\ntype: project\nstatus: paused\n---\nx\n")
    write(root, "projects/C.md", "---\ntype: project\nstatus: current\nfield_status: done\n---\nx\n")
    found = by_path(plan(root))
    assert found["projects/A.md"].page["status"] == "current"
    assert "status" not in found["projects/A.md"].page["fields"]
    assert found["projects/B.md"].page["fields"] == {"status": "paused"}
    assert found["projects/C.md"].page["fields"] == {"status": "done"}
