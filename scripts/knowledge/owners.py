"""Who owns a document.

Only email has an owner so far: the person whose mailbox a thread came from.
A connector names the owner by email on the Document; this module turns that
email into the person's id, which is what the database stores and what the
read functions compare against the caller (migration 0038).

The pullers cannot read the people table. They ask one function,
`principal_id_for_email`, which answers with an id or nothing.

An owner who is not an active person on the Engine stops the run before
anything is written: a row must never be stored with a guessed owner, and an
email row with no owner at all is visible to nobody.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .kb_schema import db

FUNCTION = "principal_id_for_email"
COLUMN = "owner_principal_id"


class OwnerError(RuntimeError):
    """An owner could not be resolved to a person."""


def _lookup(sb: Any, email: str) -> str | None:
    try:
        found = db(sb).rpc(FUNCTION, {"p_email": email}).execute().data
    except Exception as error:  # noqa: BLE001 - any transport or driver failure
        raise OwnerError(
            f"The owner {email} could not be looked up ({type(error).__name__}). "
            "Has migration 0038_document_owner.sql been applied? Nothing was written."
        ) from error
    return found if isinstance(found, str) and found else None


def owner_ids(sb: Any, documents: Iterable[Any]) -> dict[str, str]:
    """Owner email -> person id, for every owner named in `documents`."""
    emails = sorted({doc.owner_email for doc in documents if doc.owner_email})
    ids = {email: _lookup(sb, email) for email in emails}
    missing = [email for email, found in ids.items() if found is None]
    if missing:
        raise OwnerError(
            f"{', '.join(missing)} is not an active person on this Engine, so their "
            "mail cannot be given an owner. Add the person first "
            "(python -m kbe people add). Nothing was written."
        )
    return {email: found for email, found in ids.items() if found is not None}


def owner_column(document: Any, ids: Mapping[str, str]) -> dict[str, str]:
    """The owner column for one row; empty for a document with no owner."""
    if not document.owner_email:
        return {}
    if document.owner_email not in ids:
        raise OwnerError(f"No person was resolved for the owner {document.owner_email}.")
    return {COLUMN: ids[document.owner_email]}
