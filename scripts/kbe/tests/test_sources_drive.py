"""`kbe sources drive auth`: the secrets reach the clipboard or a 0600 file, and
nowhere else."""

from __future__ import annotations

import base64
import json
import stat

import pytest

from kbe import cli, proc, sources_drive
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner, make_context

CLIENT = {"installed": {"client_id": "fake-id", "client_secret": "fake-client-secret-0123456789"}}
TOKEN = {"refresh_token": "1//fake-refresh-token-0123456789", "client_id": "fake-id"}


def _client_file(tmp_path, data=CLIENT):
    path = tmp_path / "client.json"
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _flow(token=TOKEN, seen=None):
    def run(path, scopes):
        if seen is not None:
            seen.append((path, tuple(scopes)))
        return json.dumps(token)
    return run


def _decoded(value):
    return json.loads(base64.b64decode(value))


@pytest.fixture
def signed_in(monkeypatch):
    seen = []
    monkeypatch.setattr(sources_drive, "run_flow", _flow(seen=seen))
    return seen


def _all_text(runner, lines, capsys):
    argv = " ".join(" ".join(call["argv"]) for call in runner.calls)
    captured = capsys.readouterr()
    return "\n".join([argv, *lines, captured.out, captured.err])


# --- sign-in -------------------------------------------------------------------


def test_sign_in_asks_for_read_only_drive_and_returns_both_secrets(tmp_path):
    seen = []
    path = _client_file(tmp_path)
    values = sources_drive.sign_in(path, _flow(seen=seen))
    assert seen == [(path, ("https://www.googleapis.com/auth/drive.readonly",))]
    assert list(values) == ["DRIVE_TOKEN_JSON_B64", "DRIVE_TOKEN_CLIENT_JSON_B64"]
    assert _decoded(values["DRIVE_TOKEN_JSON_B64"]) == TOKEN
    assert _decoded(values["DRIVE_TOKEN_CLIENT_JSON_B64"]) == CLIENT
    assert "\n" not in values["DRIVE_TOKEN_JSON_B64"]


def test_sign_in_refuses_a_file_that_is_not_an_oauth_client(tmp_path):
    def never(*_args):
        raise AssertionError("no sign-in for a bad client file")

    with pytest.raises(KbeError, match="not an OAuth client file"):
        sources_drive.sign_in(_client_file(tmp_path, {"type": "service_account"}), never)
    broken = tmp_path / "broken.json"
    broken.write_text("{", encoding="utf-8")
    with pytest.raises(KbeError, match="not a JSON file"):
        sources_drive.sign_in(broken, never)
    with pytest.raises(KbeError, match="Could not read"):
        sources_drive.sign_in(tmp_path / "missing.json", never)


def test_sign_in_failures_carry_no_secret(tmp_path):
    def cancelled(_path, _scopes):
        raise RuntimeError("fake-client-secret-0123456789")

    with pytest.raises(KbeError) as caught:
        sources_drive.sign_in(_client_file(tmp_path), cancelled)
    assert str(caught.value) == "The Google sign-in did not finish (RuntimeError)."
    with pytest.raises(KbeError, match="no refresh token"):
        sources_drive.sign_in(_client_file(tmp_path), _flow(token={"token": "short-lived"}))


def test_the_real_flow_uses_the_installed_app_flow(tmp_path, monkeypatch):
    from google_auth_oauthlib import flow as google_flow

    class Credentials:
        def to_json(self):
            return json.dumps(TOKEN)

    class Flow:
        def run_local_server(self, port):
            assert port == 0
            return Credentials()

    asked = []

    def from_file(path, scopes):
        asked.append((path, scopes))
        return Flow()

    monkeypatch.setattr(google_flow.InstalledAppFlow, "from_client_secrets_file", from_file)
    path = _client_file(tmp_path)
    assert json.loads(sources_drive.run_flow(path, sources_drive.DRIVE_SCOPES)) == TOKEN
    assert asked == [(str(path), list(sources_drive.DRIVE_SCOPES))]


# --- clipboard -----------------------------------------------------------------


def test_clipboard_gets_each_value_on_stdin_then_is_cleared(tmp_path, signed_in, capsys, monkeypatch):
    monkeypatch.setattr(sources_drive.sys, "platform", "darwin")
    runner = FakeRunner()
    ctx, lines = make_context(tmp_path, runner=runner, confirm=lambda _q: True)
    argv = ["sources", "drive", "auth", "--client-secret", str(_client_file(tmp_path)), "--clipboard"]
    assert cli.main(argv, ctx) == 0

    assert [call["argv"] for call in runner.calls] == [["pbcopy"]] * 3
    token, client, cleared = (call["stdin"] for call in runner.calls)
    assert _decoded(token) == TOKEN and _decoded(client) == CLIENT and cleared == ""
    shown = _all_text(runner, lines, capsys)
    assert token not in shown and client not in shown, "a secret is never printed or on argv"
    assert "DRIVE_TOKEN_JSON_B64" in shown and "DRIVE_TOKEN_CLIENT_JSON_B64" in shown
    assert "puller-drive" in shown and "Clipboard cleared." in shown
    assert not ctx.state_file.exists(), "nothing is written to local state"


