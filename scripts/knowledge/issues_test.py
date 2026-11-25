"""`knowledge.issues`: redaction, short-outage detection, the calls it makes."""

from __future__ import annotations

import socket

import pytest

from knowledge import issues

SECRET_TITLE = "Quarterly Pricing Review"
PERSON = "Pat Owner"


class FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code


class HTTPError(Exception):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.response = FakeResponse(status_code)


class GoogleStyleError(Exception):
    def __init__(self, status: int):
        super().__init__("request failed")
        self.resp = type("Resp", (), {"status": status})()


class ReadTimeout(Exception):
    """Named like the HTTP libraries' timeout classes."""


class FakeSb:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def schema(self, name: str):
        assert name == "workspace"
        return self

    def rpc(self, fn: str, params: dict):
        self.calls.append((fn, params))
        return self

    def execute(self):
        return type("Resp", (), {"data": None})()


# -- redaction ---------------------------------------------------------------

@pytest.mark.parametrize(
    "message",
    [
        f"transcript 01ABC has no sentences (sentences=empty, duration=5 min, title={SECRET_TITLE})",
        f"could not write page '{SECRET_TITLE}' to the wiki",
        f'could not write page "{SECRET_TITLE}"',
        f"could not write page \u201c{SECRET_TITLE}\u201d",
        f"title={SECRET_TITLE}, id=7",
        f"Title: {SECRET_TITLE}",
        f"subject = {SECRET_TITLE} and more",
        f"upload failed: {{'title': '{SECRET_TITLE}', 'id': 3}}",
        f"API error: [{{'message': 'bad', 'path': ['{SECRET_TITLE}']}}]",
        f"meeting with {PERSON} could not be stored",
        f"participants: {PERSON}, Sam Other",
        f"cannot read /srv/knowledge/meetings/{SECRET_TITLE.replace(' ', '-')}.md",
        f"failed while handling {SECRET_TITLE}",
        f"file name: {SECRET_TITLE}.docx is too large",
        f"bad row (see {SECRET_TITLE}) and then ({PERSON})",
    ],
)
def test_redact_drops_titles_and_names(message: str) -> None:
    cleaned = issues.redact(message)
    assert SECRET_TITLE not in cleaned
    assert "Pricing" not in cleaned
    assert PERSON not in cleaned and "Owner" not in cleaned


def test_redact_drops_email_addresses() -> None:
    cleaned = issues.redact("no access for pat.owner+x@example.com on drive")
    assert "@" not in cleaned and "pat.owner" not in cleaned
    assert cleaned == "no access for <email> on drive"


def test_redact_keeps_only_the_host_of_a_link() -> None:
    cleaned = issues.redact(
        "GET https://api.example.com/v1/files/abc?key=s3cr3t&name=Budget#top returned 500"
    )
    assert cleaned == "GET https://api.example.com returned 500"


def test_redact_drops_credentials_inside_a_link() -> None:
    cleaned = issues.redact("clone of https://user:hunter2@git.example.com/acme/wiki.git failed")
    assert "hunter2" not in cleaned and "user" not in cleaned and "acme" not in cleaned


@pytest.mark.parametrize(
    "token",
    [
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
        "d41d8cd98f00b204e9800998ecf8427e",
        "0123456789abcdef0123",
        "3f2b8c1e-9a4d-4c7b-8e21-5d6f7a8b9c0d",
        "AKIAIOSFODNN7EXAMPLEKEY12",
        "c2VjcmV0LXZhbHVlLXNlY3JldC12YWx1ZQ==",
    ],
)
def test_redact_drops_long_tokens_and_hex(token: str) -> None:
    cleaned = issues.redact(f"auth failed with {token} today")
    assert token not in cleaned
    assert cleaned.startswith("auth failed with <") and cleaned.endswith("today")


def test_redact_keeps_only_the_first_line() -> None:
    body = "upstream said no\n# Meeting notes\nWe agreed the price is 40.\nSecond paragraph."
    cleaned = issues.redact(body)
    assert cleaned == "upstream said no"


def test_redact_skips_leading_blank_lines() -> None:
    assert issues.redact("\n\n  boom  \nrest") == "boom"


def test_redact_drops_file_paths() -> None:
    cleaned = issues.redact("could not open /home/app/data/export.csv or C:\\Users\\pat\\notes.txt now")
    assert "export" not in cleaned and "notes" not in cleaned and "Users" not in cleaned
    assert cleaned == "could not open <path> or <path> now"


def test_redact_caps_length() -> None:
    assert len(issues.redact("word " * 400)) == issues.MAX_DETAIL
    assert len(issues.redact("word " * 400, cap=20)) == 20
    assert issues.redact("x", cap=-1) == ""


