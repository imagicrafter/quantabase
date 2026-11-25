"""The ingest contract.

Every connector emits `Document` objects and nothing else. Validation happens on
construction, so an invalid document cannot reach the database. Frozen dataclass:
transforms return new instances rather than mutating.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .config import domains as configured_domains, TIER_RAW, TIER_VERIFIED
from .tag_resolver import MATCHED_BY


class DocumentValidationError(ValueError):
    """A connector emitted a document that violates the ingest contract."""


def embed_text_for(title: str, distillation: str) -> str:
    """The exact text embedded for a title + distillation pair.

    Shared so the distiller writes the same embedding a connector would compute
    for the same content. If these ever diverge, `_embed_hash` stops matching and
    every run re-embeds the corpus.
    """
    return f"{title}\n\n{(distillation or '').strip()}"


def embed_hash_for(title: str, distillation: str) -> str:
    """Hash of the embedded text, matching `Document.embed_hash`."""
    return hashlib.sha256(
        embed_text_for(title, distillation).encode("utf-8")
    ).hexdigest()


def _require_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DocumentValidationError(
            f"{field_name} must be a non-empty string, got {value!r}"
        )
    return value


@dataclass(frozen=True, slots=True)
class Document:
    """One document. The unit is whatever a human would want handed back whole.

    A wiki page, an email thread (not a message), a meeting, an artifact.
    Section rows set `parent_external_id`; whole documents leave it None.
    """

    source: str
    external_id: str
    title: str
    body: str
    domains: tuple[str, ...]
    distillation: str | None = None
    url: str | None = None
    author: str | None = None
    tier: int = TIER_RAW
    parent_external_id: str | None = None
    source_created_at: datetime | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
    # How `domains` was decided (see tag_resolver): which level of the source
    # carried the tag, and what was read there. None on a document built
    # without the resolver.
    tag_source: str | None = None
    tag_signals: tuple[str, ...] = ()
    # The email of the person this document belongs to. Set for mail only:
    # the owner of the mailbox it was read from. Ingest turns it into the
    # person's id (see owners.py). None for every other source.
    owner_email: str | None = None

    def __post_init__(self) -> None:
        _require_text(self.source, "source")
        _require_text(self.external_id, "external_id")
        _require_text(self.title, "title")
        _require_text(self.body, "body")

        if not isinstance(self.tier, int) or not TIER_VERIFIED <= self.tier <= TIER_RAW:
            raise DocumentValidationError(
                f"tier must be an int in {TIER_VERIFIED}..{TIER_RAW}, got {self.tier!r}"
            )

        if not isinstance(self.domains, tuple) or not self.domains:
            raise DocumentValidationError(
                f"domains must be a non-empty tuple, got {self.domains!r}. "
                "An empty domains array makes the row invisible to every principal."
            )

        unknown = [d for d in self.domains if d not in configured_domains()]
        if unknown:
            raise DocumentValidationError(
                f"unknown domains {unknown} on {self.source}:{self.external_id}. "
                f"Known domains: {list(configured_domains())}"
            )

        if len(set(self.domains)) != len(self.domains):
            raise DocumentValidationError(
                f"duplicate domains on {self.source}:{self.external_id}: {self.domains}"
            )

        if self.source_created_at is not None and not isinstance(
            self.source_created_at, datetime
        ):
            raise DocumentValidationError(
                f"source_created_at must be a datetime or None, "
                f"got {self.source_created_at!r}"
            )

        self._validate_provenance()
        self._normalise_owner()

    def _normalise_owner(self) -> None:
        if self.owner_email is None:
            return
        owner = self.owner_email.strip().lower() if isinstance(self.owner_email, str) else ""
        if "@" not in owner:
            raise DocumentValidationError(
                f"owner_email must be an email address or None, got {self.owner_email!r}"
            )
        # Frozen dataclass: the one normalisation done at construction.
        object.__setattr__(self, "owner_email", owner)

    def _validate_provenance(self) -> None:
        if self.tag_source is not None and self.tag_source not in MATCHED_BY:
            raise DocumentValidationError(
                f"tag_source must be one of {MATCHED_BY} or None, got {self.tag_source!r}"
            )
        if not isinstance(self.tag_signals, tuple) or not all(
            isinstance(signal, str) for signal in self.tag_signals
        ):
            raise DocumentValidationError(
                f"tag_signals must be a tuple of strings, got {self.tag_signals!r}"
            )

    @property
    def embed_text(self) -> str:
        """The text that actually gets embedded.

        The distillation when present, otherwise title plus the leading body.
        Embedding a raw transcript is the documented failure mode; this fallback
        is a floor, not a design.
        """
        if self.distillation and self.distillation.strip():
            return embed_text_for(self.title, self.distillation)
        return f"{self.title}\n\n{self.body[:1500]}"

    @property
    def embed_hash(self) -> str:
        """Hash of the text that gets embedded.

        Separate from `source_hash` on purpose. Embedding is the expensive part of
        ingest, and most row changes -- a new metadata field, a re-labelled domain
        -- do not alter the embedded text. Splitting the two means a connector
        change writes rows without paying to re-embed them.
        """
        return hashlib.sha256(self.embed_text.encode("utf-8")).hexdigest()

    @property
    def source_hash(self) -> str:
        """Stable hash over everything that would change the stored row.

        An unchanged hash means the row is skipped entirely: no write. Includes
        `metadata`, so a connector that starts emitting a new field actually
        updates existing rows rather than silently leaving them stale.

        **`distillation` is deliberately EXCLUDED.** The distiller replaces a
        connector's placeholder summary with a generated one, in place. If that
        field were hashed, every connector re-run would see a mismatch, overwrite
        the generated summary with its own placeholder, and re-embed — undoing the
        distiller on a loop. Excluding it is safe because the distillation is
        always derived from `title` + `body`, both of which ARE hashed: if the
        source content moves, the hash moves, and the row is rewritten anyway.

        Field order is fixed and metadata keys are sorted, so the hash is
        reproducible across runs and across Python versions.
        """
        parts = (
            self.title,
            self.body,
            self.url or "",
            self.author or "",
            "|".join(sorted(self.domains)),
            str(self.tier),
            self.parent_external_id or "",
            self.source_created_at.isoformat() if self.source_created_at else "",
            json.dumps(dict(self.metadata), sort_keys=True, default=str),
        )
        # Added only when present, so a document built without the resolver
        # keeps the hash it always had.
        if self.tag_source is not None:
            parts = (*parts, self.tag_source, "|".join(self.tag_signals))
        # Likewise: only a document that has an owner hashes it, so a change
        # of owner rewrites the row (and puts it back in review).
        if self.owner_email is not None:
            parts = (*parts, f"owner:{self.owner_email}")
        digest = hashlib.sha256("\x1f".join(parts).encode("utf-8"))
        return digest.hexdigest()

    def with_domains(self, domains: Sequence[str]) -> "Document":
        """Return a new Document with replaced domains. Never mutates."""
        return replace(self, domains=tuple(domains))

    def with_assignment(self, assignment: Any) -> "Document":
        """Return a new Document carrying a resolver result: its topics and
        how they were decided. Never mutates."""
        return replace(
            self,
            domains=tuple(assignment.domains),
            tag_source=assignment.matched_by,
            tag_signals=tuple(assignment.signals),
        )

    def to_row(self) -> dict[str, Any]:
        """Serialise to a workspace.documents row. Embedding is added by ingest."""
        created = self.source_created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)

        # embed_hash rides in metadata rather than its own column, so ingest can
        # tell whether a stored embedding is still valid without a schema change.
        metadata = {**dict(self.metadata), "_embed_hash": self.embed_hash}

        return {
            "source": self.source,
            "external_id": self.external_id,
            "source_hash": self.source_hash,
            "parent_external_id": self.parent_external_id,
            "title": self.title,
            "body": self.body,
            "distillation": self.distillation,
            "url": self.url,
            "author": self.author,
            "domains": list(self.domains),
            "tier": self.tier,
            "metadata": metadata,
            "source_created_at": created.isoformat() if created else None,
            "tag_source": self.tag_source,
            "tag_signals": None if self.tag_source is None else list(self.tag_signals),
        }
