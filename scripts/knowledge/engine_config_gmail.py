"""The Gmail part of the Engine config: whose mailbox is read, and who owns it.

    sources:
      gmail:
        enabled: false
        prefix: null
        mailboxes:
          - { email: owner@example.com, owner_email: owner@example.com }

`mailboxes` may be left empty: that means one mailbox, the Engine owner's.
`owner_email` may be left out: the Engine owner then owns the mailbox's
threads. One mailbox is supported for now; the list shape is there so a later
version can add more without changing the file.

Kept apart from engine_config.py only to keep that file small. This module
must not import it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping

from .engine_config_schema import EMAIL

MAX_MAILBOXES = 1
_EMAIL = EMAIL  # the service's own rule, shared with the main validator
_KEYS = ("email", "owner_email")


@dataclass(frozen=True)
class Mailbox:
    """One mailbox: its own address and the person who owns what it holds."""

    email: str
    owner_email: str | None = None


def _address(node: Mapping[str, Any], key: str, at: str, problems: list[str], required: bool):
    value = node.get(key)
    if value is None:
        if required:
            problems.append(f"{at}.{key}: required")
        return None
    if not isinstance(value, str) or not _EMAIL.fullmatch(value):
        problems.append(f"{at}.{key}: must be an email address")
        return None
    return value.lower()


def read_mailboxes(raw: Any, path: str, problems: list[str]) -> tuple[Mailbox, ...]:
    """Validate `sources.gmail.mailboxes`, recording every problem found."""
    if raw is None:
        return ()
    if not isinstance(raw, list):
        problems.append(f"{path}: must be a list")
        return ()
    if len(raw) > MAX_MAILBOXES:
        problems.append(f"{path}: one mailbox is supported for now")
    mailboxes = []
    for index, item in enumerate(raw):
        at = f"{path}.{index}"
        if not isinstance(item, Mapping):
            problems.append(f"{at}: must be a mapping")
            continue
        problems.extend(f"{at}.{key}: unknown key" for key in item if key not in _KEYS)
        email = _address(item, "email", at, problems, required=True)
        owner = _address(item, "owner_email", at, problems, required=False)
        if email:
            mailboxes.append(Mailbox(email=email, owner_email=owner))
    return tuple(mailboxes)


def effective_mailboxes(config: Any) -> tuple[Mailbox, ...]:
    """The mailboxes to read, with every default filled in.

    No mailbox listed means the Engine owner's own; no owner named means the
    Engine owner.
    """
    owner = config.owner.email.lower()
    listed = config.sources.gmail.mailboxes
    if not listed:
        return (Mailbox(email=owner, owner_email=owner),)
    return tuple(
        Mailbox(email=box.email, owner_email=box.owner_email or owner) for box in listed
    )
