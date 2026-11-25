"""The wiki puller applies the config from the knowledge repo when it changed."""

from __future__ import annotations

import argparse
import copy
from pathlib import Path

import pytest
import yaml

from knowledge import engine_config
from knowledge.config_hash import config_hash
from pullers import config_sync, wiki

EXAMPLE = Path(__file__).resolve().parent.parent / "config" / "engine.example.yaml"


class FakeDb:
    """Stands in for the database: one applied config, and an issue log."""

    def __init__(self, applied=None, refuse=None, broken_issues=False):
        self.applied, self.refuse, self.broken_issues = applied, refuse, broken_issues
        self.calls, self._pending = [], None

    def schema(self, _name):
        return self

    def rpc(self, name, args=None):
        self._pending = (name, dict(args or {}))
        return self

    def execute(self):
        name, args = self._pending
        self.calls.append((name, args))
        if name.startswith("issue_") and self.broken_issues:
            raise RuntimeError("issue log is down")
        if name == "engine_config_get":
            return argparse.Namespace(data=self.applied)
        if name == "engine_config_apply":
            if self.refuse:
                raise self.refuse
            self.applied = args["p_config"]
        return argparse.Namespace(data=None)

    def named(self, name):
        return [args for called, args in self.calls if called == name]


@pytest.fixture(autouse=True)
def published(monkeypatch):
    """The temp checkouts are not git repos; treat their file as pushed."""
    monkeypatch.setattr(config_sync.knowledge_repo, "on_main", lambda _root, _path: True)


@pytest.fixture
def raw():
    return yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))


@pytest.fixture
def checkout(tmp_path, raw):
    def build(config=raw, text=None):
        folder = tmp_path / ".kb-engine"
        folder.mkdir(exist_ok=True)
        (folder / "engine.yaml").write_text(
            text if text is not None else yaml.safe_dump(config), encoding="utf-8")
        return tmp_path
    return build


def test_no_config_file_does_nothing(tmp_path):
    sb = FakeDb()
    assert config_sync.apply_from_checkout(tmp_path, sb) == config_sync.ABSENT
    assert sb.calls == []


def test_a_new_config_is_applied_with_the_shared_hash(checkout, raw):
    sb = FakeDb(applied=None)
    assert config_sync.apply_from_checkout(checkout(), sb) == config_sync.APPLIED
    assert sb.named("engine_config_apply") == [{"p_config": raw, "p_hash": config_hash(raw)}]
    assert sb.named("issue_close_by_key")[0]["p_dedupe_key"] == "config"
    assert sb.named("issue_upsert") == []


def test_a_changed_config_is_applied_and_used_for_the_rest_of_the_run(checkout, raw):
    changed = copy.deepcopy(raw)
    changed["domains"].append({"id": "research", "label": "Research"})
    sb = FakeDb(applied=raw)
    assert config_sync.apply_from_checkout(checkout(changed), sb) == config_sync.APPLIED
    assert sb.applied == changed
    assert "research" in engine_config.get_config().domain_ids


def test_a_file_override_keeps_the_process_config(checkout, raw, monkeypatch):
    changed = copy.deepcopy(raw)
    changed["domains"].append({"id": "research", "label": "Research"})
    monkeypatch.setenv(engine_config.CONFIG_ENV_VAR, str(EXAMPLE))
    assert config_sync.apply_from_checkout(checkout(changed), FakeDb(raw)) == config_sync.APPLIED
    assert "research" not in engine_config.get_config().domain_ids


def test_the_same_config_is_not_applied_again(checkout, raw):
    reordered = dict(reversed(list(raw.items())))
    sb = FakeDb(applied=reordered)
    assert config_sync.apply_from_checkout(checkout(), sb) == config_sync.UNCHANGED
    assert sb.named("engine_config_apply") == []
    assert len(sb.named("issue_close_by_key")) == 1, "a valid file closes an old issue"


@pytest.mark.parametrize("text", [
    "version: 1\nengine: {id: Bad Id, name: x, owner: {email: nope}}\n",
    "version: [unclosed\n",
    "just a string\n",
    "",
])
def test_an_invalid_file_is_rejected_whole_and_logged_as_an_issue(checkout, raw, text):
    sb = FakeDb(applied=raw)
    assert config_sync.apply_from_checkout(checkout(text=text), sb) == config_sync.INVALID
    assert sb.applied == raw and sb.named("engine_config_apply") == []
    issue = sb.named("issue_upsert")[0]
    assert issue["p_category"] == "config_invalid" and issue["p_dedupe_key"] == "config"
    assert issue["p_source"] == "wiki" and "previous config stays in force" in issue["p_detail"]
    assert "Bad Id" not in str(issue) and "nope" not in str(issue), "no text from the file"
    assert sb.named("issue_close_by_key") == []


def test_a_date_is_read_as_text_as_the_service_reads_it(checkout, raw):
    """PyYAML alone would make a date object, which the database cannot store."""
    import datetime

    dated = copy.deepcopy(raw)
    dated["dashboard"]["title"] = datetime.date(2026, 1, 2)  # written as 2026-01-02
    sb = FakeDb(applied=raw)
    assert config_sync.apply_from_checkout(checkout(dated), sb) == config_sync.APPLIED
    assert sb.named("engine_config_apply")[0]["p_config"]["dashboard"]["title"] == "2026-01-02"


def test_a_value_of_the_wrong_kind_is_invalid(checkout, raw):
    wrong = copy.deepcopy(raw)
    wrong["dashboard"]["title"] = 12
    with pytest.raises(engine_config.ConfigurationError, match="dashboard.title: must be text"):
        engine_config.validate(wrong)
    sb = FakeDb(applied=raw)
    assert config_sync.apply_from_checkout(checkout(wrong), sb) == config_sync.INVALID
    assert sb.named("engine_config_apply") == []
    assert sb.named("issue_upsert")[0]["p_detail"].startswith("1 problem(s)")