@pytest.mark.parametrize("value", [None, "", "   ", "\n\n"])
def test_redact_handles_empty_input(value) -> None:
    assert issues.redact(value) == ""


def test_redact_keeps_a_plain_technical_message() -> None:
    message = "HTTP 500 from upstream while listing changes"
    assert issues.redact(message) == message


def test_redact_is_stable_when_run_twice() -> None:
    once = issues.redact(f"failed for pat@example.com on '{SECRET_TITLE}' at https://x.example.com/a?b=c")
    assert issues.redact(once) == once


# -- building the issue ------------------------------------------------------

def test_from_exception_uses_a_fixed_title_and_redacted_detail() -> None:
    error = RuntimeError(f"sync failed: title={SECRET_TITLE}")
    issue = issues.from_exception("drive", error)
    assert issue.category == "source_failure"
    assert issue.title == "drive run failed"
    assert issue.source == "drive"
    assert issue.error_class == "RuntimeError"
    assert issue.dedupe_key == "run-drive"
    assert SECRET_TITLE not in issue.detail and SECRET_TITLE not in issue.title


def test_issue_is_immutable() -> None:
    issue = issues.from_exception("wiki", ValueError("x"))
    with pytest.raises(Exception):
        issue.title = "changed"  # type: ignore[misc]


def test_error_class_is_only_identifier_characters() -> None:
    odd = type("Bad Name<script>", (Exception,), {})
    assert issues.error_class_of(odd()) == "BadNamescript"
    assert len(issues.error_class_of(type("E" * 300, (Exception,), {})())) == issues.MAX_ERROR_CLASS


# -- short outages -----------------------------------------------------------

@pytest.mark.parametrize("status", [502, 503, 504])
def test_gateway_statuses_are_short_outages(status: int) -> None:
    assert issues.is_short_outage(HTTPError("bad gateway", status))
    assert issues.is_short_outage(GoogleStyleError(status))
    assert issues.is_short_outage(RuntimeError(f"sync failed: HTTP {status}: upstream"))
    assert issues.is_short_outage(RuntimeError(f"status code {status}"))


@pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500])
def test_other_statuses_are_not_short_outages(status: int) -> None:
    assert not issues.is_short_outage(HTTPError("nope", status))
    assert not issues.is_short_outage(GoogleStyleError(status))
    assert not issues.is_short_outage(RuntimeError(f"sync failed: HTTP {status}"))


def test_timeouts_are_short_outages() -> None:
    assert issues.is_short_outage(TimeoutError("timed out"))
    assert issues.is_short_outage(socket.timeout("timed out"))
    assert issues.is_short_outage(ReadTimeout("read timed out"))


def test_a_wrapped_short_outage_is_found_through_the_chain() -> None:
    try:
        try:
            raise HTTPError("bad gateway", 503)
        except HTTPError as inner:
            raise RuntimeError("drive sync failed") from inner
    except RuntimeError as outer:
        assert issues.is_short_outage(outer)


def test_rate_limit_is_never_a_short_outage_even_with_a_timeout_around_it() -> None:
    try:
        try:
            raise HTTPError("slow down", 429)
        except HTTPError:
            raise TimeoutError("gave up waiting")
    except TimeoutError as outer:
        assert not issues.is_short_outage(outer)


@pytest.mark.parametrize(
    "error",
    [ValueError("bad value"), KeyError("k"), RuntimeError("token expired"), ConnectionRefusedError("refused")],
)
def test_ordinary_errors_are_not_short_outages(error: BaseException) -> None:
    assert not issues.is_short_outage(error)


def test_a_cycle_in_the_chain_does_not_loop() -> None:
    first, second = RuntimeError("a"), RuntimeError("b")
    first.__cause__, second.__cause__ = second, first
    assert not issues.is_short_outage(first)


# -- the calls ---------------------------------------------------------------

def test_upsert_calls_the_database_function() -> None:
    sb = FakeSb()
    issues.upsert(sb, issues.from_exception("drive", HTTPError("HTTP 500", 500)))
    assert sb.calls == [(
        "issue_upsert",
        {
            "p_category": "source_failure",
            "p_title": "drive run failed",
            "p_detail": "HTTP 500",
            "p_source": "drive",
            "p_error_class": "HTTPError",
            "p_dedupe_key": "run-drive",
        },
    )]


def test_close_calls_the_database_function() -> None:
    sb = FakeSb()
    issues.close(sb, "run-drive", "clean run at 2026-01-01T00:00:00Z")
    assert sb.calls == [(
        "issue_close_by_key",
        {"p_dedupe_key": "run-drive", "p_proof": "clean run at 2026-01-01T00:00:00Z"},
    )]
