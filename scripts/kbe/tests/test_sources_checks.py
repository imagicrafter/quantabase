"""`kbe sources ... check`: one read, pass or fail, and never any data."""

from __future__ import annotations

import base64
import json

import pytest

from kbe import cli, sources_checks, state
from kbe.tests.helpers import make_context

GH_TOKEN = "ghp_fake_token_0123456789abcdef"
FF_KEY = "ff-fake-key-0123456789abcdef"
TOKEN_INFO = {
    "refresh_token": "1//fake-refresh-token-0123456789",
    "client_id": "fake-id.apps.googleusercontent.com",
    "client_secret": "fake-client-secret-0123456789",
    "token_uri": "https://oauth2.googleapis.com/token",
}
TOKEN_B64 = base64.b64encode(json.dumps(TOKEN_INFO).encode()).decode()


def _ctx(tmp_path, lines=""):
    tmp_path.mkdir(parents=True, exist_ok=True)
    ctx, seen = make_context(tmp_path)
    ctx.env_file.write_text(lines or "UNRELATED=1\n", encoding="utf-8")
    return ctx, seen


class Gets:
    """Answers GET requests by the end of the URL; records every call."""

    def __init__(self, repo=200, config=200):
        self.repo, self.config, self.calls = repo, config, []

    def __call__(self, url, headers):
        self.calls.append((url, dict(headers)))
        return self.config if url.endswith("engine.yaml") else self.repo


# --- wiki ----------------------------------------------------------------------


def test_wiki_ok_reads_repo_and_config_with_the_token_in_a_header():
    get = Gets()
    check = sources_checks.check_wiki({"GITHUB_TOKEN": GH_TOKEN}, "acme/knowledge", get)
    assert check.ok and check.line().startswith("wiki: ok")
    assert [url for url, _ in get.calls] == [
        "https://api.github.com/repos/acme/knowledge",
        "https://api.github.com/repos/acme/knowledge/contents/.kb-engine/engine.yaml",
    ]
    for url, headers in get.calls:
        assert GH_TOKEN not in url
        assert headers["Authorization"] == f"Bearer {GH_TOKEN}"
        assert headers["User-Agent"] == "kbe-cli"
    assert GH_TOKEN not in check.line()


def test_wiki_falls_back_to_gh_token():
    assert sources_checks.check_wiki({"GH_TOKEN": GH_TOKEN}, "acme/knowledge", Gets()).ok


@pytest.mark.parametrize(
    "repo_status, config_status, expected",
    [
        (401, 200, "token was refused (HTTP 401)"),
        (403, 200, "token was refused (HTTP 403)"),
        (404, 200, "not found with this token (HTTP 404)"),
        (200, 404, "has no .kb-engine/engine.yaml"),
        (200, 500, "could not look for .kb-engine/engine.yaml (HTTP 500)"),
    ],
)
def test_wiki_failures_are_short_and_carry_no_data(repo_status, config_status, expected):
    check = sources_checks.check_wiki(
        {"GITHUB_TOKEN": GH_TOKEN}, "acme/knowledge", Gets(repo_status, config_status)
    )
    assert not check.ok and expected in check.detail
    assert check.line().startswith("wiki: FAILED: ") and GH_TOKEN not in check.line()


def test_wiki_needs_a_repo_and_a_token_and_survives_no_network():
    def fail(*_args):
        raise AssertionError("no request without a repo or a token")

    assert "pass --repo" in sources_checks.check_wiki({"GITHUB_TOKEN": GH_TOKEN}, None, fail).detail
    missing = sources_checks.check_wiki({}, "acme/knowledge", fail)
    assert not missing.ok and "GITHUB_TOKEN or GH_TOKEN is not set" in missing.detail

    def down(_url, _headers):
        raise ConnectionError(f"refused {GH_TOKEN}")

    offline = sources_checks.check_wiki({"GITHUB_TOKEN": GH_TOKEN}, "acme/knowledge", down)
    assert offline.detail == "could not reach GitHub (ConnectionError)"


def test_wiki_command_uses_the_recorded_repo_or_the_flag(tmp_path, monkeypatch):
    ctx, seen = _ctx(tmp_path, f"GITHUB_TOKEN={GH_TOKEN}\n")
    get = Gets()
    monkeypatch.setattr(sources_checks, "http_get", get)
    assert cli.main(["sources", "wiki", "check"], ctx) == 1
    assert "pass --repo" in seen[-1] and get.calls == []

    state.save(ctx.state_file, state.with_answer(state.empty(), "wiki_repo", "acme/knowledge"))
    assert cli.main(["sources", "wiki", "check"], ctx) == 0
    assert "acme/knowledge is readable" in seen[-1]
    assert cli.main(["sources", "wiki", "check", "--repo", "other/vault"], ctx) == 0
    assert "other/vault" in seen[-1]
    assert all(GH_TOKEN not in line for line in seen)


def test_wiki_command_refuses_a_malformed_repo(tmp_path, capsys):
    ctx, _seen = _ctx(tmp_path, f"GITHUB_TOKEN={GH_TOKEN}\n")
    assert cli.main(["sources", "wiki", "check", "--repo", "https://x/y z"], ctx) == 2
    assert "OWNER/NAME" in capsys.readouterr().err


# --- fireflies -----------------------------------------------------------------


def test_fireflies_ok_sends_the_key_in_a_header_and_shows_no_data():
    calls = []

    def post(url, headers, body):
        calls.append((url, dict(headers), dict(body)))
        return 200, {"data": {"transcripts": [{"id": "secret-meeting-id"}]}}

    check = sources_checks.check_fireflies({"FIREFLIES_API_KEY": FF_KEY}, post)
    assert check.ok and "secret-meeting-id" not in check.line() and FF_KEY not in check.line()
    url, headers, body = calls[0]
    assert url == "https://api.fireflies.ai/graphql" and FF_KEY not in url
    assert headers["Authorization"] == f"Bearer {FF_KEY}"
    assert "limit: 1" in body["query"] and len(calls) == 1