def test_clipboard_is_cleared_even_when_the_user_stops(tmp_path, signed_in, capsys, monkeypatch):
    monkeypatch.setattr(sources_drive.sys, "platform", "darwin")
    runner = FakeRunner()
    ctx, _lines = make_context(tmp_path, runner=runner, confirm=lambda _q: False)
    argv = ["sources", "drive", "auth", "--client-secret", str(_client_file(tmp_path)), "--clipboard"]
    assert cli.main(argv, ctx) == 1
    assert "Stopped" in capsys.readouterr().err
    assert [call["stdin"] for call in runner.calls][-1] == "" and len(runner.calls) == 2


def test_other_platforms_try_their_own_tools_in_order(tmp_path, monkeypatch):
    monkeypatch.setattr(sources_drive.sys, "platform", "linux")
    runner = FakeRunner({"wl-copy": proc.ProcResult(proc.NOT_FOUND, "", "")})
    ctx, _lines = make_context(tmp_path, runner=runner)
    sources_drive.copy(ctx, "value-on-stdin")
    assert runner.lines() == ["wl-copy", "xclip -selection clipboard"]
    assert all("value-on-stdin" not in line for line in runner.lines())


def test_no_clipboard_tool_or_a_failing_one_points_at_out(tmp_path, monkeypatch):
    monkeypatch.setattr(sources_drive.sys, "platform", "darwin")
    missing = FakeRunner({"pbcopy": proc.ProcResult(proc.NOT_FOUND, "", "")})
    with pytest.raises(KbeError, match="No clipboard tool"):
        sources_drive.copy(make_context(tmp_path, runner=missing)[0], "x")
    failing = FakeRunner({"pbcopy": proc.ProcResult(1, "", "boom")})
    with pytest.raises(KbeError, match="--out FILE"):
        sources_drive.copy(make_context(tmp_path, runner=failing)[0], "x")


# --- file ----------------------------------------------------------------------


def test_out_writes_a_private_file_and_prints_no_value(tmp_path, signed_in, capsys):
    runner = FakeRunner()
    ctx, lines = make_context(tmp_path, runner=runner)
    target = tmp_path / "drive-secrets.txt"
    argv = ["sources", "drive", "auth", "--client-secret", str(_client_file(tmp_path)),
            "--out", str(target)]
    assert cli.main(argv, ctx) == 0

    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    written = dict(line.split("=", 1) for line in target.read_text().splitlines())
    assert _decoded(written["DRIVE_TOKEN_JSON_B64"]) == TOKEN
    assert _decoded(written["DRIVE_TOKEN_CLIENT_JSON_B64"]) == CLIENT
    shown = _all_text(runner, lines, capsys)
    assert all(value not in shown for value in written.values())
    assert runner.calls == [], "the clipboard is not touched"
    assert not ctx.state_file.exists()


def test_out_never_replaces_a_file_and_signs_in_only_after_checking(tmp_path, monkeypatch, capsys):
    def never(*_args):
        raise AssertionError("no sign-in when the target exists")

    monkeypatch.setattr(sources_drive, "run_flow", never)
    target = tmp_path / "taken.txt"
    target.write_text("keep me", encoding="utf-8")
    ctx, _lines = make_context(tmp_path)
    argv = ["sources", "drive", "auth", "--client-secret", str(_client_file(tmp_path)),
            "--out", str(target)]
    assert cli.main(argv, ctx) == 2
    assert "never replaced" in capsys.readouterr().err and target.read_text() == "keep me"
    with pytest.raises(KbeError, match="already exists"):
        sources_drive.to_file(target, {"A": "b"})
    with pytest.raises(KbeError, match="Could not create"):
        sources_drive.to_file(tmp_path / "no-such-dir" / "x.txt", {"A": "b"})


def test_one_destination_is_required(tmp_path, capsys):
    with pytest.raises(SystemExit) as stopped:
        cli.main(["sources", "drive", "auth", "--client-secret", "c.json"])
    assert stopped.value.code == 2
    with pytest.raises(SystemExit):
        cli.main(["sources", "drive", "auth", "--client-secret", "c.json", "--clipboard", "--out", "x"])
    capsys.readouterr()


def test_no_flag_accepts_a_secret_value():
    parser = cli.build_parser()
    args = parser.parse_args(["sources", "drive", "auth", "--client-secret", "c.json", "--clipboard"])
    assert set(vars(args)) - {"group", "source", "command", "func", "env_file"} == {
        "client_secret", "clipboard", "out",
    }, "only file paths and a switch: no option takes a token"
