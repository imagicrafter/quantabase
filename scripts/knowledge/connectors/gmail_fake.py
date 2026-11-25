"""A stand-in for the Gmail API client, for tests. No network.

It answers the few calls the connector makes, in the same chained shape as
the real client (`service.users().threads().list(...).execute()`), and keeps
a record of every call so a test can prove what was and was not asked for.
"""

from __future__ import annotations

import base64
from typing import Any


class NotFound(Exception):
    """What the real client raises for a thread that no longer exists."""

    def __init__(self) -> None:
        super().__init__("not found")
        self.resp = type("Resp", (), {"status": 404})()


class _Call:
    def __init__(self, run):
        self._run = run

    def execute(self) -> Any:
        return self._run()


def text_part(text: str, mime: str = "text/plain") -> dict:
    data = base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii")
    return {"mimeType": mime, "body": {"data": data}}


def message(
    message_id: str,
    label_ids: list[str],
    *,
    sender: str = "Pat Owner <owner@example.com>",
    to: str = "sam@partner.example",
    subject: str = "Budget",
    body: str = "The budget is agreed.",
    date: str = "Mon, 5 Jan 2026 10:00:00 +0000",
) -> dict:
    return {
        "id": message_id,
        "labelIds": list(label_ids),
        "payload": {
            "mimeType": "multipart/alternative",
            "headers": [
                {"name": "From", "value": sender},
                {"name": "To", "value": to},
                {"name": "Subject", "value": subject},
                {"name": "Date", "value": date},
            ],
            "parts": [text_part(body)],
        },
    }


class FakeGmail:
    """`labels`: [{"id", "name", "type"}]; `threads`: {thread_id: [message, ...]}."""

    def __init__(self, *, email: str, labels: list[dict], threads: dict[str, list[dict]],
                 page_size: int = 2, broken: frozenset[str] = frozenset(),
                 unlabelled_on_get: frozenset[str] = frozenset()):
        self.email = email
        self.labels = labels
        self.threads = threads
        self.page_size = page_size
        # Thread ids whose fetch fails, as a backend error would.
        self.broken = broken
        # Thread ids that lose their labels between the listing and the fetch.
        self.unlabelled_on_get = unlabelled_on_get
        self.calls: list[tuple] = []

    def getProfile(self, userId: str) -> _Call:  # noqa: N802 - the API's own name
        self.calls.append(("profile",))
        return _Call(lambda: {"emailAddress": self.email})

    def fetched(self, fmt: str | None = None) -> list[str]:
        """Thread ids that were fetched, in order (optionally one format only)."""
        return [c[1] for c in self.calls if c[0] == "get" and fmt in (None, c[2])]


# `labels` and `threads` are attributes on the fake AND methods on the real
# client, so the resources are reached through small wrappers.
class _Users:
    def __init__(self, fake: FakeGmail):
        self._fake = fake

    def getProfile(self, userId: str) -> _Call:  # noqa: N802
        return self._fake.getProfile(userId)

    def labels(self) -> "_Labels":
        return _Labels(self._fake)

    def threads(self) -> "_Threads":
        return _Threads(self._fake)


class _Labels:
    def __init__(self, fake: FakeGmail):
        self._fake = fake

    def list(self, userId: str) -> _Call:
        self._fake.calls.append(("labels",))
        return _Call(lambda: {"labels": [dict(label) for label in self._fake.labels]})


class _Threads:
    def __init__(self, fake: FakeGmail):
        self._fake = fake

    def list(self, userId: str, **kwargs: Any) -> _Call:
        self._fake.calls.append(("list", dict(kwargs)))
        return _Call(lambda: self._page(kwargs))

    def _page(self, kwargs: dict) -> dict:
        wanted = set(kwargs.get("labelIds") or [])
        ids = sorted(
            thread_id
            for thread_id, messages in self._fake.threads.items()
            if not wanted or wanted & {lid for m in messages for lid in m["labelIds"]}
        )
        start = int(kwargs.get("pageToken") or 0)
        page = ids[start : start + self._fake.page_size]
        more = start + self._fake.page_size < len(ids)
        return {
            "threads": [{"id": thread_id} for thread_id in page],
            **({"nextPageToken": str(start + self._fake.page_size)} if more else {}),
        }

    def get(self, userId: str, id: str, format: str = "full") -> _Call:  # noqa: A002
        self._fake.calls.append(("get", id, format))
        return _Call(lambda: self._thread(id))

    def _thread(self, thread_id: str) -> dict:
        if thread_id in self._fake.broken:
            raise RuntimeError("backend error")
        if thread_id not in self._fake.threads:
            raise NotFound()
        messages = [dict(m) for m in self._fake.threads[thread_id]]
        if thread_id in self._fake.unlabelled_on_get:
            messages = [{**m, "labelIds": ["INBOX"]} for m in messages]
        return {"id": thread_id, "messages": messages}


def service(fake: FakeGmail) -> _Users:
    """The object the connector is given: `service.users()` returns the API."""
    return type("Service", (), {"users": lambda self: _Users(fake)})()
