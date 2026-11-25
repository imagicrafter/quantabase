"""The Gmail puller: off unless the config turns it on, and a full sync."""

from __future__ import annotations

import base64
import dataclasses
import json

import pytest

from knowledge import engine_config
from knowledge.connectors.gmail_fake import FakeGmail, message, service
from pullers import gmail, runner

OWNER = "owner@example.com"
LABELS = [{"id": "L1", "name": "kx/consulting", "type": "user"}]


def _b64(obj: dict) -> str:
    return base64.b64encode(json.dumps(obj).encode()).decode()


def _turn_on(config, **changes):
    source = dataclasses.replace(config.sources.gmail, enabled=True, **changes)
    updated = dataclasses.replace(config, sources=dataclasses.replace(config.sources, gmail=source))
    engine_config.set_config_for_tests(updated)
    return updated


@pytest.fixture
def mailbox(monkeypatch):
    """A stand-in mailbox the puller reads instead of building a real client."""
    fake = FakeGmail(email=OWNER, labels=LABELS, threads={"t1": [message("m1", ["L1"])]})
    monkeypatch.setattr(gmail, "_service", lambda: service(fake))
    return fake


class _Rows:
    def __init__(self, rows):
        self._rows = sorted(rows, key=lambda row: row["external_id"])
        self.filters = []
        self.pages = []
        self._range = (0, None)

    def select(self, *_columns):
        return self

    def order(self, column):
        assert column == "external_id"
        return self

    def range(self, start, end):
        self._range = (start, end)
        self.pages.append((start, end))
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def is_(self, column, value):
        self.filters.append(("is", column, value))
        return self

    def execute(self):
        start, end = self._range
        page = self._rows[start:] if end is None else self._rows[start : end + 1]
        return type("Resp", (), {"data": page})()


class _Sb:
    def __init__(self, rows):
        self.rows = _Rows(rows)

    def schema(self, _name):
        return self

    def table(self, name):
        assert name == "documents"
        return self.rows


# --- the contract and the switch ----------------------------------------------


def test_it_is_a_full_sync_that_keeps_no_raw_copy():
    assert gmail.SOURCE == "gmail"
    assert gmail.FULL_SYNC is True
    assert gmail.BRONZE is False, "raw captures are never deleted; mail must be removable"
    assert gmail.REDACT_ERRORS is True


def test_it_is_off_by_default():
    assert gmail.enabled() is False


def test_it_is_on_when_the_config_says_so(example_config):
    _turn_on(example_config)
    assert gmail.enabled() is True


def test_fetch_refuses_to_run_while_off(mailbox):
    with pytest.raises(gmail.GmailDisabledError):
        gmail.fetch({}, sb=None)
    assert mailbox.calls == []


def test_confirm_absent_does_nothing_while_off(mailbox):
    assert gmail.confirm_absent([], _Sb([{"external_id": "t9"}])) == frozenset()
    assert mailbox.calls == []


def test_the_runner_does_not_start_a_gmail_run_while_off(monkeypatch, capsys):
    def never(*_args, **_kwargs):
        raise AssertionError("the run must not start")

    monkeypatch.setattr(runner, "get_supabase_ingest", never)
    monkeypatch.setattr(runner.access_gate, "check", never)
    monkeypatch.setattr(runner, "run_source", never)
    monkeypatch.setattr("sys.argv", ["runner", "--source", "gmail"])
    assert runner.main() == 0
    assert "off in the Engine config" in capsys.readouterr().out


# --- a run --------------------------------------------------------------------


def test_fetch_returns_the_labelled_threads_with_their_owner(example_config, mailbox):
    _turn_on(example_config)
    documents, cursor = gmail.fetch({"history_id": "9"}, sb=None)
    documents = list(documents)
    assert [(d.external_id, d.domains, d.owner_email) for d in documents] == [
        ("t1", ("consulting",), OWNER)
    ]
    assert cursor == {}
    assert gmail.to_document(documents[0]) is documents[0]


def test_fetch_uses_the_mailbox_and_owner_from_the_config(example_config, monkeypatch):
    from knowledge.engine_config_gmail import Mailbox

    _turn_on(example_config, mailboxes=(Mailbox("shared@example.com", "pat@example.com"),))
    fake = FakeGmail(email="shared@example.com", labels=LABELS,
                     threads={"t1": [message("m1", ["L1"])]})
    monkeypatch.setattr(gmail, "_service", lambda: service(fake))
    (document,) = list(gmail.fetch({}, sb=None)[0])
    assert document.owner_email == "pat@example.com"
    assert document.metadata["mailbox"] == "shared@example.com"


def test_confirm_absent_checks_only_live_rows_that_were_not_fetched(example_config, mailbox):
    _turn_on(example_config)
    documents = list(gmail.fetch({}, sb=None)[0])
    mailbox.threads["still"] = [message("m2", ["L1"])]
    mailbox.threads["unlabelled"] = [message("m3", ["INBOX"])]
    mailbox.calls.clear()
    sb = _Sb([{"external_id": "t1"}, {"external_id": "still"},
              {"external_id": "unlabelled"}, {"external_id": "deleted"}])

    confirmed = gmail.confirm_absent(documents, sb)

    assert confirmed == frozenset({"unlabelled", "deleted"})
    assert sorted(mailbox.fetched()) == ["deleted", "still", "unlabelled"]
    assert ("eq", "source", "gmail") in sb.rows.filters
    assert ("is", "deleted_at", "null") in sb.rows.filters


