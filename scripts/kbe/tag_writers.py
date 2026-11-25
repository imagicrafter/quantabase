"""Write a tag back to its source. Called only by `kbe tags apply --write`.

  wiki   the frontmatter key in a page of a LOCAL clone. Everything else in
         the file is kept byte for byte. Nothing is committed.
  drive  `<prefix><topic>` in the file's Description, through a client the
         caller passes in (authorised separately, with metadata-write scope;
         the puller's own token stays read-only).
  gmail  the label `<prefix><topic>` on the thread, through a client the
         caller passes in.

The Drive and Gmail functions never build a client themselves, so they can be
tested with a fake and can never reach a real account by accident.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Mapping, Protocol, Sequence

from knowledge.frontmatter import parse as parse_frontmatter
from knowledge.tag_sources import drive as drive_tags, wiki as wiki_tags

_TOPIC = re.compile(r"^[a-z][a-z0-9-]*$")
_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
_DELIMITER = "---"
_BOM = "\ufeff"


class TagWriteError(RuntimeError):
    """A tag could not be written. Nothing was changed."""


class DriveClient(Protocol):
    def get_description(self, file_id: str) -> str: ...

    def set_description(self, file_id: str, description: str) -> None: ...


class GmailClient(Protocol):
    def labels(self) -> Mapping[str, str]: ...  # label name -> id

    def create_label(self, name: str) -> str: ...

    def thread_label_ids(self, thread_id: str) -> Sequence[str]: ...

    def modify_thread(
        self, thread_id: str, add: Sequence[str], remove: Sequence[str]
    ) -> None: ...


def _checked_topics(topics: Sequence[str]) -> tuple[str, ...]:
    cleaned = tuple(dict.fromkeys(topics))
    if not cleaned or not all(isinstance(t, str) and _TOPIC.fullmatch(t) for t in cleaned):
        raise TagWriteError(f"not a list of topic ids: {list(topics)!r}")
    return cleaned


# --- wiki ---------------------------------------------------------------------


def _newline(text: str) -> str:
    first = text.split("\n", 1)[0]
    return "\r\n" if first.endswith("\r") else "\n"


def _closing_index(lines: Sequence[str]) -> int | None:
    for index in range(1, len(lines)):
        if lines[index].rstrip() == _DELIMITER:
            return index
    return None


def _key_span(lines: Sequence[str], key: str, end: int) -> tuple[int, int] | None:
    """Line range [start, stop) holding `key:` and its continuation lines."""
    head = re.compile(rf"^{re.escape(key)}[ \t]*:(.*)$")
    for start in range(1, end):
        match = head.match(lines[start].rstrip("\r\n"))
        if not match:
            continue
        block_list = not match.group(1).strip()
        stop = start + 1
        while stop < end and (
            lines[stop][:1] in (" ", "\t") or (block_list and lines[stop].startswith("-"))
        ):
            stop += 1
        return start, stop
    return None


def set_frontmatter_key(text: str, key: str, topics: Sequence[str]) -> str:
    """`text` with `key: [topics]` in its frontmatter; nothing else changes.

    A page without frontmatter gets a new block on top of its untouched text.
    """
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        raise TagWriteError(f"not a frontmatter key: {key!r}")
    values = _checked_topics(topics)
    newline = _newline(text)
    entry = f"{key}: [{', '.join(values)}]{newline}"

    if text.startswith(_BOM):
        raise TagWriteError("the page starts with a byte-order mark; remove it first")
    lines = text.splitlines(keepends=True)
    opens = bool(lines) and lines[0].rstrip() == _DELIMITER
    closing = _closing_index(lines) if opens else None
    if opens and closing is None:
        raise TagWriteError("the page's frontmatter block is never closed; fix it first")
    if closing is None:
        updated = f"{_DELIMITER}{newline}{entry}{_DELIMITER}{newline}{text}"
    else:
        span = _key_span(lines, key, closing)
        start, stop = span if span else (closing, closing)
        updated = "".join([*lines[:start], entry, *lines[stop:]])

    if wiki_tags.content_tags(parse_frontmatter(updated).frontmatter, key) != values:
        raise TagWriteError("the edited frontmatter does not read back as intended")
    return updated


def wiki_page_path(root: Path, external_id: str) -> Path:
    """The page file for a wiki row, refusing anything outside the clone."""
    base = Path(root).resolve()
    if not base.is_dir():
        raise TagWriteError(f"wiki clone not found: {root}")
    if not external_id or "#" in external_id or not external_id.endswith(".md"):
        raise TagWriteError(f"not a wiki page id: {external_id!r}")
    path = (base / external_id).resolve()
    if base not in path.parents:
        raise TagWriteError(f"{external_id!r} is outside the wiki clone")
    if not path.is_file():
        raise TagWriteError(f"no such page in the clone: {external_id}")
    return path


def write_wiki_tag(root: Path, external_id: str, topics: Sequence[str], key: str) -> bool:
    """Set the page's tag in the local clone. Returns False when already set."""
    path = wiki_page_path(root, external_id)
    try:
        original = path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise TagWriteError(f"could not read {external_id}: {error}") from error
    updated = set_frontmatter_key(original, key, topics)
    if updated == original:
        return False
    try:
        path.write_bytes(updated.encode("utf-8"))
    except OSError as error:
        raise TagWriteError(f"could not write {external_id}: {error}") from error
    return True


