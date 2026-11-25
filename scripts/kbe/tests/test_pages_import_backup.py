"""`kbe pages import --from-backup`: the nightly backup read back, page for page.

The Python half of the round trip. fixtures/backup_roundtrip/pages.json holds
the pages; vault/ is what the backup renderer writes for them (kept exact by
engine/tests/backup/roundtrip-fixture.test.ts). A restore of that vault must
give each owner's pages back: keys, identities, sources, fields, status,
related keys and bodies.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from kbe import cli, pages
from kbe.errors import KbeError
from kbe.pages_import import plan
from kbe.pages_import_backup import plan_backup
from kbe.tests.helpers import make_context

FIXTURE = Path(__file__).parent / "fixtures" / "backup_roundtrip"
VAULT = FIXTURE / "vault"
OWNER = "owner@example.com"
READER = "reader@example.com"


def source_pages(owner: str) -> dict[str, dict]:
    data = json.loads((FIXTURE / "pages.json").read_text(encoding="utf-8"))
    return {p["key"]: p for p in data["pages"] if p["owner"] == owner}


def restored(owner: str, **kw) -> dict[str, dict]:
    return {p.page["key"]: p.page for p in plan_backup(VAULT, owner=owner, keep_topics=True, **kw).pages}


@pytest.mark.parametrize("owner", [OWNER, READER])
def test_every_page_of_the_owner_comes_back_with_its_own_key(owner):
    assert set(restored(owner)) == set(source_pages(owner))


@pytest.mark.parametrize("owner", [OWNER, READER])
def test_page_content_round_trips(owner):
    back = restored(owner)
    for key, src in source_pages(owner).items():
        got = back[key]
        assert got["drawer"] == src["drawer"], key
        assert got["title"] == src["title"], key
        assert got["aliases"] == src["aliases"], key
        assert got["description"] == src["description"], key
        assert got["status"] == src["status"], key
        assert got["tags"] == src["tags"], key
        assert got["topics"] == src["topics"], key
        assert got["fields"] == src["fields"], key
        assert got["sources"] == src["sources"], key
        assert got["verified"] == src["verified"], key
        assert got.get("template") == src["template"], key
        assert got["body"] == src["body"], key
        assert sorted(got["related"]) == sorted(src["related"]), key
        assert got["created"][:10] == src["created_at"][:10], key
        assert got["updated"][:10] == src["updated_at"][:10], key
        if src["generated"]:
            assert got["generated"] == src["generated"], key


def test_identities_and_meeting_ids_survive():
    back = restored(OWNER)
    assert back["alex@example.com"]["fields"]["emails"] == ["alex@widgets.example"]
    assert back["widgets.example"]["fields"]["domains"] == ["widgets.co.example"]
    assert {"source": "fireflies", "source_id": "FF-ABC123"} in back["meeting:ff-abc123"]["sources"]
    assert "email" not in back["alex@example.com"]["fields"]
    assert "fireflies_id" not in back["meeting:ff-abc123"]["fields"]


def test_page_status_never_leaks_into_a_status_field():
    back = restored(OWNER)
    assert back["project:widget-rollout"]["status"] == "draft"
    assert back["project:widget-rollout"]["fields"]["status"] == "active"
    assert "status" not in back["alex@example.com"]["fields"]


def test_another_owners_pages_are_left_out_and_never_replace_the_owners():
    result = plan_backup(VAULT, owner=OWNER, keep_topics=True)
    skipped = dict(result.skipped)
    assert skipped["concepts/Idempotent Import (reader).md"] == f"another person's page ({READER})"
    assert skipped["people/Alex Tester (reader).md"] == f"another person's page ({READER})"
    mine = {p.page["key"]: p.page for p in result.pages}
    assert mine["concept:idempotent-import"]["body"].startswith("A second run changes nothing.")
    assert all(p.page.get("restore") is True for p in result.pages)


def test_topics_come_back_only_when_asked():
    plain = {p.page["key"]: p.page for p in plan_backup(VAULT, owner=OWNER).pages}
    assert all(p["topics"] == [] for p in plain.values())
    result = plan_backup(VAULT, owner=OWNER)
    assert result.dropped_keys["topics"] == 4
    assert result.dropped_keys["reviewed"] == 1
    chosen = {p.page["key"]: p.page for p in plan_backup(VAULT, owner=OWNER, topics=["Other"]).pages}
    assert all(p["topics"] == ["other"] for p in chosen.values())


def test_a_page_without_key_type_or_owner_is_skipped(tmp_path):
    vault = tmp_path / "v"
    shutil.copytree(VAULT, vault)
    (vault / "concepts" / "Loose.md").write_text("---\ntitle: Loose\ntype: concepts\n---\nx\n", encoding="utf-8")
    (vault / "concepts" / "Odd.md").write_text(
        f"---\ntitle: Odd\ntype: recipes\nkey: recipe:odd\nowner: {OWNER}\n---\nx\n", encoding="utf-8")
    skipped = dict(plan_backup(vault, owner=OWNER).skipped)
    assert skipped["concepts/Loose.md"] == "not a backup page: no key or owner"
    assert skipped["concepts/Odd.md"] == 'no drawer "recipes"'


def test_a_missing_folder_is_refused(tmp_path):
    with pytest.raises(KbeError, match="not a folder"):
        plan_backup(tmp_path / "nope", owner=OWNER)


def test_owner_match_ignores_case():
    assert restored("Owner@Example.COM") == restored(OWNER)


def test_a_plain_import_of_a_backup_folder_is_refused():
    with pytest.raises(KbeError, match="--from-backup"):
        plan(VAULT)


def test_cli_dry_run_and_flags(tmp_path):
    ctx, seen = make_context(tmp_path)
    assert cli.main(["pages", "import", str(VAULT), "--owner", OWNER, "--from-backup", "--keep-topics"], ctx) == 0
    text = "\n".join(seen)
    assert f"Would file 6 pages for {OWNER}; skip 2 files." in text
    assert "Topics: each page's own, from the backup" in text
    assert ctx.runner.calls == []
    ctx, _ = make_context(tmp_path)
    assert cli.main(["pages", "import", str(VAULT), "--owner", OWNER, "--keep-topics"], ctx) == 2
    ctx, _ = make_context(tmp_path)
    assert cli.main(["pages", "import", str(VAULT), "--owner", OWNER, "--from-backup",
                     "--map", str(tmp_path / "m.yaml")], ctx) == 2


class Store:
    def __init__(self, restore_flag=True):
        self.calls, self.restore_flag = [], restore_flag

    def call(self, function, args=None):
        self.calls.append((function, args))
        answer = {"status": "created", "key": args["p_page"]["key"]}
        return {**answer, "restore": True} if self.restore_flag else answer


def test_apply_sends_restore_pages_people_first(tmp_path):
    ctx, _ = make_context(tmp_path)
    store = Store()
    counts = pages.apply(store, plan_backup(VAULT, owner=OWNER), OWNER, ctx, restore=True)
    assert counts["created"] == 6
    sent = [args["p_page"] for _, args in store.calls]
    assert sent[0]["drawer"] == "people" and sent[1]["drawer"] == "organisations"
    assert all(p["restore"] is True for p in sent)


def test_apply_stops_when_the_database_is_too_old_to_restore(tmp_path):
    ctx, _ = make_context(tmp_path)
    store = Store(restore_flag=False)
    with pytest.raises(KbeError, match="0078"):
        pages.apply(store, plan_backup(VAULT, owner=OWNER), OWNER, ctx, restore=True)
    assert len(store.calls) == 1
