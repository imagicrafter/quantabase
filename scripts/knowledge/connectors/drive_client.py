"""The Drive sign-in the connector uses, and the two calls that need care.

Read-only: the stored sign-in carries the `drive.readonly` scope and nothing
here creates, changes or deletes anything.

The sign-in is two values in the local settings file, both made by
`python -m kbe sources drive auth`:

    DRIVE_TOKEN_JSON_B64          base64 of the token JSON
    DRIVE_TOKEN_CLIENT_JSON_B64   base64 of the OAuth client JSON

They are decoded in memory. No token file is written to disk, and no value
is ever printed, logged or put in an error message: an error names the
setting, never its contents.
"""

from __future__ import annotations

import base64
import binascii
import json
from pathlib import Path
from typing import Any, Mapping

from ..config import WORKSPACE_ROOT

READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
# Seconds one Drive request may take before the job gives up on it.
HTTP_TIMEOUT_SECONDS = 60
SCOPES = (READONLY_SCOPE,)
TOKEN_KEY = "DRIVE_TOKEN_JSON_B64"
CLIENT_KEY = "DRIVE_TOKEN_CLIENT_JSON_B64"
ENV_FILE = WORKSPACE_ROOT / ".env"
EXPORT_MIME = "text/plain"
_CLIENT_FIELDS = ("client_id", "client_secret", "token_uri")
_PLACEHOLDER = ("<", ">")


class DriveClientError(RuntimeError):
    """Drive could not be reached, or the stored sign-in could not be used."""


def read_settings(env_file: Path | None = None) -> Mapping[str, str | None]:
    """The local settings file, read into memory (nothing is exported)."""
    from knowledge.env_file import read as read_env_file

    path = Path(env_file) if env_file is not None else ENV_FILE
    return dict(read_env_file(path)) if path.exists() else {}


def _is_set(value: Any) -> bool:
    text = str(value or "").strip()
    return bool(text) and not (text.startswith(_PLACEHOLDER[0]) and text.endswith(_PLACEHOLDER[1]))


def _decode(values: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    """The JSON object held, base64-encoded, in `values[key]`."""
    try:
        data = json.loads(base64.b64decode(str(values[key]).strip(), validate=True))
    except (binascii.Error, ValueError) as error:
        raise DriveClientError(f"{key} is not base64 of a JSON file.") from error
    if not isinstance(data, Mapping):
        raise DriveClientError(f"{key} is not base64 of a JSON object.")
    return data


def _client_fields(values: Mapping[str, Any]) -> Mapping[str, Any]:
    """`client_id`, `client_secret` and `token_uri` from the OAuth client JSON."""
    if not _is_set(values.get(CLIENT_KEY)):
        return {}
    client = _decode(values, CLIENT_KEY)
    inner = client.get("installed") or client.get("web") or {}
    if not isinstance(inner, Mapping):
        return {}
    return {name: inner[name] for name in _CLIENT_FIELDS if inner.get(name)}


def token_from_settings(values: Mapping[str, Any]) -> Mapping[str, Any]:
    """The sign-in as one mapping, ready for `build_service`.

    The token JSON normally carries the client id and secret itself. When it
    does not, they are taken from the OAuth client JSON.
    """
    if not _is_set(values.get(TOKEN_KEY)):
        raise DriveClientError(
            f"No Drive sign-in is stored: set {TOKEN_KEY} "
            "(python -m kbe sources drive auth)."
        )
    token = _decode(values, TOKEN_KEY)
    if not token.get("refresh_token"):
        raise DriveClientError(f"{TOKEN_KEY} has no refresh token; sign in again.")
    merged = {**_client_fields(values), **{k: v for k, v in token.items() if v}}
    missing = [name for name in _CLIENT_FIELDS[:2] if not merged.get(name)]
    if missing:
        raise DriveClientError(
            f"The Drive sign-in has no {' or '.join(missing)}: set {CLIENT_KEY} as well."
        )
    return merged


def build_service(info: Mapping[str, Any]) -> Any:
    """A Drive API client for a stored sign-in (read-only scope)."""
    try:
        import httplib2
        from google.oauth2.credentials import Credentials
        from google_auth_httplib2 import AuthorizedHttp
        from googleapiclient.discovery import build

        credentials = Credentials.from_authorized_user_info(dict(info), list(SCOPES))
        http = AuthorizedHttp(credentials, http=httplib2.Http(timeout=HTTP_TIMEOUT_SECONDS))
        return build("drive", "v3", http=http, cache_discovery=False)
    except Exception as error:  # noqa: BLE001 - never echo token contents
        raise DriveClientError(
            f"The Drive client could not be built ({type(error).__name__})."
        ) from error


def service_from_settings(values: Mapping[str, Any] | None = None) -> Any:
    """A read-only Drive client for the sign-in in the local settings file."""
    return build_service(token_from_settings(read_settings() if values is None else values))


def export_text(service: Any, file_id: str, max_chars: int) -> str:
    """Plain text of one Google Doc, cut to `max_chars`.

    Uses the Drive API's own export, so no second Google API has to be
    enabled. Raises whatever the API raises; the caller decides what a
    failure means.
    """
    raw = service.files().export(fileId=file_id, mimeType=EXPORT_MIME).execute()
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw or "")
    return text.lstrip("﻿")[: max(max_chars, 0)]


def owned_by_me(item: Any) -> bool:
    """True only when Drive says the signed-in account owns the item.

    A missing answer is `False`: an item whose owner is not known is treated
    as someone else's.
    """
    return isinstance(item, Mapping) and item.get("ownedByMe") is True
