"""send-session: saving the approved note to a local folder (optional)."""

from __future__ import annotations

import json
from datetime import date

import pytest

from plugin_tests.helpers import load

ns = load("note_save")
sn = load("session_note")

NOTE = {
    "session_id": "abc-123", "project": "kb-engine", "title": "Cataloguer: summary length & index clerk!",
    "started_at": "2026-11-24T09:00:00Z", "ended_at": "2026-11-24T11:30:00Z",
    "items": [{"label": "decided", "text": "Summaries default to standard.",
               "quotes": [{"who": "owner", "text": "keep standard as the default"}]}],
}


@pytest.mark.parametrize("day, monday", [
    (date(2026, 11, 23), "2026-11-23"),  # Monday
    (date(2026, 11, 24), "2026-11-23"),  # Tuesday
    (date(2026, 11, 29), "2026-11-23"),  # Sunday
    (date(2026, 12, 2), "2026-11-30"),
    (date(2027, 1, 1), "2026-12-28"),    # across a year end
])
def test_monday_of_the_week(day, monday):
    assert ns.monday_of(day) == monday


def test_pattern_expands_week_and_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    out = ns.expand("~/notes/week-{week}/", date(2026, 11, 26))
    assert out == tmp_path / "notes" / "week-2026-11-23"


@pytest.mark.parametrize("bad", ["~/x/{month}/", "~/x/{week", "relative/folder", ""])
def test_bad_patterns_are_refused(bad):
    with pytest.raises(ns.SaveError):
        ns.expand(bad, date(2026, 11, 26))


@pytest.mark.parametrize("title, slug", [
    ("Cataloguer: summary length & index clerk!", "cataloguer-summary-length-index-clerk"),
    ("  KB Engine   Cataloguer ", "kb-engine-cataloguer"),
    ("Résumé für Zürich", "resume-fur-zurich"),
    ("東京 🚀", ""),
    ("one two three four five six seven eight nine ten", "one-two-three-four-five-six"),
])
def test_slug(title, slug):
    assert ns.slug(title) == slug


def test_file_name_is_date_then_slug_with_fallbacks():
    assert ns.file_name(NOTE) == "2026-11-24-cataloguer-summary-length-index-clerk.md"
    untitled = {**NOTE, "title": "東京"}
    assert ns.file_name(untitled) == "2026-11-24-kb-engine.md"
    assert ns.file_name({k: v for k, v in NOTE.items() if k != "title"}) == "2026-11-24-kb-engine.md"


def test_markdown_has_frontmatter_and_the_note():
    md = ns.markdown(NOTE)
    assert md.startswith("---\ntitle: \"Cataloguer: summary length & index clerk!\"\nsession_id: abc-123\n")
    assert "project: kb-engine\ndate: 2026-11-24\nsource: claude-code\n---\n\n# Session note: kb-engine\n" in md
    assert "## 1. [decided] Summaries default to standard." in md


def test_save_never_overwrites_another_sessions_note(tmp_path):
    first = ns.save_note(NOTE, tmp_path)
    assert first == tmp_path / "2026-11-24-cataloguer-summary-length-index-clerk.md"
    # Same session sent again: the same file, updated.
    again = ns.save_note({**NOTE, "items": NOTE["items"] * 2}, tmp_path)
    assert again == first and first.read_text(encoding="utf-8").count("[decided]") == 2
    # Another session with the same name: -2, then -3.
    other = ns.save_note({**NOTE, "session_id": "other-1"}, tmp_path)
    third = ns.save_note({**NOTE, "session_id": "other-2"}, tmp_path)
    assert other.name.endswith("-clerk-2.md") and third.name.endswith("-clerk-3.md")
    assert ns.save_note({**NOTE, "session_id": "other-1"}, tmp_path) == other
    # A file a person wrote by hand (no frontmatter) is never replaced.
    hand = tmp_path / "2026-11-24-kb-engine.md"
    hand.write_text("my own notes", encoding="utf-8")
    saved = ns.save_note({**NOTE, "title": ""}, tmp_path)
    assert saved.name == "2026-11-24-kb-engine-2.md" and hand.read_text(encoding="utf-8") == "my own notes"


def test_folder_comes_from_the_flag_then_the_config_else_nothing(tmp_path):
    config = tmp_path / "config.json"
    assert ns.save_dir(None, config, date(2026, 11, 24)) is None
    config.write_text(json.dumps({"save_dir": str(tmp_path / "w-{week}")}), encoding="utf-8")
    assert ns.save_dir(None, config, date(2026, 11, 24)) == tmp_path / "w-2026-11-23"
    assert ns.save_dir(str(tmp_path / "flag"), config, date(2026, 11, 24)) == tmp_path / "flag"
    config.write_text("{broken", encoding="utf-8")
    with pytest.raises(ns.SaveError, match="config"):
        ns.save_dir(None, config, date(2026, 11, 24))
    config.write_text(json.dumps({"save_dir": 5}), encoding="utf-8")
    with pytest.raises(ns.SaveError, match="save_dir"):
        ns.save_dir(None, config, date(2026, 11, 24))


def _item(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    (out / "item.json").write_text(json.dumps({"source": "claude-code", "note": NOTE}), encoding="utf-8")
    return out


def test_save_command(tmp_path, capsys):
    out = _item(tmp_path)
    target = tmp_path / "notes"
    assert sn.main(["save", "--out", str(out), "--save-dir", str(target), "--config", str(tmp_path / "none.json")]) == 0
    printed = capsys.readouterr().out.strip()
    assert printed == f"saved {target / '2026-11-24-cataloguer-summary-length-index-clerk.md'}"
    assert sn.main(["save", "--out", str(out), "--config", str(tmp_path / "none.json")]) == 0
    assert capsys.readouterr().out.strip() == "not saved (no save folder set)"
    assert sn.main(["save", "--out", str(tmp_path / "nowhere"), "--save-dir", str(target)]) == 1
    assert "Could not read item.json" in capsys.readouterr().err


def test_default_config_paths_match_docs():
    """The new settings file, then the old one (kept working since 0.3.2)."""
    from pathlib import Path

    import note_save

    assert note_save.CONFIG_PATHS == (
        Path.home() / ".claude" / "qb-engine" / "send-session.json",
        Path.home() / ".claude" / "kb-send-session" / "config.json",
    )


def test_config_file_prefers_new_then_old(tmp_path):
    new, old = tmp_path / "qb-engine" / "send-session.json", tmp_path / "kb-send-session" / "config.json"
    assert ns.config_file((new, old)) is None
    old.parent.mkdir()
    old.write_text("{}", encoding="utf-8")
    assert ns.config_file((new, old)) == old
    new.parent.mkdir()
    new.write_text("{}", encoding="utf-8")
    assert ns.config_file((new, old)) == new


def test_save_dir_without_a_config_file_is_none(tmp_path):
    assert ns.save_dir(None, None, date(2026, 11, 24)) is None


def test_save_command_reads_the_old_settings_path(tmp_path, capsys, monkeypatch):
    out = _item(tmp_path)
    old = tmp_path / "kb-send-session" / "config.json"
    old.parent.mkdir()
    old.write_text(json.dumps({"save_dir": str(tmp_path / "kept")}), encoding="utf-8")
    monkeypatch.setattr(ns, "CONFIG_PATHS", (tmp_path / "qb-engine" / "send-session.json", old))
    assert sn.main(["save", "--out", str(out)]) == 0
    assert capsys.readouterr().out.strip().startswith(f"saved {tmp_path / 'kept'}")
