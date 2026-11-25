"""send-session command line: transcript, check (writes item.json and a
preview), clean."""

from __future__ import annotations

import json
import os

import pytest

from plugin_tests.helpers import CWD, SESSION, assistant, load, user, write_jsonl

sn = load("session_note")


def _projects(tmp_path):
    folder = tmp_path / "projects" / sn.slug_for(CWD)
    folder.mkdir(parents=True, exist_ok=True)
    write_jsonl(folder / f"{SESSION}.jsonl", [
        user("Let's ship 2.0 on Dec 1", ts="2026-11-24T09:00:00Z"),
        assistant("Done: the release date is now Dec 1.", ts="2026-11-24T09:01:00Z"),
        user("thanks", ts="2026-11-24T11:30:00Z"),
    ])
    return tmp_path / "projects"


def _note(tmp_path, quote="Let's ship 2.0 on Dec 1"):
    path = tmp_path / "note.json"
    path.write_text(json.dumps({"items": [{
        "label": "decided", "text": "Release 2.0 ships on 2026-12-01.",
        "quotes": [{"who": "owner", "text": quote}],
        "pages": [{"key": "project:northwind", "title": "Northwind", "whats_new": "new date"}],
    }]}), encoding="utf-8")
    return path


def _check(tmp_path, *extra, quote="Let's ship 2.0 on Dec 1"):
    out = tmp_path / "out"
    argv = ["check", "--note", str(_note(tmp_path, quote)), "--projects-dir", str(_projects(tmp_path)),
            "--cwd", CWD, "--out", str(out), *extra]
    return sn.main(argv), out


def test_slug_matches_claude_codes_folder_names():
    assert sn.slug_for("/Users/ann/github/my_repo.v2") == "-Users-ann-github-my-repo-v2"


def test_check_fills_the_header_from_the_session_and_writes_the_item(tmp_path, capsys):
    code, out = _check(tmp_path)
    assert code == 0
    item = json.loads((out / "item.json").read_text(encoding="utf-8"))
    assert item["source"] == "claude-code"
    assert item["source_id"] == SESSION
    assert item["source_created_at"] == "2026-11-24T11:30:00Z" == item["cursor"]
    assert item["tags"] == [{"kind": "project", "id": "demo-project", "name": "demo-project"}]
    note = item["note"]
    assert note["session_id"] == SESSION and note["project"] == "demo-project"
    assert note["started_at"] == "2026-11-24T09:00:00Z" and note["ended_at"] == "2026-11-24T11:30:00Z"
    assert "body" not in item and "topics" not in item and "owner" not in item
    printed = capsys.readouterr().out
    assert "# Session note: demo-project" in printed
    assert "Items: 1 (decided 1)" in printed
    assert "Quotes checked against the session: 1 of 1" in printed
    assert printed.rstrip().endswith("Send to Quantabase? (yes / no, or say what to change)")


def test_check_refuses_a_quote_the_session_does_not_hold(tmp_path, capsys):
    code, out = _check(tmp_path, quote="We ship on Dec 1")
    assert code == 1
    err = capsys.readouterr().err
    assert "item 1, quote 1: not found word for word" in err
    assert not (out / "item.json").exists()


def test_check_without_a_transcript(tmp_path, capsys):
    out = tmp_path / "out"
    note = _note(tmp_path, "anything at all here")
    assert sn.main(["check", "--note", str(note), "--no-transcript", "--out", str(out)]) == 1
    assert "session_id" in capsys.readouterr().err
    data = json.loads(note.read_text(encoding="utf-8"))
    note.write_text(json.dumps({**data, "session_id": "chat-1", "project": "board"}), encoding="utf-8")
    assert sn.main(["check", "--note", str(note), "--no-transcript", "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "Quotes checked against the session: 0 of 1 (no transcript)" in printed
    assert json.loads((out / "item.json").read_text(encoding="utf-8"))["source_id"] == "chat-1"


def test_a_note_that_is_not_json(tmp_path, capsys):
    bad = tmp_path / "note.json"
    bad.write_text("{not json", encoding="utf-8")
    assert sn.main(["check", "--note", str(bad), "--no-transcript", "--out", str(tmp_path / "o")]) == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_transcript_prints_the_conversation_only(tmp_path, capsys):
    code = sn.main(["transcript", "--projects-dir", str(_projects(tmp_path)), "--cwd", CWD])
    assert code == 0
    printed = capsys.readouterr().out
    assert "Owner: Let's ship 2.0 on Dec 1" in printed
    assert "Assistant: Done: the release date is now Dec 1." in printed


def test_transcript_keeps_only_the_tail(tmp_path, capsys):
    sn.main(["transcript", "--projects-dir", str(_projects(tmp_path)), "--cwd", CWD, "--max-chars", "1000"])
    assert len(capsys.readouterr().out) < 1200


def test_finding_the_transcript(tmp_path):
    folder = tmp_path / sn.slug_for(CWD)
    folder.mkdir()
    old = write_jsonl(folder / "old.jsonl", [user("old")])
    new = write_jsonl(folder / "new.jsonl", [user("new")])
    os.utime(old, (1_000_000, 1_000_000))
    os.utime(new, (2_000_000, 2_000_000))
    assert sn.find_transcript(tmp_path, CWD) == new
    assert sn.find_transcript(tmp_path, CWD, session="old") == old
    assert sn.find_transcript(tmp_path, CWD, path=str(new)) == new
    with pytest.raises(sn.SendError, match="session id"):
        sn.find_transcript(tmp_path, CWD, session="../../etc/passwd")
    with pytest.raises(sn.SendError, match="No Claude Code transcripts"):
        sn.find_transcript(tmp_path, "/nowhere")
    with pytest.raises(sn.SendError, match="No transcript for session"):
        sn.find_transcript(tmp_path, CWD, session="missing")
    with pytest.raises(sn.SendError, match="not a .jsonl"):
        sn.find_transcript(tmp_path, CWD, path=str(tmp_path / "x.txt"))


def test_clean_removes_only_its_own_files(tmp_path, capsys):
    _, out = _check(tmp_path)
    (out / "keep.txt").write_text("not ours", encoding="utf-8")
    assert sn.main(["clean", "--out", str(out)]) == 0
    assert sorted(p.name for p in out.iterdir()) == ["keep.txt"]
    (out / "keep.txt").unlink()
    _check(tmp_path)
    assert sn.main(["clean", "--out", str(out)]) == 0
    assert not out.exists()


def test_times_are_iso_with_a_zone():
    assert sn.iso_time("2026-11-24T10:00:00.123Z") == "2026-11-24T10:00:00Z"
    assert sn.iso_time("2026-11-24T05:00:00-05:00") == "2026-11-24T10:00:00Z"
    assert sn.iso_time("2026-11-24T10:00:00") == "2026-11-24T10:00:00Z"
    assert sn.iso_time("yesterday") is None
    assert sn.iso_time(None) is None


def test_errors_are_one_plain_line(tmp_path, capsys):
    code = sn.main(["transcript", "--projects-dir", str(tmp_path), "--cwd", "/nowhere"])
    assert code == 1
    assert capsys.readouterr().err.startswith("send-session: No Claude Code transcripts")
