"""Google clients for `kbe tags apply --write`, and the one-time sign-in.

These use a credential the owner authorises on their own machine, kept in its
own token file with a scope that allows the one write needed:

  drive   https://www.googleapis.com/auth/drive.metadata  (descriptions)
  gmail   https://www.googleapis.com/auth/gmail.modify    (labels)

The pullers never see this token; their own stays read-only.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

SCOPES = {
    "drive": ("https://www.googleapis.com/auth/drive.metadata",),
    "gmail": ("https://www.googleapis.com/auth/gmail.modify",),
}
_API = {"drive": ("drive", "v3"), "gmail": ("gmail", "v1")}


class TagClientError(RuntimeError):
    """A Google client could not be built."""


class DriveMetadataClient:
    """Reads and sets one field: a file's or folder's description."""

    def __init__(self, service: Any):
        self._files = service.files()

    def get_description(self, file_id: str) -> str:
        found = self._files.get(
            fileId=file_id, fields="description", supportsAllDrives=True
        ).execute()
        return found.get("description") or ""

    def set_description(self, file_id: str, description: str) -> None:
        self._files.update(
            fileId=file_id, body={"description": description}, fields="id",
            supportsAllDrives=True,
        ).execute()


class GmailLabelClient:
    """Lists and creates labels, and changes the labels on one thread."""

    def __init__(self, service: Any):
        self._users = service.users()

    def labels(self) -> dict[str, str]:
        listed = self._users.labels().list(userId="me").execute().get("labels", [])
        return {label["name"]: label["id"] for label in listed}

    def create_label(self, name: str) -> str:
        return self._users.labels().create(userId="me", body={"name": name}).execute()["id"]

    def thread_label_ids(self, thread_id: str) -> list[str]:
        thread = self._users.threads().get(userId="me", id=thread_id, format="minimal").execute()
        return sorted({lid for m in thread.get("messages", []) for lid in m.get("labelIds", [])})

    def modify_thread(self, thread_id: str, add: list[str], remove: list[str]) -> None:
        self._users.threads().modify(
            userId="me", id=thread_id,
            body={"addLabelIds": list(add), "removeLabelIds": list(remove)},
        ).execute()


def _service(source: str, token_path: Path) -> Any:
    if source not in SCOPES:
        raise TagClientError(f"no client for source {source!r}")
    path = Path(token_path)
    if not path.is_file():
        raise TagClientError(
            f"token file not found: {path}. Create it with `kbe tags authorize --source {source}`."
        )
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        credentials = Credentials.from_authorized_user_file(str(path), list(SCOPES[source]))
        api, version = _API[source]
        return build(api, version, credentials=credentials, cache_discovery=False)
    except Exception as error:  # noqa: BLE001 - never echo token contents
        raise TagClientError(
            f"could not build the {source} client from {path}: {type(error).__name__}"
        ) from error


def drive_client(token_path: Path) -> DriveMetadataClient:
    return DriveMetadataClient(_service("drive", token_path))


def gmail_client(token_path: Path) -> GmailLabelClient:
    return GmailLabelClient(_service("gmail", token_path))


def authorize(source: str, client_secret: Path, out: Path) -> Path:
    """Sign in once in the browser and save a token for `source` at `out`.

    The file is created readable by its owner only, and never replaced.
    """
    if source not in SCOPES:
        raise TagClientError(f"no sign-in for source {source!r}")
    target = Path(out)
    if target.exists():
        raise TagClientError(f"{target} already exists; remove it first to sign in again")
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow

        flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), list(SCOPES[source]))
        credentials = flow.run_local_server(port=0)
    except Exception as error:  # noqa: BLE001 - never echo secrets
        raise TagClientError(f"sign-in failed: {type(error).__name__}") from error
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(credentials.to_json())
    return target
