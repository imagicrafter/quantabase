"""Topics for a Drive file: whose tags count, and which tag wins.

Pure functions over the listing; nothing here talks to Drive.

Whose tags count is `sources.drive.trust_tags_from`. With `owner` (the
default) a description tag counts only on an item the signed-in account owns.
A tag on someone else's item is hidden from tag reading -- that level is
treated as carrying no tag -- and every file with such an item on it or
above it carries the signal `ignored_foreign_tag`. An item whose owner Drive
does not report is treated as someone else's. Anything but an explicit
`anyone` is treated as `owner`.

Which tag wins: the file's own description tag, else the nearest tagged
folder above it, else the source default, else `unclassified`.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Sequence

from ..config import SOURCE_DRIVE
from ..engine_config import UNCLASSIFIED
from ..tag_resolver import (
    IGNORED_FOREIGN_TAG,
    MATCH_CONTAINER,
    MATCH_DEFAULT,
    DomainAssignment,
    prefix_for,
    resolve,
)
from ..tag_sources import drive as drive_tags
from .drive_client import owned_by_me

TRUST_OWNER = "owner"
TRUST_ANYONE = "anyone"

# A file under more folder paths than this is treated as ambiguous.
MAX_FOLDER_CHAINS = 16


def _tag_view(item: dict, prefix: str, trust: str) -> tuple[dict, bool]:
    """(the item as tags may be read from it, whether a tag was ignored).

    With `owner` trust, an item the signed-in account does not own has its
    description hidden from tag reading. Anything but an explicit `anyone`
    is treated as `owner`.
    """
    if trust == TRUST_ANYONE or owned_by_me(item):
        return item, False
    ignored = bool(drive_tags.tags_in(item.get(drive_tags.DESCRIPTION_FIELD), prefix))
    return {**item, drive_tags.DESCRIPTION_FIELD: None}, ignored


def apply_tag_trust(items: Sequence[dict], config) -> tuple[list[dict], frozenset[str]]:
    """Every item as tags may be read from it, and the ids whose tag was ignored."""
    prefix = prefix_for(SOURCE_DRIVE, config)
    trust = getattr(config.sources.drive, "trust_tags_from", TRUST_OWNER)
    views = [_tag_view(item, prefix, trust) for item in items]
    ignored = frozenset(view["id"] for view, was_ignored in views if was_ignored and view.get("id"))
    return [view for view, _ in views], ignored


def _chains(parent_ids: Sequence[str], folders: dict[str, dict]) -> list[tuple[list[dict], bool]]:
    """Every folder chain above an item, as (folders nearest first, complete).

    One chain per path: a legacy item with several parents has several. A
    chain is complete when it ends at a folder with no parent. One that ends
    at an id the listing does not hold is NOT complete here -- the caller
    checks that id against the Drive root. A cycle is never complete.
    """
    chains: list[tuple[list[dict], bool]] = []
    pending: list[tuple[str, tuple[dict, ...], frozenset[str]]] = [
        (parent, (), frozenset()) for parent in parent_ids
    ]
    while pending and len(chains) < MAX_FOLDER_CHAINS:
        current, path, seen = pending.pop()
        if current not in folders or current in seen:
            chains.append(([*path, {"_missing_parent": current}], False))
            continue
        folder = folders[current]
        parents = folder.get("parents") or []
        if not parents:
            chains.append(([*path, folder], True))
            continue
        pending.extend((parent, (*path, folder), seen | {current}) for parent in parents)
    return chains


def _unclassified(signal: str) -> DomainAssignment:
    return DomainAssignment((UNCLASSIFIED,), MATCH_DEFAULT, (signal,))


def _chain_assignment(
    chain: list[dict], complete: bool, roots: frozenset[str], config
) -> DomainAssignment:
    """Topics from one folder chain (no content tag on the file)."""
    tail = chain[-1] if chain else {}
    ends_at_root = tail.get("_missing_parent") in roots
    real = [folder for folder in chain if "_missing_parent" not in folder]
    _content, containers = drive_tags.item_tags({}, real, prefix_for(SOURCE_DRIVE, config))
    assignment = resolve(SOURCE_DRIVE, (), containers, config)
    if assignment.matched_by != MATCH_CONTAINER and not (complete or ends_at_root):
        # A folder above this file is missing from the listing. It may carry
        # a tag, so the source default must not be used.
        return _unclassified("folder_chain_incomplete")
    return assignment


def _resolve_item(
    item: dict, chains: list[tuple[list[dict], bool]], roots: frozenset[str], config
) -> DomainAssignment:
    prefix = prefix_for(SOURCE_DRIVE, config)
    content, _none = drive_tags.item_tags(item, (), prefix)
    if content:
        return resolve(SOURCE_DRIVE, content, (), config)
    if not chains:
        return resolve(SOURCE_DRIVE, (), (), config)
    if len(chains) >= MAX_FOLDER_CHAINS:
        return _unclassified("ambiguous_folder")
    found = [_chain_assignment(chain, complete, roots, config) for chain, complete in chains]
    if len({frozenset(assignment.domains) for assignment in found}) > 1:
        return _unclassified("ambiguous_folder")
    return found[0]


def assignment(
    item: dict,
    folders: dict[str, dict],
    roots: frozenset[str],
    config,
    ignored: frozenset[str] = frozenset(),
) -> DomainAssignment:
    """Topics for one file: its own description tag, else the nearest tagged
    folder above it, else the source default, else `unclassified`.

    When the file sits under several folder chains they must all agree;
    otherwise it is `unclassified`.

    `item` and `folders` are the views from `apply_tag_trust`; `ignored` holds
    the ids whose tag was not trusted. A file with such an id on it or above
    it carries the `ignored_foreign_tag` signal.
    """
    chains = _chains(item.get("parents") or [], folders)
    found = _resolve_item(item, chains, roots, config)
    touched = {item.get("id"), *(folder.get("id") for chain, _ in chains for folder in chain)}
    if ignored & touched:
        return replace(found, signals=(*found.signals, IGNORED_FOREIGN_TAG))
    return found
