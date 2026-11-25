"""Drive connector -- Google Workspace artifacts into the documents table.

One row per artifact. This is what makes a deliverable findable by what it IS
("the statement of work") rather than only by remembering its filename.

Which kinds of file are indexed is `sources.drive.include_mime` in the Engine
config: `docs`, `sheets`, `slides` (the default) and `pdf`. A Drive full of
scanned PDFs would bury the documents that answer questions, so `pdf` is
opt-in.

Only Google Docs expose plain text cheaply, so Sheets, Slides and PDFs are
indexed on metadata alone. That is enough to find them; opening them is the
second hop, the same way a wiki page is read whole after being located.

Whose tags count is `sources.drive.trust_tags_from`. With `owner` (the
default) a description tag counts only on an item the signed-in account owns;
a tag on someone else's item is ignored and the document carries the signal
`ignored_foreign_tag`. An item whose owner Drive does not report is treated
as someone else's.

The sign-in comes from `drive_client.py`: two values in the local settings
file, decoded in memory. Nothing outside this repository is imported.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from ..config import (
    DRIVE_EXCLUDED_FOLDERS,
    DRIVE_FETCH_BODY_MIMES,
    DRIVE_INDEXED_MIMES,
    DRIVE_MAX_BODY_CHARS,
    DRIVE_MAX_FILES,
    DRIVE_MIME_DOC,
    DRIVE_MIME_FOLDER,
    DRIVE_MIME_SHEET,
    DRIVE_MIME_SLIDE,
    sensitive_domains as configured_sensitive_domains,
    SOURCE_DRIVE,
    TIER_CURATED,
)
from ..contract import Document
from ..engine_config import get_config
from . import drive_client
from .drive_topics import apply_tag_trust, assignment as _assignment

DRIVE_MIME_PDF = "application/pdf"

# `sources.drive.include_mime` kind -> the Drive MIME type it selects.
MIME_BY_KIND = {
    "docs": DRIVE_MIME_DOC,
    "sheets": DRIVE_MIME_SHEET,
    "slides": DRIVE_MIME_SLIDE,
    "pdf": DRIVE_MIME_PDF,
}

MIME_LABELS = {
    DRIVE_MIME_DOC: "Google Doc",
    DRIVE_MIME_SHEET: "Google Sheet",
    DRIVE_MIME_SLIDE: "Google Slides",
    DRIVE_MIME_PDF: "PDF",
}


FILE_FIELDS = (
    "nextPageToken,"
    "files(id,name,mimeType,modifiedTime,createdTime,parents,webViewLink,"
    # `description` carries the tag: `<prefix><topic>` on a file or a folder.
    # `ownedByMe` says whether the signed-in account owns the item, which
    # decides whether that tag counts (`sources.drive.trust_tags_from`).
    "description,ownedByMe,owners(emailAddress,displayName))"
)


class DriveConnectorError(RuntimeError):
    """Drive could not be read."""


@dataclass(frozen=True, slots=True)
class DriveAudit:
    """One row per artifact, so domain assignments stay reviewable."""

    file_id: str
    name: str
    mime: str
    folder_path: str
    domains: tuple[str, ...]
    matched_by: str
    has_body: bool


def _drive_service():
    """A read-only Drive client for the sign-in in the local settings file."""
    try:
        return drive_client.service_from_settings()
    except drive_client.DriveClientError as error:
        raise DriveConnectorError(str(error)) from error


def wanted_mimes(config, include_mimes: Sequence[str] | None = None) -> tuple[str, ...]:
    """The MIME types to index: an explicit list, else the config's kinds."""
    if include_mimes:
        return tuple(include_mimes)
    kinds = getattr(config.sources.drive, "include_mime", None) or ()
    chosen = tuple(MIME_BY_KIND[kind] for kind in kinds if kind in MIME_BY_KIND)
    return chosen or DRIVE_INDEXED_MIMES


def _list_all(service) -> list[dict]:
    """Every non-trashed item, folders included, paginated."""
    items: list[dict] = []
    page_token = None

    while True:
        try:
            response = (
                service.files()
                .list(
                    q="trashed = false",
                    pageSize=1000,
                    pageToken=page_token,
                    fields=FILE_FIELDS,
                )
                .execute()
            )
        except Exception as error:
            raise DriveConnectorError(f"Drive listing failed: {error}") from error

        items.extend(response.get("files", []))
        page_token = response.get("nextPageToken")
        if not page_token or len(items) > DRIVE_MAX_FILES * 5:
            break

    return items


def _folders_by_id(items: Sequence[dict]) -> dict[str, dict]:
    return {
        item["id"]: item
        for item in items
        if item.get("mimeType") == DRIVE_MIME_FOLDER and item.get("id")
    }


def _ancestors(folder_id: str | None, folders: dict[str, dict]) -> list[dict]:
    """The folder and every folder above it, nearest first.

    Iterative rather than recursive: Drive permits parent cycles through shared
    folders, and a recursive walk would not terminate. `seen` is the guard.
    """
    chain: list[dict] = []
    seen: set[str] = set()
    current = folder_id

    while current in folders and current not in seen:
        seen.add(current)
        chain.append(folders[current])
        parents = folders[current].get("parents") or []
        current = parents[0] if parents else None

    return chain


def _folder_paths(items: Sequence[dict]) -> dict[str, str]:
    """Map folder id -> human-readable path."""
    folders = _folders_by_id(items)
    return {
        folder_id: "/".join(
            folder.get("name", "?") for folder in reversed(_ancestors(folder_id, folders))
        )
        for folder_id in folders
    }