@pytest.mark.parametrize(
    "answer, expected",
    [
        ((401, {"errors": [{"message": "bad key for someone@example.com"}]}), "refused (HTTP 401)"),
        ((200, {"errors": [{"message": "private text"}]}), "answered with an error"),
        ((200, None), "answered with an error"),
        ((200, {"nothing": 1}), "answered with an error"),
    ],
)
def test_fireflies_failures_never_echo_the_answer(answer, expected):
    check = sources_checks.check_fireflies({"FIREFLIES_API_KEY": FF_KEY}, lambda *_a: answer)
    assert not check.ok and expected in check.detail
    assert "example.com" not in check.line() and "private" not in check.line()


def test_fireflies_missing_key_and_no_network():
    assert "FIREFLIES_API_KEY is not set" in sources_checks.check_fireflies({}).detail

    def down(*_args):
        raise TimeoutError(FF_KEY)

    check = sources_checks.check_fireflies({"FIREFLIES_API_KEY": FF_KEY}, down)
    assert check.detail == "could not reach Fireflies (TimeoutError)"


def test_fireflies_command(tmp_path, monkeypatch):
    ctx, seen = _ctx(tmp_path, f"FIREFLIES_API_KEY={FF_KEY}\n")
    monkeypatch.setattr(sources_checks, "http_post", lambda *_a: (200, {"data": {}}))
    assert cli.main(["sources", "fireflies", "check"], ctx) == 0
    assert seen == ["fireflies: ok - the key can list meetings"]


# --- drive ---------------------------------------------------------------------


class DriveService:
    def __init__(self, error=None):
        self.error, self.asked = error, []

    def files(self):
        return self

    def list(self, **kwargs):
        self.asked.append(kwargs)
        return self

    def execute(self):
        if self.error:
            raise self.error
        return {"files": [{"id": "private-file-id"}]}


def test_drive_ok_lists_one_file_id_only():
    service = DriveService()
    built = []

    def build(info):
        built.append(dict(info))
        return service

    check = sources_checks.check_drive({"DRIVE_TOKEN_JSON_B64": TOKEN_B64}, build)
    assert check.ok and "private-file-id" not in check.line()
    assert service.asked == [{"pageSize": 1, "fields": "files(id)"}]
    assert built == [TOKEN_INFO]


def test_drive_scopes_are_read_only():
    assert sources_checks.DRIVE_SCOPES == ("https://www.googleapis.com/auth/drive.readonly",)


@pytest.mark.parametrize(
    "value, expected",
    [
        ("", "DRIVE_TOKEN_JSON_B64 is not set"),
        ("not base64 !!", "not base64 of a JSON file"),
        (base64.b64encode(b"not json").decode(), "not base64 of a JSON file"),
        (base64.b64encode(b'{"token": "x"}').decode(), "has no refresh token"),
    ],
)
def test_drive_unusable_values_never_reach_google(value, expected):
    def build(_info):
        raise AssertionError("must not build a client")

    check = sources_checks.check_drive({"DRIVE_TOKEN_JSON_B64": value}, build)
    assert not check.ok and expected in check.detail


def test_drive_refusal_shows_only_the_error_type():
    service = DriveService(error=PermissionError(TOKEN_INFO["refresh_token"]))
    check = sources_checks.check_drive({"DRIVE_TOKEN_JSON_B64": TOKEN_B64}, lambda _i: service)
    assert check.detail == "Google refused the token (PermissionError)"


def test_drive_command_exit_codes(tmp_path, monkeypatch):
    ctx, seen = _ctx(tmp_path, f"DRIVE_TOKEN_JSON_B64={TOKEN_B64}\n")
    monkeypatch.setattr(sources_checks, "build_drive", lambda _info: DriveService())
    assert cli.main(["sources", "drive", "check"], ctx) == 0
    assert seen[-1].startswith("drive: ok")
    assert all(TOKEN_B64 not in line for line in seen)

    empty, lines = _ctx(tmp_path / "other")
    assert cli.main(["sources", "drive", "check"], empty) == 1
    assert lines[-1].startswith("drive: FAILED: ")


def test_the_real_drive_builder_makes_a_client_without_a_request():
    service = sources_checks.build_drive(TOKEN_INFO)
    assert hasattr(service, "files")


def test_real_http_helpers_wrap_requests(monkeypatch):
    import requests

    class Response:
        status_code = 204

        def json(self):
            raise ValueError("no body")

    monkeypatch.setattr(requests, "get", lambda url, headers, timeout: Response())
    monkeypatch.setattr(requests, "post", lambda url, headers, json, timeout: Response())
    assert sources_checks.http_get("https://example.com", {}) == 204
    assert sources_checks.http_post("https://example.com", {}, {}) == (204, None)


def test_help_exists_for_every_sources_command(capsys):
    for argv in (
        ["sources", "--help"], ["sources", "list", "--help"], ["sources", "wiki", "--help"],
        ["sources", "wiki", "check", "--help"], ["sources", "fireflies", "check", "--help"],
        ["sources", "drive", "--help"], ["sources", "drive", "auth", "--help"],
        ["sources", "drive", "check", "--help"],
    ):
        with pytest.raises(SystemExit) as stopped:
            cli.main(argv)
        assert stopped.value.code == 0
        assert len(capsys.readouterr().out) > 120, argv
