#!/usr/bin/env python3
"""Meetings someone else's Fireflies recorded and shared with the owner.

    python -m pullers.fireflies_shared_test

No network: the Fireflies calls and the cursor reads are patched.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from knowledge import engine_config  # noqa: E402
from pullers import fireflies, fireflies_shared as fs  # noqa: E402


def _config(*, shared: bool, trusted=("partner.example",)) -> engine_config.EngineConfig:
    """An Engine config with shared meetings on or off."""
    return engine_config.validate({
        "version": 1,
        "engine": {"id": "acme", "name": "Acme", "owner": {"email": "owner@example.com"}},
        "sources": {"fireflies": {
            "enabled": True,
            "shared_meetings": {"enabled": shared, "trusted_domains": list(trusted)},
        }},
    })

NOW = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)
SHARED = "01M4VK092TMWJK9M167M1AQMY1"
OTHER = "01M52R6PP35FHESJB9B5CSV3ZV"

RECAP_HTML = (
    '<a href="https://app.fireflies.ai/view/Onboarding-Dana-Lee-and-Rob::'
    f'{SHARED}?ref=recap">View meeting recap</a>'
    f'<a href="https://app.fireflies.ai/view/Onboarding-Dana-Lee-and-Rob::{SHARED}">x</a>'
)


# --- extract_ids ---------------------------------------------------------------

def test_extract_ids_finds_each_id_once() -> None:
    assert fs.extract_ids(RECAP_HTML) == [SHARED]


def test_extract_ids_ignores_other_hosts() -> None:
    text = f"https://evil.example/view/x::{SHARED} https://fireflies.ai.evil.example/view/x::{OTHER}"
    assert fs.extract_ids(text) == []


def test_extract_ids_empty_text() -> None:
    assert fs.extract_ids("") == []
    assert fs.extract_ids(None) == []


# --- merge_ids -------------------------------------------------------------------

def test_merge_keeps_first_seen_and_prunes_old() -> None:
    cursor = {"ids": {SHARED: "2026-10-20T19:06:09+00:00", "OLD0000000000000000000000": "2026-09-01T00:00:00+00:00"}}
    found = {SHARED: "2026-10-21T00:00:00+00:00", OTHER: "2026-10-22T19:57:46+00:00"}
    merged = fs.merge_ids(cursor, found, now=NOW)
    assert merged["ids"] == {SHARED: "2026-10-20T19:06:09+00:00", OTHER: "2026-10-22T19:57:46+00:00"}
    assert merged["scanned_at"] == NOW.isoformat()
    assert "OLD0000000000000000000000" in cursor["ids"], "input cursor must not be mutated"


def test_merge_from_empty_cursor() -> None:
    assert fs.merge_ids({}, {OTHER: "2026-10-22T19:57:46+00:00"}, now=NOW)["ids"] == {
        OTHER: "2026-10-22T19:57:46+00:00"
    }


# --- pending -------------------------------------------------------------------------

def test_pending_skips_seen_and_listed_oldest_first() -> None:
    shared = {"ids": {OTHER: "2026-10-22T19:57:46+00:00", SHARED: "2026-10-20T19:06:09+00:00", "DONE00000000000000000000": "2026-10-19T00:00:00+00:00"}}
    seen = {"DONE00000000000000000000": "2026-10-19"}
    assert fs.pending(shared, seen=seen, listed=set()) == [SHARED, OTHER]
    assert fs.pending(shared, seen=seen, listed={SHARED}) == [OTHER]


def test_prune_seen_drops_old_entries() -> None:
    seen = {SHARED: "2026-10-20", "OLD": "2026-08-01"}
    assert fs.prune_seen(seen, now=NOW) == {SHARED: "2026-10-20"}


# --- is_duplicate -------------------------------------------------------------------

def test_duplicate_when_own_meeting_starts_close() -> None:
    raw = {"id": SHARED, "date": "2026-10-15T19:30:00.000Z", "duration": 33}
    own = [{"id": "OWN", "date": "2026-10-15T19:32:14.800Z", "duration": 33.45}]
    assert fs.is_duplicate(raw, own) is True


def test_duplicate_when_own_bot_joined_late() -> None:
    """A real case: another attendee's bot from 19:00 for 93 min, the owner's from 19:23 for 71."""
    raw = {"id": SHARED, "date": "2026-09-25T19:00:00.000Z", "duration": 93}
    own = [{"id": "OWN", "date": "2026-09-25T19:23:05.592Z", "duration": 71}]
    assert fs.is_duplicate(raw, own) is True


def test_not_duplicate_when_back_to_back() -> None:
    raw = {"id": SHARED, "date": "2026-10-15T19:00:00Z", "duration": 60}
    own = [{"id": "OWN", "date": "2026-10-15T19:55:00Z", "duration": 50}]
    assert fs.is_duplicate(raw, own) is False


def test_not_duplicate_when_far_apart_or_same_id() -> None:
    raw = {"id": SHARED, "date": "2026-10-15T19:30:00.000Z"}
    assert fs.is_duplicate(raw, [{"id": "OWN", "date": "2026-10-15T20:07:22.183Z", "duration": 52}]) is False
    assert fs.is_duplicate(raw, [{"id": SHARED, "date": "2026-10-15T19:30:00.000Z"}]) is False


def test_epoch_ms_dates_are_understood() -> None:
    raw = {"id": SHARED, "date": 1792519200000, "duration": 60}  # 2026-10-20T18:00:00Z
    own = [{"id": "OWN", "date": "2026-10-20T18:05:00Z", "duration": 55}]
    assert fs.is_duplicate(raw, own) is True


def test_span_defaults_missing_duration() -> None:
    start, end = fs.span({"date": "2026-10-20T18:00:00Z"})
    assert end - start == fs.DEFAULT_DURATION
    assert fs.span({"date": None}) is None


def test_shared_meeting_is_marked_and_retention_skips_it() -> None:
    from pullers import fireflies_retention

    raw = {**_transcript(SHARED, "2026-10-20T18:00:00.000Z"), "_shared": True}
    doc = fireflies.to_document(raw)
    assert doc.metadata["fireflies_shared"] is True
    row = {"metadata": {"fireflies_id": SHARED, "fireflies_shared": True}, "body": ""}
    assert "shared" in fireflies_retention.gate(row, lambda _page: True, "x")


def test_own_meeting_is_not_marked_shared() -> None:
    doc = fireflies.to_document(_transcript("OWNMEETING", "2026-10-20T18:00:00.000Z"))
    assert "fireflies_shared" not in doc.metadata


# --- fireflies.fetch with shared meetings -----------------------------------------------

CURSOR = {"last_checked": "2026-10-15T20:05:00+00:00"}


def _transcript(tid: str, date: str) -> dict:
    return {"id": tid, "title": f"Meeting {tid[:4]}", "date": date, "duration": 60,
            "organizer_email": "sam@partner.example",
            "sentences": [{"speaker_name": "A", "text": "hi", "start_time": 0, "end_time": 1}]}


def _run_fetch(shared_cursor: dict, transcripts: dict, own_window: list, *, cursor=CURSOR, listing=(),
               stored=frozenset(), config=None):
    engine_config.set_config_for_tests(config or _config(shared=True))
    def gql(query, variables=None):
        if "GetTranscript" in query:
            tid = variables["id"]
            if tid in transcripts and isinstance(transcripts[tid], Exception):
                raise transcripts[tid]
            return {"transcript": transcripts.get(tid)}
        if "WindowTranscripts" in query:
            return {"transcripts": own_window}
        raise AssertionError(f"unexpected query {query[:40]}")

    with mock.patch.object(fireflies, "_list_stubs", return_value=list(listing)), \
         mock.patch.object(fireflies, "_gql", side_effect=gql), \
         mock.patch.object(fireflies.time, "sleep"), \
         mock.patch.object(fireflies, "_read_shared_cursor", return_value=shared_cursor), \
         mock.patch.object(fireflies, "_stored_by_other", side_effect=lambda _sb, eid, _fid: eid in stored):
        return fireflies.fetch(cursor, sb=object())


def test_fetch_adds_shared_meeting_without_moving_cursor() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    raws, cursor = _run_fetch(shared, {SHARED: _transcript(SHARED, "2026-10-20T18:00:00.000Z")}, [])
    assert [r["id"] for r in raws] == [SHARED]
    assert raws[0]["_shared"] is True
    assert cursor["last_checked"] == CURSOR["last_checked"]
    assert SHARED in cursor["shared_seen"]


def test_fetch_skips_shared_duplicate_of_own_meeting_and_marks_it_seen() -> None:
    shared = {"ids": {SHARED: "2026-10-15T20:10:30+00:00"}}
    raws, cursor = _run_fetch(
        shared,
        {SHARED: _transcript(SHARED, "2026-10-15T19:30:00.000Z")},
        [{"id": "OWN", "date": "2026-10-15T19:32:14.800Z", "duration": 60}],
    )
    assert raws == []
    assert SHARED in cursor["shared_seen"]


def test_fetch_skips_already_seen_shared_ids() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    recent = datetime.now(timezone.utc).isoformat()
    cursor_in = {**CURSOR, "shared_seen": {SHARED: recent}}
    raws, cursor = _run_fetch(shared, {}, [], cursor=cursor_in)
    assert raws == []
    assert cursor["shared_seen"] == {SHARED: recent}


def test_fetch_error_on_one_shared_id_does_not_fail_run_or_mark_seen() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00", OTHER: "2026-10-22T19:57:46+00:00"}}
    raws, cursor = _run_fetch(
        shared,
        {SHARED: fireflies.FirefliesConnectorError("no access"), OTHER: _transcript(OTHER, "2026-10-22T19:00:49Z")},
        [],
    )
    assert [r["id"] for r in raws] == [OTHER]
    assert SHARED not in cursor.get("shared_seen", {})
    assert cursor["shared_tries"] == {SHARED: 1}


def test_fetch_without_sb_skips_shared_lookup() -> None:
    with mock.patch.object(fireflies, "_list_stubs", return_value=[]), \
         mock.patch.object(fireflies, "_read_shared_cursor") as read:
        raws, cursor = fireflies.fetch(CURSOR)
    read.assert_not_called()
    assert raws == [] and cursor == CURSOR


def test_fetch_shared_cursor_read_failure_keeps_own_meetings() -> None:
    def boom(_sb):
        raise RuntimeError("db down")

    own = _transcript("OWNMEETING", "2026-10-22T19:00:49Z")
    with mock.patch.object(fireflies, "_list_stubs", return_value=[{"id": "OWNMEETING"}]), \
         mock.patch.object(fireflies, "_gql", return_value={"transcript": own}), \
         mock.patch.object(fireflies.time, "sleep"), \
         mock.patch.object(fireflies, "_read_shared_cursor", side_effect=boom), \
         mock.patch.object(fireflies, "_stored_by_other", return_value=False):
        raws, _cursor = fireflies.fetch(CURSOR, sb=object())
    assert [r["id"] for r in raws] == ["OWNMEETING"]


def test_fetch_gives_up_after_max_tries() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    cursor_in = {**CURSOR, "shared_tries": {SHARED: fs.MAX_TRIES - 1}}
    raws, cursor = _run_fetch(shared, {SHARED: None}, [], cursor=cursor_in)
    assert raws == []
    assert SHARED in cursor["shared_seen"]
    assert "shared_tries" not in cursor


def test_fetch_drops_tries_for_ids_the_scanner_forgot() -> None:
    cursor_in = {**CURSOR, "shared_tries": {"GONE00000000000000000000": 1}}
    _raws, cursor = _run_fetch({"ids": {}}, {}, [], cursor=cursor_in)
    assert "shared_tries" not in cursor


def test_fetch_skips_untrusted_organizer_for_good() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    outsider = {**_transcript(SHARED, "2026-10-20T18:00:00.000Z"), "organizer_email": "x@evil.example"}
    raws, cursor = _run_fetch(shared, {SHARED: outsider}, [])
    assert raws == []
    assert SHARED in cursor["shared_seen"]


def test_trusted_organizer_matches_whole_domain_only() -> None:
    trusted = fs.trusted_domains([" Partner.Example ", ""])
    assert trusted == frozenset({"partner.example"})
    assert fs.trusted_organizer({"organizer_email": "Sam@Partner.Example"}, trusted) is True
    assert fs.trusted_organizer({"organizer_email": "x@partner.example.evil.example"}, trusted) is False
    assert fs.trusted_organizer({"organizer_email": "x@notexample.com"}, trusted) is False
    assert fs.trusted_organizer({"organizer_email": None}, trusted) is False
    assert fs.trusted_organizer({"organizer_email": "sam@partner.example"}, ()) is False


def test_fetch_trusts_only_the_domains_in_the_config() -> None:
    """The same meeting is taken or refused depending on the config alone."""
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    transcripts = {SHARED: _transcript(SHARED, "2026-10-20T18:00:00.000Z")}  # sam@partner.example
    taken, _ = _run_fetch(shared, transcripts, [], config=_config(shared=True))
    refused, cursor = _run_fetch(shared, transcripts, [], config=_config(shared=True, trusted=()))
    assert [r["id"] for r in taken] == [SHARED]
    assert refused == [] and SHARED in cursor["shared_seen"]


def test_fetch_does_not_trust_the_owners_own_domain_unless_listed() -> None:
    """The owner's address may be at a public mail provider; its domain is
    trusted only when the config lists it."""
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    same_domain = {**_transcript(SHARED, "2026-10-20T18:00:00.000Z"), "organizer_email": "stranger@example.com"}
    refused, _ = _run_fetch(shared, {SHARED: same_domain}, [], config=_config(shared=True, trusted=()))
    taken, _ = _run_fetch(shared, {SHARED: same_domain}, [], config=_config(shared=True, trusted=("example.com",)))
    assert refused == []
    assert [r["id"] for r in taken] == [SHARED]


def test_fetch_ignores_shared_meetings_when_the_config_turns_them_off() -> None:
    """Off in the config: the scanner's row is never read and nothing is added."""
    engine_config.set_config_for_tests(_config(shared=False))
    with mock.patch.object(fireflies, "_list_stubs", return_value=[]), \
         mock.patch.object(fireflies, "_gql") as gql, \
         mock.patch.object(fireflies, "_read_shared_cursor") as read:
        raws, cursor = fireflies.fetch(CURSOR, sb=object())
    read.assert_not_called()
    gql.assert_not_called()
    assert raws == [] and cursor == CURSOR


