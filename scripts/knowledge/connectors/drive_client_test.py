"""`knowledge.connectors.drive_client`: the stored sign-in, read in memory."""

from __future__ import annotations

import base64
import json

import pytest

from knowledge.connectors import drive_client
from knowledge.connectors.drive_client import CLIENT_KEY, TOKEN_KEY, DriveClientError

SECRET = "fake-refresh-value-0123456789"
TOKEN = {"refresh_token": SECRET, "client_id": "id-1", "client_secret": "cs-1"}
CLIENT = {"installed": {"client_id": "id-2", "client_secret": "cs-2", "token_uri": "https://t.example/x"}}


def _b64(obj) -> str:
    return base64.b64encode(json.dumps(obj).encode()).decode()


def test_the_token_alone_is_enough_when_it_carries_the_client() -> None:
    info = drive_client.token_from_settings({TOKEN_KEY: _b64(TOKEN)})
    assert info["refresh_token"] == SECRET and info["client_id"] == "id-1"


def test_client_fields_are_filled_from_the_client_file_when_missing() -> None:
    values = {TOKEN_KEY: _b64({"refresh_token": SECRET}), CLIENT_KEY: _b64(CLIENT)}
    info = drive_client.token_from_settings(values)
    assert (info["client_id"], info["client_secret"]) == ("id-2", "cs-2")
    assert info["token_uri"] == "https://t.example/x"


def test_the_tokens_own_client_wins_over_the_client_file() -> None:
    info = drive_client.token_from_settings({TOKEN_KEY: _b64(TOKEN), CLIENT_KEY: _b64(CLIENT)})
    assert info["client_id"] == "id-1"


@pytest.mark.parametrize("value", [None, "", "   ", "<your-drive-token>"])
def test_an_unset_or_placeholder_token_is_refused_by_name(value) -> None:
    with pytest.raises(DriveClientError) as raised:
        drive_client.token_from_settings({TOKEN_KEY: value})
    assert TOKEN_KEY in str(raised.value)


@pytest.mark.parametrize(
    ("values", "named"),
    [
        ({TOKEN_KEY: "not base64 !!"}, TOKEN_KEY),
        ({TOKEN_KEY: _b64([1, 2])}, TOKEN_KEY),
        ({TOKEN_KEY: _b64({"client_id": "x"})}, TOKEN_KEY),
        ({TOKEN_KEY: _b64({"refresh_token": SECRET})}, CLIENT_KEY),
        ({TOKEN_KEY: _b64({"refresh_token": SECRET}), CLIENT_KEY: "@@"}, CLIENT_KEY),
    ],
)
def test_a_bad_value_names_the_setting_and_never_its_contents(values, named) -> None:
    with pytest.raises(DriveClientError) as raised:
        drive_client.token_from_settings(values)
    message = str(raised.value)
    assert named in message
    assert SECRET not in message and _b64({"refresh_token": SECRET}) not in message


def test_build_failure_never_echoes_the_token(monkeypatch) -> None:
    import google.oauth2.credentials as credentials

    def boom(info, scopes):
        raise ValueError(f"bad token {info}")

    monkeypatch.setattr(credentials.Credentials, "from_authorized_user_info", staticmethod(boom))
    with pytest.raises(DriveClientError) as raised:
        drive_client.build_service(TOKEN)
    assert SECRET not in str(raised.value)
    assert "ValueError" in str(raised.value)


def test_every_drive_call_has_a_time_limit(monkeypatch) -> None:
    """A Drive call that never answers must not hang the job."""
    from googleapiclient import discovery

    seen = {}

    def fake_build(_name, _version, **kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(discovery, "build", fake_build)
    drive_client.build_service(TOKEN)
    assert "credentials" not in seen
    assert seen["http"].http.timeout == drive_client.HTTP_TIMEOUT_SECONDS > 0


def test_the_scope_is_read_only() -> None:
    assert drive_client.SCOPES == ("https://www.googleapis.com/auth/drive.readonly",)


def test_read_settings_reads_the_file_without_exporting(tmp_path, monkeypatch) -> None:
    import os

    env = tmp_path / "settings"
    env.write_text(f"{TOKEN_KEY}={_b64(TOKEN)}\n", encoding="utf-8")
    values = drive_client.read_settings(env)
    assert values[TOKEN_KEY] == _b64(TOKEN)
    assert TOKEN_KEY not in os.environ
    assert drive_client.read_settings(tmp_path / "missing") == {}


class _Export:
    def __init__(self, payload):
        self.payload = payload
        self.asked: dict = {}

    def files(self):
        return self

    def export(self, **kwargs):
        self.asked = kwargs
        return self

    def execute(self):
        return self.payload


def test_export_text_reads_plain_text_and_cuts_it() -> None:
    service = _Export("﻿Hello world".encode("utf-8"))
    assert drive_client.export_text(service, "f1", 5) == "Hello"
    assert service.asked == {"fileId": "f1", "mimeType": "text/plain"}
    assert drive_client.export_text(_Export(None), "f1", 5) == ""


@pytest.mark.parametrize(
    ("item", "expected"),
    [({"ownedByMe": True}, True), ({"ownedByMe": False}, False), ({}, False),
     ({"ownedByMe": "true"}, False), (None, False)],
)
def test_ownership_is_only_what_drive_says(item, expected) -> None:
    assert drive_client.owned_by_me(item) is expected
