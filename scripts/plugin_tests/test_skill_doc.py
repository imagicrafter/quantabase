"""send-session: the SKILL.md matches the script and the Engine's rules."""

from __future__ import annotations

import re

from plugin_tests.helpers import SCRIPTS, load

SKILL = (SCRIPTS.parent / "SKILL.md").read_text(encoding="utf-8")
sn = load("session_note")
nc = load("note_check")


def test_every_command_the_skill_runs_exists():
    used = set(re.findall(r"python3 SCRIPT (\w+)", SKILL))
    assert used == {"transcript", "check", "save", "clean"}
    for command in used:
        assert sn.main([command, "--help"]) == 0


def test_every_label_is_explained_and_ideas_are_not_decisions():
    for label in nc.LABELS:
        assert f"`{label}`" in SKILL
    assert "Something only suggested or discussed is an `idea`" in SKILL


def test_send_is_one_call_with_the_item_fields_and_no_page_writes():
    assert "call `record_source_item` once" in SKILL
    for name in ("source", "source_id", "source_created_at", "cursor", "tags", "note"):
        assert f"`{name}`" in SKILL
    assert "Never `save_page`, `update_page`" in SKILL
    assert "No `body`, no `topics`, no `owner`" in SKILL


def test_asks_before_sending_and_quotes_are_exact():
    assert "**Send to Quantabase?**" in SKILL
    assert "Nothing is sent without the person's yes" in SKILL
    assert "word for word" in SKILL


def test_saves_before_sending_and_never_writes_the_config():
    assert SKILL.index("python3 SCRIPT save") < SKILL.index("call `record_source_item` once")
    assert "never create or change that file" in SKILL
    assert "saved <path>" in SKILL and "not saved (no save folder set)" in SKILL
