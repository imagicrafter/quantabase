"""send-session: only the owner's prompts and the assistant's text replies are kept."""

from __future__ import annotations

from plugin_tests.helpers import SESSION, assistant, fake, load, tool_result, user, write_jsonl

turns_mod = load("session_turns")
read_session = turns_mod.read_session


def _texts(session):
    return [(t.role, t.text) for t in session.turns]


def test_keeps_prompts_and_text_replies_in_order(tmp_path):
    path = write_jsonl(tmp_path / "s.jsonl", [
        user("Plan the release", ts="2026-11-24T09:00:00Z"),
        assistant("Here is the plan.", ts="2026-11-24T09:00:10Z"),
        user("Ship it", ts="2026-11-24T09:05:00Z"),
        assistant("Done.", ts="2026-11-24T09:05:30Z"),
    ])
    s = read_session(path)
    assert _texts(s) == [("owner", "Plan the release"), ("assistant", "Here is the plan."),
                         ("owner", "Ship it"), ("assistant", "Done.")]
    assert s.session_id == SESSION
    assert s.project == "demo-project"
    assert s.started_at == "2026-11-24T09:00:00Z" and s.ended_at == "2026-11-24T09:05:30Z"


def test_drops_every_non_conversation_record(tmp_path):
    records = [
        {"type": "summary", "summary": "SUMMARY TEXT"},
        {"type": "system", "content": "SYSTEM TEXT", "timestamp": "2026-11-24T09:00:00Z"},
        {"type": "attachment", "attachment": {"content": "ATTACHMENT TEXT"}},
        {"type": "file-history-snapshot", "snapshot": {"x": "SNAPSHOT"}},
        {"type": "progress", "data": "PROGRESS"},
        {"type": "queue-operation", "content": "QUEUED TEXT"},
        {"type": "custom-title", "customTitle": "TITLE TEXT"},
        user("META TEXT", isMeta=True),
        user("COMPACT SUMMARY TEXT", isCompactSummary=True),
        user("TRANSCRIPT ONLY TEXT", isVisibleInTranscriptOnly=True),
        user("SIDECHAIN TEXT", isSidechain=True),
        assistant("SIDECHAIN REPLY", isSidechain=True),
        assistant("API ERROR TEXT", isApiErrorMessage=True),
        tool_result(),
        user([{"type": "image", "source": {"data": "IMAGEDATA"}}]),
        assistant([{"type": "thinking", "thinking": "THINKING TEXT"},
                   {"type": "tool_use", "name": "Bash", "input": {"command": "TOOL CALL TEXT"}}]),
        user("The real prompt"),
        assistant([{"type": "thinking", "thinking": "MORE THINKING"}, {"type": "text", "text": "The real reply"}]),
    ]
    s = read_session(write_jsonl(tmp_path / "s.jsonl", records))
    joined = "\n".join(t.text for t in s.turns)
    assert _texts(s) == [("owner", "The real prompt"), ("assistant", "The real reply")]
    for leak in ("SUMMARY", "SYSTEM", "ATTACHMENT", "SNAPSHOT", "PROGRESS", "QUEUED", "TITLE TEXT", "META", "COMPACT",
                 "TRANSCRIPT ONLY", "SIDECHAIN", "API ERROR", "TOOL OUTPUT", "IMAGEDATA", "THINKING", "TOOL CALL"):
        assert leak not in joined


def test_strips_injected_tags_from_prompts(tmp_path):
    prompt = (
        "<system-reminder>REMINDER TEXT</system-reminder>Fix the bug"
        "<user-prompt-submit-hook>HOOK TEXT</user-prompt-submit-hook>"
        "<local-command-stdout>STDOUT TEXT</local-command-stdout>"
        "<bash-stdout>BASH OUT</bash-stdout><bash-stderr>BASH ERR</bash-stderr>"
        "<task-notification>TASK TEXT</task-notification>"
        "<persisted-output>PERSISTED</persisted-output>"
    )
    s = read_session(write_jsonl(tmp_path / "s.jsonl", [
        user(prompt),
        user("<local-command-caveat>Caveat: CAVEAT TEXT</local-command-caveat>"),
        user("<teammate-message teammate_id=\"lead\">AGENT MESSAGE</teammate-message>"),
        user("<cross-session-message from=\"x\">CROSS TEXT</cross-session-message>"),
        user("[Request interrupted by user]"),
        user([{"type": "text", "text": "[Request interrupted by user for tool use]"}]),
    ]))
    assert _texts(s) == [("owner", "Fix the bug")]


