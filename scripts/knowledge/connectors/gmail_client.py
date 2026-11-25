"""The few Gmail API calls the connector makes, and the sign-in that backs them.

Read-only: the stored sign-in carries the `gmail.readonly` scope and nothing
here sends, changes or deletes anything. Threads are found by label id, never
by a search query, so mail without a tag label is not even listed.

The token is read from a file (or passed in as a mapping); it is never
printed, logged or put in an error message.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
SCOPES = (READONLY_SCOPE,)
PAGE_SIZE = 500
_THREAD_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


class GmailClientError(RuntimeError):
    """Gmail could not be reached, or the stored sign-in could not be used."""


def load_token(path: Path) -> Mapping[str, Any]:
    """The token JSON at `path`. Its contents never appear in an error."""
    try:
        info = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as error:
        raise GmailClientError(
            f"The Gmail token file could not be read ({error.strerror})."
        ) from error
    except ValueError as error:
        raise GmailClientError("The Gmail token file is not a JSON file.") from error
    if not isinstance(info, Mapping) or not info.get("refresh_token"):
        raise GmailClientError("The Gmail token has no refresh token; sign in again.")
    return info


def build_service(info: Mapping[str, Any]) -> Any:
    """A Gmail API client for a stored sign-in (read-only scope)."""
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        credentials = Credentials.from_authorized_user_info(dict(info), list(SCOPES))
        return build("gmail", "v1", credentials=credentials, cache_discovery=False)
    except Exception as error:  # noqa: BLE001 - never echo token contents
        raise GmailClientError(
            f"The Gmail client could not be built ({type(error).__name__})."
        ) from error


def is_not_found(error: BaseException) -> bool:
    """True for the API's "no such thread" answer (HTTP 404)."""
    status = getattr(getattr(error, "resp", None), "status", None)
    return str(status) == "404"


def valid_thread_id(thread_id: Any) -> bool:
    return isinstance(thread_id, str) and _THREAD_ID.fullmatch(thread_id) is not None


def profile_email(service: Any) -> str:
    """The address the sign-in belongs to, lower-cased."""
    profile = service.users().getProfile(userId="me").execute()
    return str((profile or {}).get("emailAddress") or "").strip().lower()


def list_labels(service: Any) -> list[dict]:
    """Every label in the mailbox: [{"id", "name", "type"}, ...]."""
    listed = service.users().labels().list(userId="me").execute()
    return [label for label in (listed or {}).get("labels", []) if isinstance(label, dict)]


def list_thread_ids(service: Any, label_id: str) -> list[str]:
    """Ids of every thread carrying ONE label, across all pages.

    Spam and trash are left out (the API's default), so a labelled thread that
    is binned drops out of the listing.
    """
    ids: list[str] = []
    token: str | None = None
    while True:
        args: dict[str, Any] = {"labelIds": [label_id], "maxResults": PAGE_SIZE}
        if token:
            args["pageToken"] = token
        page = service.users().threads().list(userId="me", **args).execute() or {}
        ids.extend(t["id"] for t in page.get("threads", []) if valid_thread_id(t.get("id")))
        token = page.get("nextPageToken")
        if not token:
            return ids


def get_thread(service: Any, thread_id: str, *, labels_only: bool = False) -> dict:
    """One thread: whole (`full`) or just its messages' label ids (`minimal`)."""
    fmt = "minimal" if labels_only else "full"
    return service.users().threads().get(userId="me", id=thread_id, format=fmt).execute() or {}
