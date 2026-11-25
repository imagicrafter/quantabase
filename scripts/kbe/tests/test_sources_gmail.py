"""`kbe sources gmail auth` and `check`: read-only, and no secret is shown."""

from __future__ import annotations

import base64
import copy
import json
import stat
from pathlib import Path

import pytest
import yaml

from kbe import cli, config_store, sources_drive, sources_gmail
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner, make_context
from knowledge.connectors.gmail_fake import FakeGmail, service

READONLY = "https://www.googleapis.com/auth/gmail.readonly"
CLIENT = {"installed": {"client_id": "fake-id", "client_secret": "fake-client-secret-0123456789"}}
TOKEN = {"refresh_token": "1//fake-refresh-token-0123456789", "client_id": "fake-id"}
TOKEN_B64 = base64.b64encode(json.dumps(TOKEN).encode()).decode()
EXAMPLE = yaml.safe_load(
    (Path(__file__).resolve().parents[3] / "config" / "engine.example.yaml").read_text("utf-8")
)
LABELS = [
    {"id": "INBOX", "name": "INBOX", "type": "system"},
    {"id": "L1", "name": "kx/consulting", "type": "user"},
    {"id": "L2", "name": "kx/secret-project-name", "type": "user"},
    {"id": "L3", "name": "share-private", "type": "user"},
]


def _config(**gmail):
    config = copy.deepcopy(EXAMPLE)
    config["sources"]["gmail"].update(gmail)
    return config


def _client_file(tmp_path):
    path = tmp_path / "client.json"
    path.write_text(json.dumps(CLIENT), encoding="utf-8")
    return path


def _flow(token=TOKEN, seen=None):
    def run(path, scopes):
        if seen is not None:
            seen.append((path, tuple(scopes)))
        return json.dumps(token)
    return run


def _mailbox(email="owner@example.com"):
    fake = FakeGmail(email=email, labels=LABELS, threads={})
    return fake, (lambda _info: service(fake))


# --- sign-in -------------------------------------------------------------------


def test_the_scope_is_read_only():
    assert sources_gmail.GMAIL_SCOPES == (READONLY,)


def test_sign_in_asks_for_read_only_gmail_and_returns_one_secret(tmp_path):
    seen = []
    path = _client_file(tmp_path)
    values = sources_gmail.sign_in(path, _flow(seen=seen))
    assert seen == [(path, (READONLY,))]
    assert list(values) == ["GMAIL_TOKEN_JSON_B64"]
    assert json.loads(base64.b64decode(values["GMAIL_TOKEN_JSON_B64"])) == TOKEN
    assert "\n" not in values["GMAIL_TOKEN_JSON_B64"]


def test_sign_in_failures_carry_no_secret(tmp_path):
    def cancelled(_path, _scopes):
        raise RuntimeError("fake-client-secret-0123456789")

    with pytest.raises(KbeError) as caught:
        sources_gmail.sign_in(_client_file(tmp_path), cancelled)
    assert str(caught.value) == "The Google sign-in did not finish (RuntimeError)."
    with pytest.raises(KbeError, match="no refresh token"):
        sources_gmail.sign_in(_client_file(tmp_path), _flow(token={"token": "short-lived"}))
    with pytest.raises(KbeError, match="not an OAuth client file"):
        bad = tmp_path / "bad.json"
        bad.write_text("{}", encoding="utf-8")
        sources_gmail.sign_in(bad, cancelled)


