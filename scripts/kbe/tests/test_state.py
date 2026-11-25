"""Local state file: atomic, private, and never a home for a secret."""

from __future__ import annotations

import json
import os
import stat

import pytest

from kbe import state
from kbe.errors import KbeError


def test_load_missing_file_gives_empty_state(tmp_path):
    loaded = state.load(tmp_path / "nope" / "state.json")
    assert loaded == {"version": 1, "phases": {}, "answers": {}}


def test_save_then_load_round_trips(tmp_path):
    path = tmp_path / ".kb-engine-local" / "state.json"
    first = state.with_answer(state.empty(), "engine_host", "engine.example.com")
    state.save(path, first)
    assert state.load(path) == first


def test_save_is_private_and_leaves_no_temp_file(tmp_path):
    path = tmp_path / ".kb-engine-local" / "state.json"
    state.save(path, state.empty())
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert [p.name for p in path.parent.iterdir()] == ["state.json"]


def test_save_replaces_atomically_and_keeps_old_file_on_failure(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    state.save(path, state.with_answer(state.empty(), "repo", "acme/knowledge"))

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(KbeError, match="could not be saved"):
        state.save(path, state.with_answer(state.empty(), "repo", "other/repo"))
    assert json.loads(path.read_text())["answers"]["repo"] == "acme/knowledge"
    assert [p.name for p in tmp_path.iterdir()] == ["state.json"]


def test_updates_return_new_objects(tmp_path):
    before = state.empty()
    after = state.with_answer(before, "engine_host", "engine.example.com")
    done = state.with_phase(after, "database", "done", now="2026-01-01T00:00:00+00:00")
    assert before == {"version": 1, "phases": {}, "answers": {}}
    assert "engine_host" not in before["answers"]
    assert done["phases"]["database"] == {
        "status": "done",
        "at": "2026-01-01T00:00:00+00:00",
    }
    assert after["phases"] == {}
    assert state.phase_done(done, "database")
    assert not state.phase_done(done, "deploy")
    assert state.answer(done, "engine_host") == "engine.example.com"
    assert state.answer(done, "missing", "fallback") == "fallback"


@pytest.mark.parametrize(
    "key",
    [
        "SUPABASE_SERVICE_ROLE_KEY",
        "github_token",
        "jwt_secret",
        "Password",
        "db_password",
        "api-key",
        "token",
        "SECRET",
        "setup_code",
        "KBE_DATABASE_URL",
    ],
)
def test_secret_looking_keys_are_refused(key):
    assert state.looks_secret(key)
    with pytest.raises(KbeError, match="never stored"):
        state.with_answer(state.empty(), key, "x")


@pytest.mark.parametrize("key", ["engine_host", "wiki_repo", "knowledge_path", "keyboard"])
def test_ordinary_keys_are_allowed(key):
    assert not state.looks_secret(key)
    assert state.with_answer(state.empty(), key, "v")["answers"][key] == "v"


@pytest.mark.parametrize(
    "value",
    [
        # Built from pieces so no scanner mistakes these fakes for real ones.
        "postgresql://user:" + "fake-pw" + "@db.example.com:5432/postgres",
        ".".join(["eyJ" + "fakehead", "fakebody", "fakesign"]),
        {"nested": {"client_secret": "x"}},
    ],
)
def test_secret_looking_values_are_refused(value):
    with pytest.raises(KbeError, match="never stored"):
        state.with_answer(state.empty(), "note", value)


def test_save_checks_the_whole_tree(tmp_path):
    sneaky = {"version": 1, "phases": {}, "answers": {"a": {"api_token": "x"}}}
    with pytest.raises(KbeError, match="never stored"):
        state.save(tmp_path / "state.json", sneaky)
    assert not (tmp_path / "state.json").exists()


def test_unknown_phase_status_is_refused():
    with pytest.raises(KbeError, match="status"):
        state.with_phase(state.empty(), "database", "maybe")


def test_corrupt_file_says_what_to_do(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json")
    with pytest.raises(KbeError, match="not valid JSON"):
        state.load(path)
    path.write_text("[1, 2]")
    with pytest.raises(KbeError, match="unexpected shape"):
        state.load(path)
