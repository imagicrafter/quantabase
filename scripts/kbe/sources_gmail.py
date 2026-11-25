"""`kbe sources gmail` -- the one-time Google sign-in for the Gmail puller, and
a check that the stored sign-in works.

    kbe sources gmail auth --client-secret FILE (--clipboard | --out FILE)
    kbe sources gmail check

The sign-in is READ-ONLY (`gmail.readonly`): the Engine can never send, change
or delete mail. One value comes out, the base64 of the token JSON:

    GMAIL_TOKEN_JSON_B64

`pullers/gmail.py` turns it back into a file when the job starts. It is a
secret, handled exactly like the Drive ones (sources_drive.py): it goes to the
clipboard or into a file the owner names, and is never printed, never written
to local state and never put on a command line.

The check makes two reads: whose mailbox the sign-in is for, and the list of
labels. It lists no thread and reads no mail. It reports how many labels
start with the tag prefix, never their names.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from knowledge.connectors import gmail as gmail_connector
from knowledge.connectors import gmail_client

from . import sources_drive
from .errors import KbeError
from .sources_checks import Check, decode_token

GMAIL_TOKEN_KEY = "GMAIL_TOKEN_JSON_B64"
GMAIL_SCOPES = gmail_client.SCOPES
COMPONENT = "puller-gmail"

# (token info) -> a Gmail v1 service
GmailBuilder = Callable[[Mapping[str, Any]], Any]


@dataclass(frozen=True)
class GmailSettings:
    """What the applied config says about mail; both None when there is none."""

    mailbox: str | None
    prefix: str | None


def build_gmail(info: Mapping[str, Any]) -> Any:
    return gmail_client.build_service(info)


def sign_in(client_secret: Path, flow: sources_drive.Flow | None = None) -> dict[str, str]:
    """Run the read-only sign-in. Returns the one app secret, by name."""
    sources_drive.read_client(client_secret)
    try:
        token = json.loads((flow or sources_drive.run_flow)(client_secret, GMAIL_SCOPES))
    except Exception as error:  # noqa: BLE001 - never echo what Google sent back
        raise KbeError(f"The Google sign-in did not finish ({type(error).__name__}).") from error
    if not isinstance(token, Mapping) or not token.get("refresh_token"):
        raise KbeError(
            "Google returned no refresh token. Remove this app's access at "
            "myaccount.google.com/permissions and sign in again."
        )
    return {GMAIL_TOKEN_KEY: sources_drive._encode(token)}


def next_steps(names: Sequence[str]) -> list[str]:
    """Where the value goes. Names only."""
    return [
        f"Set this as an encrypted value on the `{COMPONENT}` job in the DigitalOcean "
        "dashboard (App -> Settings -> the job -> Environment Variables):",
        *(f"  {name}" for name in names),
        "The job exists only when the config has sources.gmail.enabled: true "
        "(apply the config, then python -m kbe deploy render and apply).",
        "To check it from this machine, also put it in your local env file and "
        "run: python -m kbe sources gmail check",
    ]


def settings_from(config: Mapping[str, Any] | None) -> GmailSettings:
    """The mailbox and label prefix an applied config names, if it is usable."""
    if not config:
        return GmailSettings(None, None)
    try:
        from knowledge.engine_config import validate
        from knowledge.engine_config_gmail import effective_mailboxes

        parsed = validate(config)
        return GmailSettings(
            mailbox=effective_mailboxes(parsed)[0].email,
            prefix=gmail_connector.tag_prefix(parsed),
        )
    except Exception:  # noqa: BLE001 - an unusable config is "no config" here
        return GmailSettings(None, None)


def _detail(labels: list, settings: GmailSettings) -> str:
    base = "the sign-in can read labels (read-only)"
    if settings.prefix is None:
        return (
            f"{base}; no Engine config was found, so the mailbox and the label "
            "prefix were not checked"
        )
    count = len(gmail_connector.tag_labels(labels, settings.prefix))
    return f"{base}; {count} label(s) start with {settings.prefix}"


def check_gmail(
    values: Mapping[str, str], settings: GmailSettings, build: GmailBuilder | None = None
) -> Check:
    """Does the stored Gmail sign-in work, for the mailbox the config names?"""
    encoded = values.get(GMAIL_TOKEN_KEY, "")
    if not encoded:
        return Check("gmail", False, f"{GMAIL_TOKEN_KEY} is not set in your local env file")
    try:
        info = decode_token(encoded)
    except ValueError as error:
        return Check("gmail", False, f"{GMAIL_TOKEN_KEY} {error}")
    try:
        service = (build or build_gmail)(info)
        signed_in = gmail_client.profile_email(service)
        labels = gmail_client.list_labels(service)
    except Exception as error:  # noqa: BLE001 - never echo token contents
        return Check("gmail", False, f"Google refused the sign-in ({type(error).__name__})")
    if settings.mailbox is not None and signed_in != settings.mailbox.lower():
        return Check(
            "gmail", False,
            f"the sign-in is for another mailbox than the config names ({settings.mailbox})",
        )
    return Check("gmail", True, _detail(labels, settings))