# --- drive --------------------------------------------------------------------


def tagged_description(description: str | None, topics: Sequence[str], prefix: str) -> str:
    """The description with exactly these tags. Other text is kept."""
    values = _checked_topics(topics)
    current = description or ""
    wanted = tuple(f"{prefix}{topic}" for topic in values)
    present = tuple(tag.lower() for tag in drive_tags.tags_in(current, prefix))
    if present and set(present) == {tag.lower() for tag in wanted}:
        return current
    rest = drive_tags.tag_pattern(prefix).sub("", current) if present else current
    rest = re.sub(r"[ \t]{2,}", " ", rest).strip() if present else rest.rstrip()
    tags = " ".join(wanted)
    return f"{rest}\n{tags}" if rest else tags


def write_drive_tag(
    client: DriveClient, file_id: str, topics: Sequence[str], prefix: str
) -> bool:
    """Set the file's (or folder's) description tag. False when already set."""
    if not isinstance(file_id, str) or not file_id.strip():
        raise TagWriteError("a Drive file id is required")
    try:
        current = client.get_description(file_id) or ""
        updated = tagged_description(current, topics, prefix)
        if updated == current:
            return False
        client.set_description(file_id, updated)
    except TagWriteError:
        raise
    except Exception as error:  # noqa: BLE001 - any API failure, reported by id
        raise TagWriteError(f"Drive update failed for {file_id}: {type(error).__name__}") from error
    return True


# --- gmail --------------------------------------------------------------------


def _gmail_change(
    client: GmailClient, thread_id: str, wanted: Sequence[str], prefix: str
) -> tuple[list[str], list[str]]:
    """(label ids to add, label ids to remove) so the thread ends with exactly
    the wanted tag labels. Labels without the prefix are never touched."""
    known = {name.lower(): label_id for name, label_id in client.labels().items()}
    wanted_ids = [known.get(name.lower()) or client.create_label(name) for name in wanted]
    tag_ids = {label_id for name, label_id in known.items() if name.startswith(prefix.lower())}
    current = set(client.thread_label_ids(thread_id))
    add = [label_id for label_id in wanted_ids if label_id not in current]
    remove = sorted((current & tag_ids) - set(wanted_ids))
    return add, remove


def write_gmail_labels(
    client: GmailClient, thread_id: str, topics: Sequence[str], prefix: str
) -> bool:
    """Leave the thread with exactly the labels `<prefix><topic>` as its tags.

    A tag label for another topic is taken off: leaving it on would keep the
    thread visible to that topic too. Returns False when nothing changed.
    """
    values = _checked_topics(topics)
    if not isinstance(thread_id, str) or not thread_id.strip():
        raise TagWriteError("a Gmail thread id is required")
    if not isinstance(prefix, str) or not prefix:
        raise TagWriteError("a tag prefix is required")
    try:
        add, remove = _gmail_change(client, thread_id, [f"{prefix}{t}" for t in values], prefix)
        if not add and not remove:
            return False
        client.modify_thread(thread_id, add, remove)
    except Exception as error:  # noqa: BLE001 - any API failure, reported by id
        raise TagWriteError(f"Gmail update failed for {thread_id}: {type(error).__name__}") from error
    return True