def test_shared_meeting_never_takes_a_name_already_in_this_batch() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    own = {**_transcript("OWNMEETING", "2026-10-20T22:00:00.000Z"), "title": f"Meeting {SHARED[:4]}"}
    with mock.patch.object(fireflies, "_list_stubs", return_value=[{"id": "OWNMEETING"}]):
        raws, _ = _run_fetch(shared, {SHARED: _transcript(SHARED, "2026-10-20T18:00:00.000Z"),
                                      "OWNMEETING": own}, [], listing=[{"id": "OWNMEETING"}])
    ids = {r["id"]: fireflies._raw_external_id(r) for r in raws}
    assert ids["OWNMEETING"] == "2026-10-20-meeting-01m4.md"
    assert ids[SHARED] == "2026-10-20-meeting-01m4-shared-01m4vk.md"


def test_shared_meeting_never_takes_a_name_stored_for_another_recording() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    raws, _ = _run_fetch(shared, {SHARED: _transcript(SHARED, "2026-10-20T18:00:00.000Z")}, [],
                         stored={"2026-10-20-meeting-01m4.md"})
    assert fireflies._raw_external_id(raws[0]) == "2026-10-20-meeting-01m4-shared-01m4vk.md"


def test_shared_meeting_keeps_bare_name_when_free() -> None:
    shared = {"ids": {SHARED: "2026-10-20T19:06:09+00:00"}}
    raws, _ = _run_fetch(shared, {SHARED: _transcript(SHARED, "2026-10-20T18:00:00.000Z")}, [])
    assert fireflies._raw_external_id(raws[0]) == "2026-10-20-meeting-01m4.md"


