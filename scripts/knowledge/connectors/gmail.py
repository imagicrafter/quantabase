"""Gmail connector -- labelled threads into workspace.documents.

**One row per thread, not per message.** `external_id` is the thread id; the
body holds every message of the thread in order.

THE ONLY SCOPE IS THE LABEL. A thread is indexed only if it carries a label
named `<prefix><topic>`, where the prefix is `sources.gmail.prefix` when set
and `tagging.prefix` otherwise. There is no other way in: no sender list, no
contact list, no search query. Threads are listed BY LABEL ID, so mail without
a tag label is never listed, never fetched and never stored anywhere.

  * Only labels a person made count (`type: user`). A system label is never a
    tag, whatever the prefix is.
  * The label names go to the tag resolver, as the content tags of the thread.
    A label naming a topic the config does not declare makes the thread
    `unclassified` with an `unknown_tag` signal -- the same as every source.
  * Every thread carries the mailbox's owner. In the database a thread is
    visible to its owner at once, and to others only when its topic is shared
    with them AND it has been approved (migration 0038).
  * The stored sign-in must belong to the mailbox the config names. If it is
    for another address the run stops before anything is listed.

Every run reads the whole labelled set (it is small by design), so the puller
runs as a full sync: a thread that no longer carries a tag label is absent
from the result and is tombstoned by ingest. `confirm_removed` looks at every
absent thread directly, so that taking a label off a thread is told apart
from a listing that came back short.

What a failure does:
  * A LISTED thread that cannot be read fails the run. Nothing is written, so
    a failed read never takes a thread out.
  * An ABSENT thread whose check fails is not confirmed. It is still hidden
    (tombstoned) when few are absent, and comes back on the next run if it
    still has its label: when unsure, a row is not shown. When many are
    absent and unconfirmed, ingest's bulk guard refuses the run instead.

The raw text of a thread is not kept in the raw-capture layer (the puller sets
BRONZE = False): that layer is never deleted from, and mail must leave the
database when its label is removed. Gmail itself stays the copy of record.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

from ..config import GMAIL_MAX_THREAD_CHARS, GMAIL_MAX_THREADS_PER_RUN, SOURCE_GMAIL, TIER_DISTILLED
from ..contract import Document
from ..tag_resolver import prefix_for, resolve
from ..tag_sources import gmail as gmail_tags
from . import gmail_client, gmail_text

USER_LABEL = "user"


class GmailConnectorError(RuntimeError):
    """Gmail could not be read, or the run could not safely go on."""


@dataclass(frozen=True, slots=True)
class GmailCollectResult:
    """What one collect() call found."""

    tag_labels: tuple[str, ...]
    threads_listed: int
    documents: int
    skipped_unlabelled: int

    def summary(self) -> str:
        return (
            f"[gmail] tag_labels={len(self.tag_labels)} listed={self.threads_listed} "
            f"documents={self.documents} skipped_unlabelled={self.skipped_unlabelled}"
        )


def tag_prefix(config: Any) -> str:
    """The label prefix: the source's own when set, else the general one."""
    return prefix_for(SOURCE_GMAIL, config)


def tag_labels(labels: Any, prefix: str) -> dict[str, str]:
    """Label id -> label name, for the user-made labels that are tags."""
    if not isinstance(labels, (list, tuple)):
        return {}
    named = {
        label["id"]: label["name"]
        for label in labels
        if isinstance(label, Mapping)
        and label.get("type") == USER_LABEL
        and isinstance(label.get("id"), str) and label["id"]
        and isinstance(label.get("name"), str)
    }
    tags = set(gmail_tags.label_tags(sorted(named.values()), prefix))
    return {label_id: name for label_id, name in named.items() if name.strip() in tags}


def _check_mailbox(service: Any, mailbox: Any) -> str:
    """The owner's email, once the sign-in is known to be for this mailbox."""
    owner = (mailbox.owner_email or "").strip().lower()
    if not owner:
        raise GmailConnectorError("The Gmail mailbox has no owner in the config.")
    try:
        signed_in = gmail_client.profile_email(service)
    except Exception as error:  # noqa: BLE001 - never echo what the API sent back
        raise GmailConnectorError(
            f"Gmail did not accept the stored sign-in ({type(error).__name__})."
        ) from error
    if signed_in != mailbox.email.strip().lower():
        raise GmailConnectorError(
            "The stored Gmail sign-in is for another mailbox than the one in the "
            "config (sources.gmail.mailboxes). Nothing was read."
        )
    return owner


def _tag_labels(service: Any, config: Any) -> dict[str, str]:
    try:
        return tag_labels(gmail_client.list_labels(service), tag_prefix(config))
    except Exception as error:  # noqa: BLE001
        raise GmailConnectorError(
            f"The Gmail labels could not be listed ({type(error).__name__})."
        ) from error