def test_confirm_absent_reads_every_page_of_live_rows(example_config, mailbox, monkeypatch):
    _turn_on(example_config)
    monkeypatch.setattr(gmail, "PAGE_SIZE", 2)
    sb = _Sb([{"external_id": f"old{i}"} for i in range(5)])
    confirmed = gmail.confirm_absent([], sb)
    assert confirmed == frozenset(f"old{i}" for i in range(5))
    assert sb.rows.pages == [(0, 1), (2, 3), (4, 5)]


def test_confirm_absent_asks_gmail_nothing_when_nothing_is_absent(example_config, mailbox):
    _turn_on(example_config)
    documents = list(gmail.fetch({}, sb=None)[0])
    mailbox.calls.clear()
    assert gmail.confirm_absent(documents, _Sb([{"external_id": "t1"}])) == frozenset()
    assert mailbox.calls == []


# --- the stored sign-in -------------------------------------------------------


@pytest.fixture
def paths(tmp_path, monkeypatch):
    env_file = tmp_path / "dotenv"
    token = tmp_path / "gmail-token.json"
    monkeypatch.setattr(gmail, "ENV_FILE", env_file)
    monkeypatch.setattr(gmail, "TOKEN_FILE_PATH", token)
    return env_file, token


def test_writes_the_token_file_from_its_secret(paths):
    env_file, token = paths
    env_file.write_text(f"GMAIL_TOKEN_JSON_B64={_b64({'refresh_token': 'r'})}\n")
    gmail._ensure_token_file()
    assert json.loads(token.read_text()) == {"refresh_token": "r"}
    assert token.stat().st_mode & 0o777 == 0o600


def test_keeps_a_token_file_that_is_already_there(paths):
    env_file, token = paths
    token.write_text("local")
    env_file.write_text(f"GMAIL_TOKEN_JSON_B64={_b64({'refresh_token': 'r'})}\n")
    gmail._ensure_token_file()
    assert token.read_text() == "local"


def test_a_malformed_token_secret_is_an_error_that_does_not_show_it(paths):
    env_file, _token = paths
    env_file.write_text("GMAIL_TOKEN_JSON_B64=not*base64*at*all\n")
    with pytest.raises(gmail.GmailTokenError) as caught:
        gmail._ensure_token_file()
    assert "not*base64" not in str(caught.value)


def test_no_token_anywhere_is_a_clear_error(paths, example_config):
    _turn_on(example_config)
    with pytest.raises(gmail.GmailTokenError, match="GMAIL_TOKEN_JSON_B64"):
        gmail.fetch({}, sb=None)


# --- the runner passes confirmations to ingest --------------------------------


def test_the_runner_hands_confirmed_removals_to_ingest(monkeypatch):
    seen = {}

    class Lock:
        def __enter__(self):
            return True

        def __exit__(self, *_exc):
            return False

    puller = type("P", (), {
        "SOURCE": "gmail", "FULL_SYNC": True, "BRONZE": False,
        "fetch": staticmethod(lambda cursor, sb=None: ([], {})),
        "to_document": staticmethod(lambda raw: raw),
        "confirm_absent": staticmethod(lambda documents, sb: frozenset({"gone"})),
    })

    def upsert(documents, **kwargs):
        seen.update(kwargs)
        return runner.ingest.IngestResult("gmail", 0, 0, 0, 0, 1, 0, 0)

    monkeypatch.setitem(runner.REGISTRY, "gmail", puller)
    monkeypatch.setattr(runner, "get_supabase_ingest", lambda: object())
    monkeypatch.setattr(runner.cursors, "with_lock", lambda *a, **k: Lock())
    monkeypatch.setattr(runner.cursors, "get_cursor", lambda *a, **k: {})
    monkeypatch.setattr(runner.ingest, "upsert", upsert)

    receipt = runner.run_source("gmail", dry_run=True)

    assert receipt.ok and seen["confirmed_absent"] == frozenset({"gone"})
    assert seen["full_sync"] is True and seen["dry_run"] is True


def test_a_puller_with_no_confirmations_passes_none(monkeypatch):
    assert runner.confirmed_absent(type("P", (), {})(), [], None) == frozenset()


# --- what a failed run stores -------------------------------------------------


def test_a_failed_gmail_run_stores_no_row_content():
    """A database error can quote the row it refused; that must not reach the
    status page, where every administrator reads the last error."""
    error = RuntimeError(
        'Upsert failed: Failing row contains (t1, "Offer for Sam", salary is 90000, '
        "sam@partner.example)\nsecond line with the body"
    )
    stored = runner.error_text(gmail, error)
    assert stored.startswith("RuntimeError: Upsert failed")
    for leaked in ("Offer for Sam", "salary", "sam@partner.example", "second line"):
        assert leaked not in stored


def test_other_sources_keep_their_full_error_text():
    plain = type("P", (), {})()
    assert runner.error_text(plain, ValueError("refusing 3/10 (30%)")) == (
        "ValueError: refusing 3/10 (30%)")
