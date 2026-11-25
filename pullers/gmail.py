"""Gmail puller -- wraps `knowledge.connectors.gmail`.

OFF unless the Engine config says `sources.gmail.enabled: true`. While it is
off nothing here talks to Gmail: `enabled()` is what the runner asks before it
starts a run, and `fetch()` refuses on its own as well.

The same shape as `pullers/drive.py`: every run reads the whole set of
labelled threads and builds Documents directly, so `fetch()` is the collect
call, `to_document()` is identity, and the run is a FULL SYNC. A thread whose
tag label was taken off is simply absent from the run, and ingest tombstones
it. `confirm_absent()` looks at each absent thread so that a real removal is
told apart from a listing that came back short (see `ingest.upsert`).

Which mailbox is read, and who owns what comes from it, is in the config
(`sources.gmail.mailboxes`; by default the Engine owner's own mailbox).

**The stored sign-in** is one value, `GMAIL_TOKEN_JSON_B64`: base64 of the
OAuth token JSON. When a run starts it is written to `TOKEN_FILE_PATH` (a
fixed path, owner-only), unless that file is already there.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any, Iterable

from knowledge.env_file import read as read_env_file

from knowledge.config import WORKSPACE_ROOT
from knowledge.connectors import gmail as _gmail
from knowledge.connectors import gmail_client
from knowledge.contract import Document
from knowledge.engine_config import get_config
from knowledge.engine_config_gmail import Mailbox, effective_mailboxes
from knowledge.kb_schema import db

SOURCE = "gmail"
# No raw copy. The raw-capture layer is append-only and is never deleted
# from, so text put there would outlive its label. Mail must leave the
# database when the label comes off; Gmail itself is the copy of record.
BRONZE = False
# Error text from a failed run is cut down before it is stored, because a
# database error can quote the row it refused -- a title or a body.
REDACT_ERRORS = True
PAGE_SIZE = 500
# Every run carries the whole labelled set; what is absent has lost its label.
FULL_SYNC = True

TOKEN_KEY = "GMAIL_TOKEN_JSON_B64"
# A fixed path; no setting changes it.
TOKEN_FILE_PATH = Path("/tmp/gmail-token.json")
ENV_FILE = WORKSPACE_ROOT / ".env"


class GmailTokenError(RuntimeError):
    """The Gmail sign-in could not be found or read."""


class GmailDisabledError(RuntimeError):
    """The Gmail source is off in the Engine config."""


def enabled() -> bool:
    """True only when the Engine config turns the Gmail source on."""
    return get_config().sources.gmail.enabled is True


def _mailbox() -> Mailbox:
    """The one mailbox this Engine reads (the config allows one for now)."""
    return effective_mailboxes(get_config())[0]


def _ensure_token_file() -> None:
    """Write the token file from `GMAIL_TOKEN_JSON_B64`, if it is not there.

    Base64 because an env file cannot hold the JSON's newlines. An existing
    file is never replaced. The file is created for its owner only.
    """
    if TOKEN_FILE_PATH.exists():
        return
    values = read_env_file(ENV_FILE) if ENV_FILE.exists() else {}
    encoded = (values.get(TOKEN_KEY) or "").strip()
    if not encoded:
        return
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as error:  # noqa: BLE001 - a malformed secret is a real error
        raise GmailTokenError(f"{TOKEN_KEY} is not valid base64.") from error
    TOKEN_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(TOKEN_FILE_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(raw)


def _service() -> Any:
    """A read-only Gmail client for the stored sign-in."""
    _ensure_token_file()
    if not TOKEN_FILE_PATH.exists():
        raise GmailTokenError(
            f"No Gmail sign-in is stored: set {TOKEN_KEY} "
            "(python -m kbe sources gmail auth)."
        )
    try:
        return gmail_client.build_service(gmail_client.load_token(TOKEN_FILE_PATH))
    except gmail_client.GmailClientError as error:
        raise GmailTokenError(str(error)) from error


def fetch(cursor: dict, *, sb: Any = None) -> tuple[Iterable[Document], dict]:
    """Every labelled thread. `cursor` is ignored: there is none to keep."""
    if not enabled():
        raise GmailDisabledError(
            "The Gmail source is off (sources.gmail.enabled is false). Nothing was read."
        )
    documents, _result = _gmail.collect(_service(), get_config(), _mailbox())
    return documents, {}


def to_document(raw: Document) -> Document:
    """Identity -- `fetch()` already returned validated Documents."""
    return raw


def _live_thread_ids(sb: Any) -> list[str]:
    """The thread ids of every Gmail row that is live in the index.

    Read a page at a time: one request returns at most a fixed number of
    rows, and a thread left out here would never be checked.
    """
    ids: list[str] = []
    while True:
        rows = (
            db(sb).table("documents").select("external_id")
            .eq("source", SOURCE).is_("deleted_at", "null")
            .order("external_id").range(len(ids), len(ids) + PAGE_SIZE - 1)
            .execute().data
        ) or []
        ids.extend(row["external_id"] for row in rows if row.get("external_id"))
        if len(rows) < PAGE_SIZE:
            return ids


def confirm_absent(documents: Iterable[Document], sb: Any) -> frozenset[str]:
    """Indexed threads this run did not return that are confirmed to have
    lost their tag label (or to be gone). See `ingest.upsert(confirmed_absent=)`.
    """
    if not enabled():
        return frozenset()
    seen = {document.external_id for document in documents}
    absent = sorted(thread_id for thread_id in _live_thread_ids(sb) if thread_id not in seen)
    if not absent:
        return frozenset()
    return _gmail.confirm_removed(_service(), get_config(), _mailbox(), absent)
