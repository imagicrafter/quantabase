"""One cheap read per source, to prove a configured credential works.

Each check makes a single request and reports pass or fail. Nothing a source
returns is ever shown: a result holds a fixed sentence, an HTTP status or an
exception's type name, and no more. The network calls are passed in, so the
tests run without one.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping

DRIVE_TOKEN_KEY = "DRIVE_TOKEN_JSON_B64"
FIREFLIES_KEY = "FIREFLIES_API_KEY"
GITHUB_KEYS = ("GITHUB_TOKEN", "GH_TOKEN")
GITHUB_API = "https://api.github.com"
CONFIG_PATH = ".kb-engine/engine.yaml"
# The smallest form of the listing the Fireflies puller already runs.
FIREFLIES_QUERY = "query CheckAccess { transcripts(limit: 1) { id } }"
DRIVE_SCOPES = ("https://www.googleapis.com/auth/drive.readonly",)
_TIMEOUT = 30

# (url, headers) -> HTTP status
HttpGet = Callable[[str, Mapping[str, str]], int]
# (url, headers, body) -> (HTTP status, parsed JSON or None)
HttpPost = Callable[[str, Mapping[str, str], Mapping[str, Any]], tuple[int, Any]]
# (token info) -> a Drive v3 service
DriveBuilder = Callable[[Mapping[str, Any]], Any]


@dataclass(frozen=True)
class Check:
    source: str
    ok: bool
    detail: str

    def line(self) -> str:
        return f"{self.source}: ok - {self.detail}" if self.ok else f"{self.source}: FAILED: {self.detail}"


def _missing(source: str, *names: str) -> Check:
    return Check(source, False, f"{' or '.join(names)} is not set in your local env file")


def http_get(url: str, headers: Mapping[str, str]) -> int:
    import requests

    return requests.get(url, headers=dict(headers), timeout=_TIMEOUT).status_code


def http_post(url: str, headers: Mapping[str, str], body: Mapping[str, Any]) -> tuple[int, Any]:
    import requests

    response = requests.post(url, headers=dict(headers), json=dict(body), timeout=_TIMEOUT)
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, None


def build_drive(info: Mapping[str, Any]) -> Any:
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    credentials = Credentials.from_authorized_user_info(dict(info), list(DRIVE_SCOPES))
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "kbe-cli",
    }


def check_wiki(values: Mapping[str, str], repo: str | None, get: HttpGet | None = None) -> Check:
    """Can the token read the knowledge repo, and is the config file there?"""
    if not repo:
        return Check("wiki", False, "no knowledge repo is known; pass --repo OWNER/NAME")
    token = next((values[key] for key in GITHUB_KEYS if values.get(key)), "")
    if not token:
        return _missing("wiki", *GITHUB_KEYS)
    headers = _github_headers(token)
    get = get or http_get
    try:
        status = get(f"{GITHUB_API}/repos/{repo}", headers)
        if status != 200:
            reason = "the token was refused" if status in (401, 403) else "not found with this token"
            return Check("wiki", False, f"{repo}: {reason} (HTTP {status})")
        config = get(f"{GITHUB_API}/repos/{repo}/contents/{CONFIG_PATH}", headers)
    except Exception as error:  # noqa: BLE001 - any transport failure
        return Check("wiki", False, f"could not reach GitHub ({type(error).__name__})")
    if config == 200:
        return Check("wiki", True, f"{repo} is readable and has {CONFIG_PATH}")
    if config == 404:
        return Check("wiki", False, f"{repo} is readable but has no {CONFIG_PATH}")
    return Check("wiki", False, f"{repo}: could not look for {CONFIG_PATH} (HTTP {config})")


def check_fireflies(values: Mapping[str, str], post: HttpPost | None = None) -> Check:
    """Does the Fireflies key answer the smallest listing?"""
    key = values.get(FIREFLIES_KEY, "")
    if not key:
        return _missing("fireflies", FIREFLIES_KEY)
    from pullers.fireflies import FIREFLIES_API_URL

    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        status, body = (post or http_post)(FIREFLIES_API_URL, headers, {"query": FIREFLIES_QUERY, "variables": {}})
    except Exception as error:  # noqa: BLE001 - any transport failure
        return Check("fireflies", False, f"could not reach Fireflies ({type(error).__name__})")
    if status != 200:
        return Check("fireflies", False, f"the key was refused (HTTP {status})")
    if not isinstance(body, Mapping) or body.get("errors") or "data" not in body:
        return Check("fireflies", False, "Fireflies answered with an error")
    return Check("fireflies", True, "the key can list meetings")


def decode_token(encoded: str) -> Mapping[str, Any]:
    """The token JSON held in DRIVE_TOKEN_JSON_B64. Raises ValueError if unusable."""
    try:
        info = json.loads(base64.b64decode(encoded.strip(), validate=True))
    except (binascii.Error, ValueError) as error:
        raise ValueError("not base64 of a JSON file") from error
    if not isinstance(info, Mapping) or not info.get("refresh_token"):
        raise ValueError("has no refresh token")
    return info


def check_drive(values: Mapping[str, str], build: DriveBuilder | None = None) -> Check:
    """Does the stored Drive token list one file?"""
    encoded = values.get(DRIVE_TOKEN_KEY, "")
    if not encoded:
        return _missing("drive", DRIVE_TOKEN_KEY)
    try:
        info = decode_token(encoded)
    except ValueError as error:
        return Check("drive", False, f"{DRIVE_TOKEN_KEY} {error}")
    try:
        (build or build_drive)(info).files().list(pageSize=1, fields="files(id)").execute()
    except Exception as error:  # noqa: BLE001 - never echo token contents
        return Check("drive", False, f"Google refused the token ({type(error).__name__})")
    return Check("drive", True, "the token can list files (read-only)")
