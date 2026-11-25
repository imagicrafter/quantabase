"""`pullers.drive`: a full sync that never leaves sensitive rows out."""

from __future__ import annotations

from pullers import drive


def test_fetch_indexes_everything_and_writes_no_token_file(monkeypatch, tmp_path) -> None:
    seen: dict = {}

    def collect(**kwargs):
        seen.update(kwargs)
        return ["doc"], ["audit"]

    monkeypatch.setattr(drive._drive, "collect", collect)
    monkeypatch.chdir(tmp_path)
    documents, cursor = drive.fetch({"ignored": True})
    assert (documents, cursor) == (["doc"], {})
    assert seen == {"include_sensitive": True}
    assert list(tmp_path.iterdir()) == []


def test_the_puller_is_a_full_sync_with_a_raw_copy() -> None:
    assert (drive.SOURCE, drive.FULL_SYNC, drive.BRONZE) == ("drive", True, True)
    assert drive.to_document("x") == "x"
    assert not hasattr(drive, "TOKEN_FILE_PATH")