def test_an_unclosed_injected_tag_drops_the_rest(tmp_path):
    s = read_session(write_jsonl(tmp_path / "s.jsonl", [
        user("Keep this<system-reminder>REMINDER WITH NO END"),
    ]))
    assert _texts(s) == [("owner", "Keep this")]


def test_slash_commands_become_one_short_line(tmp_path):
    s = read_session(write_jsonl(tmp_path / "s.jsonl", [
        user("<command-message>update-docs is running</command-message>\n<command-name>/update-docs</command-name>\n"
             "<command-args>wiki</command-args>"),
    ]))
    assert _texts(s) == [("owner", "/update-docs wiki")]


def test_big_pasted_bodies_are_left_out_small_ones_kept(tmp_path):
    big = "x" * 5000
    s = read_session(write_jsonl(tmp_path / "s.jsonl", [
        user(f"Look at this <pasted_content id=\"a1\">{big}</pasted_content> please"),
        user("and <pasted_content id=\"b2\">short paste</pasted_content>"),
    ]))
    texts = [t.text for t in s.turns]
    assert big not in texts[0]
    assert "[pasted text left out: 5000 characters]" in texts[0]
    assert texts[1] == "and short paste"


def test_assistant_text_split_by_tool_calls_is_one_turn(tmp_path):
    s = read_session(write_jsonl(tmp_path / "s.jsonl", [
        user("Go"),
        assistant("First I will look.", ts="2026-11-24T10:00:01Z"),
        assistant([{"type": "tool_use", "name": "Read", "input": {}}], ts="2026-11-24T10:00:02Z"),
        tool_result(ts="2026-11-24T10:00:03Z"),
        assistant("Found it.", ts="2026-11-24T10:00:04Z"),
    ]))
    assert _texts(s) == [("owner", "Go"), ("assistant", "First I will look.\n\nFound it.")]
    # Stamped by its first record, so more replies never change an earlier part.
    assert s.turns[1].ts == "2026-11-24T10:00:01Z"
    assert s.ended_at == "2026-11-24T10:00:04Z"


def test_bad_lines_and_blank_lines_are_skipped_and_counted(tmp_path):
    path = write_jsonl(tmp_path / "s.jsonl", [user("ok")], raw_lines=["{not json", "", "[1, 2]", '{"type": "user"'])
    s = read_session(path)
    assert _texts(s) == [("owner", "ok")]
    assert s.bad_lines == 3


def test_secrets_are_scrubbed_and_counted(tmp_path):
    key = fake("sk-" + "ant-", "api03-A1b2C3d4E5f6G7h8I9j0K1l2M3n4")
    s = read_session(write_jsonl(tmp_path / "s.jsonl", [user(f"use {key}"), assistant(f"Set token=abcdef123456 and {key}")]))  # gitleaks:allow (made-up)
    assert all(key not in t.text for t in s.turns)
    assert s.redactions == 3


def test_unicode_is_kept(tmp_path):
    s = read_session(write_jsonl(tmp_path / "s.jsonl", [user("Résumé für 東京 🚀"), assistant("Très bien ✓")]))
    assert _texts(s) == [("owner", "Résumé für 東京 🚀"), ("assistant", "Très bien ✓")]


def test_project_falls_back_to_the_folder_and_session_to_the_file_name(tmp_path):
    folder = tmp_path / "-home-someone-code-other"
    folder.mkdir()
    path = folder / "abc-123.jsonl"
    path.write_text('{"type": "user", "message": {"content": "hi"}}\n', encoding="utf-8")
    s = read_session(path)
    assert s.session_id == "abc-123"
    assert s.project == "-home-someone-code-other"
    assert s.started_at is None