def test_auth_to_the_clipboard_never_prints_the_secret(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(sources_drive, "run_flow", _flow())
    monkeypatch.setattr(sources_drive.sys, "platform", "darwin")
    runner = FakeRunner()
    ctx, lines = make_context(tmp_path, runner=runner, confirm=lambda _q: True)
    argv = ["sources", "gmail", "auth", "--client-secret", str(_client_file(tmp_path)), "--clipboard"]
    assert cli.main(argv, ctx) == 0

    assert [call["argv"] for call in runner.calls] == [["pbcopy"]] * 2
    token, cleared = (call["stdin"] for call in runner.calls)
    assert json.loads(base64.b64decode(token)) == TOKEN and cleared == ""
    captured = capsys.readouterr()
    shown = "\n".join([*lines, captured.out, captured.err,
                       *(" ".join(call["argv"]) for call in runner.calls)])
    assert token not in shown and TOKEN["refresh_token"] not in shown
    assert "GMAIL_TOKEN_JSON_B64" in shown and "puller-gmail" in shown
    assert "read-only" in shown and "Clipboard cleared." in shown
    assert not ctx.state_file.exists(), "nothing is written to local state"


def test_auth_to_a_file_is_owner_only_and_never_replaces_one(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(sources_drive, "run_flow", _flow())
    ctx, lines = make_context(tmp_path)
    out = tmp_path / "gmail.env"
    argv = ["sources", "gmail", "auth", "--client-secret", str(_client_file(tmp_path)),
            "--out", str(out)]
    assert cli.main(argv, ctx) == 0
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    assert out.read_text().startswith("GMAIL_TOKEN_JSON_B64=")
    assert TOKEN["refresh_token"] not in "\n".join(lines) + capsys.readouterr().out
    assert cli.main(argv, ctx) != 0, "an existing file is never replaced"


# --- check ---------------------------------------------------------------------


def test_check_passes_and_counts_tag_labels_without_naming_them():
    fake, build = _mailbox()
    settings = sources_gmail.settings_from(_config())
    check = sources_gmail.check_gmail({"GMAIL_TOKEN_JSON_B64": TOKEN_B64}, settings, build)
    assert check.ok, check.line()
    assert check.line() == (
        "gmail: ok - the sign-in can read labels (read-only); "
        "2 label(s) start with kx/"
    )
    assert "secret-project-name" not in check.line()
    assert [c[0] for c in fake.calls] == ["profile", "labels"], "no thread is listed or read"


def test_check_uses_the_sources_own_prefix():
    _fake, build = _mailbox()
    settings = sources_gmail.settings_from(_config(prefix="share-"))
    check = sources_gmail.check_gmail({"GMAIL_TOKEN_JSON_B64": TOKEN_B64}, settings, build)
    assert check.detail.endswith("1 label(s) start with share-")


def test_check_fails_when_the_sign_in_is_for_another_mailbox():
    _fake, build = _mailbox("someone.else@example.com")
    settings = sources_gmail.settings_from(_config())
    check = sources_gmail.check_gmail({"GMAIL_TOKEN_JSON_B64": TOKEN_B64}, settings, build)
    assert not check.ok
    assert "another mailbox" in check.detail and "owner@example.com" in check.detail
    assert "someone.else" not in check.line(), "what Gmail returned is never shown"


def test_check_follows_the_mailbox_named_in_the_config():
    _fake, build = _mailbox("shared@example.com")
    settings = sources_gmail.settings_from(_config(mailboxes=[{"email": "shared@example.com"}]))
    assert settings.mailbox == "shared@example.com"
    assert sources_gmail.check_gmail({"GMAIL_TOKEN_JSON_B64": TOKEN_B64}, settings, build).ok


def test_check_without_a_config_only_proves_the_sign_in_works():
    _fake, build = _mailbox("anyone@example.com")
    settings = sources_gmail.settings_from(None)
    assert settings == sources_gmail.GmailSettings(None, None)
    check = sources_gmail.check_gmail({"GMAIL_TOKEN_JSON_B64": TOKEN_B64}, settings, build)
    assert check.ok
    assert check.detail == (
        "the sign-in can read labels (read-only); no Engine config was found, "
        "so the mailbox and the label prefix were not checked"
    )


def test_an_invalid_config_is_treated_as_no_config():
    assert sources_gmail.settings_from({"version": 1}) == sources_gmail.GmailSettings(None, None)


@pytest.mark.parametrize(
    "value, expected",
    [
        ("", "GMAIL_TOKEN_JSON_B64 is not set"),
        ("not base64 !!", "not base64 of a JSON file"),
        (base64.b64encode(b'{"token": "x"}').decode(), "has no refresh token"),
    ],
)
def test_unusable_values_never_reach_google(value, expected):
    def never(_info):
        raise AssertionError("no client for an unusable value")

    check = sources_gmail.check_gmail(
        {"GMAIL_TOKEN_JSON_B64": value}, sources_gmail.GmailSettings(None, None), never)
    assert not check.ok and expected in check.detail


def test_a_refused_sign_in_shows_only_the_kind_of_error():
    def refused(_info):
        raise RuntimeError(TOKEN["refresh_token"])

    check = sources_gmail.check_gmail(
        {"GMAIL_TOKEN_JSON_B64": TOKEN_B64}, sources_gmail.GmailSettings(None, None), refused)
    assert check.line() == "gmail: FAILED: Google refused the sign-in (RuntimeError)"


def test_check_command_reads_the_applied_config(tmp_path, monkeypatch):
    _fake, build = _mailbox()

    class Store:
        def get(self):
            return _config()

    monkeypatch.setattr(config_store, "choose", lambda *_a: Store())
    monkeypatch.setattr(sources_gmail, "build_gmail", build)
    ctx, lines = make_context(tmp_path)
    ctx.env_file.write_text(f"GMAIL_TOKEN_JSON_B64={TOKEN_B64}\n", encoding="utf-8")
    assert cli.main(["sources", "gmail", "check"], ctx) == 0
    assert lines == ["gmail: ok - the sign-in can read labels (read-only); 2 label(s) start with kx/"]


def test_check_command_still_runs_when_the_config_cannot_be_read(tmp_path, monkeypatch):
    _fake, build = _mailbox()

    def no_database(*_args):
        raise KbeError("No way to reach the database.")

    monkeypatch.setattr(config_store, "choose", no_database)
    monkeypatch.setattr(sources_gmail, "build_gmail", build)
    ctx, lines = make_context(tmp_path)
    ctx.env_file.write_text(f"GMAIL_TOKEN_JSON_B64={TOKEN_B64}\n", encoding="utf-8")
    assert cli.main(["sources", "gmail", "check"], ctx) == 0
    assert "no Engine config was found" in lines[0]