def _labelled_thread_ids(service: Any, label_ids: Iterable[str]) -> list[str]:
    try:
        listed = [tid for lid in sorted(label_ids)
                  for tid in gmail_client.list_thread_ids(service, lid)]
    except Exception as error:  # noqa: BLE001
        raise GmailConnectorError(
            f"The labelled threads could not be listed ({type(error).__name__})."
        ) from error
    ids = sorted(dict.fromkeys(listed))
    if len(ids) > GMAIL_MAX_THREADS_PER_RUN:
        raise GmailConnectorError(
            f"{len(ids)} threads carry a tag label, above the limit of "
            f"{GMAIL_MAX_THREADS_PER_RUN} for one run. Nothing was read."
        )
    return ids


def _thread_labels(messages: Sequence[dict], tags: Mapping[str, str]) -> list[str]:
    """The names of the tag labels on a thread, without repeats, sorted."""
    ids = {lid for m in messages for lid in (m.get("labelIds") or []) if lid in tags}
    return sorted({tags[lid] for lid in ids})


def thread_to_document(
    thread_id: str, messages: Sequence[dict], label_names: Sequence[str],
    config: Any, mailbox: Any, owner: str,
) -> Document:
    """The Document for one thread that carries at least one tag label."""
    text, subject = gmail_text.assemble(messages, GMAIL_MAX_THREAD_CHARS)
    title = subject.strip() or "(no subject)"
    people = gmail_text.participants(messages)
    assignment = resolve(
        SOURCE_GMAIL, gmail_tags.label_tags(list(label_names), tag_prefix(config)), (), config
    )
    return Document(
        source=SOURCE_GMAIL,
        external_id=thread_id,
        title=title,
        body=text if text.strip() else title,
        distillation=None,
        url=f"https://mail.google.com/mail/?authuser={mailbox.email}#all/{thread_id}",
        author=people[0] if people else None,
        domains=assignment.domains,
        tier=TIER_DISTILLED,
        source_created_at=gmail_text.sent_at(messages[-1]),
        metadata={
            "thread_id": thread_id,
            "message_ids": [m["id"] for m in messages if m.get("id")],
            "participants": people,
            "labels": list(label_names),
            "message_count": len(messages),
            "mailbox": mailbox.email,
            "domain_match": assignment.matched_by,
        },
        tag_source=assignment.matched_by,
        tag_signals=assignment.signals,
        owner_email=owner,
    )


def _read_thread(service: Any, thread_id: str) -> list[dict]:
    try:
        thread = gmail_client.get_thread(service, thread_id)
    except Exception as error:  # noqa: BLE001
        if gmail_client.is_not_found(error):
            return []
        raise GmailConnectorError(
            f"Thread {thread_id} could not be read ({type(error).__name__}). "
            "The run stops here: a failed read is never treated as a removed label."
        ) from error
    return [m for m in thread.get("messages") or [] if isinstance(m, dict)]


def collect(service: Any, config: Any, mailbox: Any) -> tuple[list[Document], GmailCollectResult]:
    """Every thread in `mailbox` that carries a tag label, as Documents."""
    owner = _check_mailbox(service, mailbox)
    tags = _tag_labels(service, config)
    thread_ids = _labelled_thread_ids(service, tags) if tags else []

    documents: list[Document] = []
    skipped = 0
    for thread_id in thread_ids:
        messages = _read_thread(service, thread_id)
        names = _thread_labels(messages, tags)
        if not messages or not names:
            # Deleted, or its label came off after the listing: not indexed.
            skipped += 1
            continue
        documents.append(thread_to_document(thread_id, messages, names, config, mailbox, owner))

    return documents, GmailCollectResult(
        tag_labels=tuple(sorted(tags.values())),
        threads_listed=len(thread_ids),
        documents=len(documents),
        skipped_unlabelled=skipped,
    )


def _has_no_tag_label(service: Any, thread_id: str, tags: Mapping[str, str]) -> bool:
    """True when the thread is gone or carries no tag label. False if unsure."""
    try:
        thread = gmail_client.get_thread(service, thread_id, labels_only=True)
    except Exception as error:  # noqa: BLE001 - unsure is "not confirmed"
        return gmail_client.is_not_found(error)
    messages = [m for m in thread.get("messages") or [] if isinstance(m, dict)]
    return not _thread_labels(messages, tags)


def confirm_removed(
    service: Any, config: Any, mailbox: Any, thread_ids: Sequence[str]
) -> frozenset[str]:
    """Which of these indexed threads no longer carry any tag label.

    Every one is looked at directly (labels only, never its text): a cap
    would leave the rest counted against ingest's bulk guard run after run. A
    thread that cannot be checked is not confirmed.
    """
    wanted = [tid for tid in thread_ids if gmail_client.valid_thread_id(tid)]
    if not wanted:
        return frozenset()
    _check_mailbox(service, mailbox)
    tags = _tag_labels(service, config)
    return frozenset(tid for tid in wanted if _has_no_tag_label(service, tid, tags))