def _root_ids(service) -> frozenset[str]:
    """Ids a folder chain may legitimately end at: the owner's My Drive root.

    The root is not in the listing, so every complete chain ends at an id the
    listing does not hold. Knowing the root is what tells a complete chain
    from one with a folder missing.
    """
    try:
        root = service.files().get(fileId="root", fields="id").execute()
    except Exception as error:
        raise DriveConnectorError(f"Could not read the Drive root: {error}") from error
    return frozenset({root["id"]}) if root.get("id") else frozenset()


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _fetch_body(service, file_id: str) -> str:
    """Plain text of a Google Doc. Returns empty string on any failure.

    A single unreadable document must not abort a whole run.
    """
    try:
        return drive_client.export_text(service, file_id, DRIVE_MAX_BODY_CHARS)
    except Exception:  # noqa: BLE001 - one document must not end the run
        return ""


def _build_body(item: dict, folder_path: str, text: str) -> str:
    """The keyword-searchable text.

    Always leads with a metadata header, so a Sheet or Slides deck with no
    extractable text is still findable by name, type and location.
    """
    header = "\n".join(
        line
        for line in (
            f"Title: {item.get('name', '')}",
            f"Type: {MIME_LABELS.get(item.get('mimeType', ''), 'Drive file')}",
            f"Location: {folder_path or 'My Drive'}",
            f"Link: {item.get('webViewLink', '')}",
        )
        if line.rsplit(": ", 1)[-1]
    )
    return f"{header}\n\n{text}".strip() if text else header


def _build_distillation(item: dict, folder_path: str, text: str) -> str:
    """What this artifact is and where it lives.

    Not a model's summary -- the distiller writes that later. This is a
    structured stand-in: type, location, and the opening of the document. It
    embeds far better than raw body text and never fabricates.
    """
    kind = MIME_LABELS.get(item.get("mimeType", ""), "Drive file")
    where = folder_path or "My Drive"
    opening = " ".join(text.split())[:400] if text else ""

    parts = [f"{kind} in {where}."]
    if opening:
        parts.append(opening)
    return " ".join(parts)


def _owner(item: dict) -> str | None:
    owners = item.get("owners") or []
    if not owners:
        return None
    return owners[0].get("emailAddress") or owners[0].get("displayName")


def _is_excluded(folder_path: str) -> bool:
    segments = {segment.strip() for segment in folder_path.split("/")}
    return any(excluded in segments for excluded in DRIVE_EXCLUDED_FOLDERS)


def collect(
    *,
    include_sensitive: bool = False,
    include_mimes: Sequence[str] | None = None,
    fetch_bodies: bool = True,
    limit: int | None = None,
) -> tuple[list[Document], list[DriveAudit]]:
    """Read Drive and emit one Document per artifact."""
    service = _drive_service()
    config = get_config()
    items, ignored = apply_tag_trust(_list_all(service), config)
    paths = _folder_paths(items)
    folders = _folders_by_id(items)
    roots = _root_ids(service)

    wanted = wanted_mimes(config, include_mimes)
    sensitive = set(configured_sensitive_domains())

    candidates = [
        item
        for item in items
        if item.get("mimeType") in wanted and item.get("id")
    ]
    candidates.sort(key=lambda item: item.get("modifiedTime") or "", reverse=True)

    if limit is not None:
        candidates = candidates[:limit]
    if len(candidates) > DRIVE_MAX_FILES:
        raise DriveConnectorError(
            f"{len(candidates)} files match, above the {DRIVE_MAX_FILES} guard. "
            "Narrow sources.drive.include_mime or raise DRIVE_MAX_FILES deliberately."
        )

    documents: list[Document] = []
    audits: list[DriveAudit] = []
    skipped_excluded = 0

    for item in candidates:
        parents = item.get("parents") or []
        folder_path = paths.get(parents[0], "") if parents else ""

        if _is_excluded(folder_path):
            skipped_excluded += 1
            continue

        name = (item.get("name") or "").strip()
        if not name:
            continue

        text = ""
        if fetch_bodies and item.get("mimeType") in DRIVE_FETCH_BODY_MIMES:
            text = _fetch_body(service, item["id"])

        assignment = _assignment(item, folders, roots, config, ignored)

        if not include_sensitive and sensitive.intersection(assignment.domains):
            continue

        body = _build_body(item, folder_path, text)
        documents.append(
            Document(
                source=SOURCE_DRIVE,
                external_id=item["id"],
                title=name,
                body=body,
                distillation=_build_distillation(item, folder_path, text),
                url=item.get("webViewLink"),
                author=_owner(item),
                domains=assignment.domains,
                # A Drive artifact is a structured record, not confirmed
                # knowledge: it is evidence a decision produced something, not a
                # statement of what was decided.
                tier=TIER_CURATED,
                source_created_at=_parse_time(item.get("createdTime")),
                metadata={
                    "mime_type": item.get("mimeType"),
                    "folder_path": folder_path,
                    "modified_time": item.get("modifiedTime"),
                    "domain_match": assignment.matched_by,
                    "body_extracted": bool(text),
                },
                tag_source=assignment.matched_by,
                tag_signals=assignment.signals,
            )
        )
        audits.append(
            DriveAudit(
                file_id=item["id"],
                name=name,
                mime=item.get("mimeType", ""),
                folder_path=folder_path,
                domains=assignment.domains,
                matched_by=assignment.matched_by,
                has_body=bool(text),
            )
        )

    if skipped_excluded:
        print(f"[drive] skipped {skipped_excluded} file(s) in excluded folders")

    return documents, audits


def iter_audit_rows(audits: Iterable[DriveAudit]):
    for audit in audits:
        yield {
            "file_id": audit.file_id,
            "name": audit.name,
            "mime": audit.mime.replace("application/vnd.google-apps.", ""),
            "folder_path": audit.folder_path,
            "domains": ",".join(audit.domains),
            "matched_by": audit.matched_by,
            "has_body": audit.has_body,
        }