def test_stored_by_other_treats_read_errors_as_taken() -> None:
    assert fireflies._stored_by_other(object(), "x.md", SHARED) is True


TESTS = [
    test_extract_ids_finds_each_id_once,
    test_extract_ids_ignores_other_hosts,
    test_extract_ids_empty_text,
    test_merge_keeps_first_seen_and_prunes_old,
    test_merge_from_empty_cursor,
    test_pending_skips_seen_and_listed_oldest_first,
    test_prune_seen_drops_old_entries,
    test_duplicate_when_own_meeting_starts_close,
    test_duplicate_when_own_bot_joined_late,
    test_not_duplicate_when_back_to_back,
    test_not_duplicate_when_far_apart_or_same_id,
    test_epoch_ms_dates_are_understood,
    test_span_defaults_missing_duration,
    test_shared_meeting_is_marked_and_retention_skips_it,
    test_own_meeting_is_not_marked_shared,
    test_fetch_adds_shared_meeting_without_moving_cursor,
    test_fetch_skips_shared_duplicate_of_own_meeting_and_marks_it_seen,
    test_fetch_skips_already_seen_shared_ids,
    test_fetch_error_on_one_shared_id_does_not_fail_run_or_mark_seen,
    test_fetch_without_sb_skips_shared_lookup,
    test_fetch_shared_cursor_read_failure_keeps_own_meetings,
    test_fetch_gives_up_after_max_tries,
    test_fetch_drops_tries_for_ids_the_scanner_forgot,
    test_fetch_skips_untrusted_organizer_for_good,
    test_trusted_organizer_matches_whole_domain_only,
    test_fetch_trusts_only_the_domains_in_the_config,
    test_fetch_does_not_trust_the_owners_own_domain_unless_listed,
    test_fetch_ignores_shared_meetings_when_the_config_turns_them_off,
    test_shared_meeting_never_takes_a_name_already_in_this_batch,
    test_shared_meeting_never_takes_a_name_stored_for_another_recording,
    test_shared_meeting_keeps_bare_name_when_free,
    test_stored_by_other_treats_read_errors_as_taken,
]


def main() -> int:
    failed = 0
    engine_config.set_config_for_tests(_config(shared=True))
    for test in TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