def test_the_issue_counts_the_problems(checkout, raw):
    broken = copy.deepcopy(raw)
    broken["engine"]["id"] = "Bad Id"
    broken["sources"]["wiki"]["default_domain"] = "missing-topic"
    sb = FakeDb(applied=raw)
    config_sync.apply_from_checkout(checkout(broken), sb)
    assert sb.named("issue_upsert")[0]["p_detail"].startswith("2 problem(s)")


def test_a_config_the_database_refuses_keeps_the_old_one(checkout, raw):
    changed = copy.deepcopy(raw)
    changed["engine"]["owner"]["email"] = "someone-else@example.com"
    sb = FakeDb(applied=raw, refuse=PermissionError("an administrator must change the owner"))
    assert config_sync.apply_from_checkout(checkout(changed), sb) == config_sync.REFUSED
    assert sb.applied == raw
    issue = sb.named("issue_upsert")[0]
    assert issue["p_error_class"] == "PermissionError" and issue["p_dedupe_key"] == "config"
    assert "someone-else" not in str(issue)
    assert engine_config.get_config().owner.email == "owner@example.com"


def test_a_later_valid_file_closes_the_issue(checkout, raw):
    sb = FakeDb(applied=raw)
    config_sync.apply_from_checkout(checkout(text="version: 2\n"), sb)
    assert len(sb.named("issue_upsert")) == 1
    config_sync.apply_from_checkout(checkout(raw), sb)
    assert sb.named("issue_close_by_key")[-1]["p_dedupe_key"] == "config"


def test_a_broken_issue_log_never_stops_the_run(checkout, raw):
    sb = FakeDb(applied=raw, broken_issues=True)
    assert config_sync.apply_from_checkout(checkout(text="version: 2\n"), sb) == config_sync.INVALID
    assert config_sync.apply_from_checkout(checkout(raw), sb) == config_sync.UNCHANGED


def test_an_unpushed_edit_in_a_local_checkout_is_not_applied(checkout, raw, monkeypatch):
    asked = []
    monkeypatch.setattr(config_sync.knowledge_repo, "on_main",
                        lambda root, path: asked.append((root, path)) or False)
    sb = FakeDb(applied=None)
    root = checkout()
    assert config_sync.apply_from_checkout(root, sb) == config_sync.UNPUBLISHED
    assert sb.calls == [] and asked == [(root, ".kb-engine/engine.yaml")]


def test_the_wiki_puller_applies_the_config_in_its_prepare_step(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr("knowledge.config.WIKI_ROOT", tmp_path)
    monkeypatch.setattr(config_sync, "apply_from_checkout",
                        lambda root, sb: seen.append((root, sb)))
    sb = object()
    wiki.prepare(sb)
    assert seen == [(tmp_path, sb)]


def test_fetch_itself_never_writes_the_config(monkeypatch, tmp_path):
    monkeypatch.setattr("knowledge.config.WIKI_ROOT", tmp_path)
    monkeypatch.setattr(config_sync, "apply_from_checkout",
                        lambda *_a: pytest.fail("fetch must not apply the config"))
    monkeypatch.setattr(wiki._wiki, "collect", lambda **_kwargs: ([], []))
    assert wiki.fetch({}, sb=object()) == ([], {})


class _Puller:
    SOURCE, BRONZE, FULL_SYNC = "wiki", False, True

    def __init__(self):
        self.steps = []

    def prepare(self, sb):
        self.steps.append("prepare")

    def fetch(self, cursor, *, sb=None):
        self.steps.append("fetch")
        return [], {}

    def to_document(self, raw):
        return raw


def _run(monkeypatch, dry_run):
    from contextlib import contextmanager

    from pullers import runner

    puller = _Puller()

    @contextmanager
    def lock(*_a, **_k):
        yield True

    monkeypatch.setitem(runner.REGISTRY, "wiki", puller)
    monkeypatch.setattr(runner, "get_supabase_ingest", lambda: object())
    monkeypatch.setattr(runner.cursors, "with_lock", lock)
    monkeypatch.setattr(runner.cursors, "get_cursor", lambda *_a, **_k: {})
    monkeypatch.setattr(runner.cursors, "set_cursor", lambda *_a, **_k: None)
    monkeypatch.setattr(runner.cursors, "record_run", lambda *_a, **_k: None)
    monkeypatch.setattr(runner.ingest, "upsert", lambda *_a, **_k: argparse.Namespace(
        scanned=0, inserted=0, updated=0, unchanged=0, tombstoned=0, revived=0, embedded=0))
    monkeypatch.setattr(runner.review_apply, "apply_pending", lambda **_k: None)
    monkeypatch.setattr(runner, "_triage_and_distil", lambda *_a: (0, 0))
    monkeypatch.setattr(runner.review_queue, "build_batch",
                        lambda **_k: argparse.Namespace(items=[]))
    monkeypatch.setattr(runner.run_issues, "report_clean", lambda *_a, **_k: True)
    receipt = runner.run_source("wiki", dry_run=dry_run)
    assert receipt.ok, receipt.error
    return puller.steps


def test_the_runner_prepares_before_it_fetches(monkeypatch):
    assert _run(monkeypatch, dry_run=False) == ["prepare", "fetch"]


def test_a_dry_run_skips_the_prepare_step(monkeypatch):
    assert _run(monkeypatch, dry_run=True) == ["fetch"]
