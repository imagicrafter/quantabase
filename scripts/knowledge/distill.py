"""The distillation contract.

A distillation is a structured summary of one document, written so it serves BOTH
retrieval paths:

    WHAT   one sentence -- what this document is
    WHY    one or two sentences -- why it exists, what it decided or produced,
           and its current standing (superseded, draft, active)
    TERMS  concrete strings a person might type: names, org names, identifiers,
           amounts, dates, tickers, document codes

`TERMS` is the half that a prose summary loses. It matters most for Drive
Sheets and Slides, which have no extractable body text at all -- for those the
distillation is the *only* searchable text, so if it does not name the client, the
phase and the document code, nothing does.

**Every term must appear verbatim in the source.** That makes fabrication a
mechanical test failure rather than a judgement call, and it is the only genuinely
deterministic property of this step. Terms that fail are dropped, not corrected.

This module holds no model calls. It defines the contract, renders the prompt, and
verifies output. The caller supplies the model.

Source text is untrusted. `build_prompt` passes it through `prompt_guard`
before it reaches a model; `verify_terms` checks the reply against the
original text.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Sequence

from . import prompt_guard
from .config import domains as configured_domains

# Bump when the prompt or schema changes in a way that should re-distil the
# corpus. Stored on every row, so a mixed-version store stays diagnosable.
# v2 adds `proposed_label` -- see labels.py for how it is arbitrated.
DISTILLER_VERSION = 2

MAX_SOURCE_CHARS = 24_000
MAX_TERMS = 24
MIN_TERM_CHARS = 2

_WHITESPACE = re.compile(r"\s+")


class DistillationError(ValueError):
    """Generated output does not satisfy the contract."""


def normalise(text: str) -> str:
    """Lowercase, collapse whitespace. Used for verbatim term checking."""
    return _WHITESPACE.sub(" ", text or "").strip().lower()


def content_hash(title: str, body: str) -> str:
    """Hash of the source a distillation was produced from.

    Stored alongside the distillation. A row whose content hash still matches is
    never re-distilled, which is what makes repeated workflow runs free.
    """
    payload = f"{title}\x1f{body}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class Distillation:
    """Validated output for one document."""

    what: str
    why: str
    terms: tuple[str, ...]
    # One domain the model proposes from the known taxonomy, or None when
    # unclear or invalid. Advisory only -- see labels.arbitrate() for how it
    # is reconciled with the rules-based `domains`. Never written directly.
    proposed_label: str | None = None

    def __post_init__(self) -> None:
        if not self.what.strip():
            raise DistillationError("`what` is empty")
        if not self.why.strip():
            raise DistillationError("`why` is empty")

    def render(self) -> str:
        """The text written to `documents.distillation` and then embedded."""
        lines = [self.what.strip(), self.why.strip()]
        if self.terms:
            lines.append("Key terms: " + ", ".join(self.terms))
        return "\n".join(lines)


def verify_terms(
    terms: Sequence[str], source_text: str
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Split terms into (verbatim, fabricated).

    Case-insensitive and whitespace-normalised, because a model reformatting
    `ACME-SOW-PH1-2026` across a line break is not a fabrication. Anything that
    still does not appear is dropped.
    """
    haystack = normalise(source_text)
    kept: list[str] = []
    rejected: list[str] = []

    for term in terms:
        candidate = (term or "").strip().strip(",;")
        if len(candidate) < MIN_TERM_CHARS:
            continue
        if candidate in kept or candidate in rejected:
            continue
        if normalise(candidate) in haystack:
            kept.append(candidate)
        else:
            rejected.append(candidate)

    return tuple(kept[:MAX_TERMS]), tuple(rejected)


def parse(payload: Any, source_text: str) -> tuple[Distillation, tuple[str, ...]]:
    """Validate one model result. Returns (distillation, rejected_terms).

    Raises DistillationError on anything structurally wrong, so a malformed
    generation fails loudly instead of writing mush into the index.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as error:
            raise DistillationError(f"output is not valid JSON: {error}") from error

    if not isinstance(payload, dict):
        raise DistillationError(f"expected an object, got {type(payload).__name__}")

    missing = [key for key in ("what", "why") if not payload.get(key)]
    if missing:
        raise DistillationError(f"missing required field(s): {missing}")

    raw_terms = payload.get("terms") or []
    if not isinstance(raw_terms, list):
        raise DistillationError("`terms` must be a list")

    kept, rejected = verify_terms([str(t) for t in raw_terms], source_text)

    raw_label = payload.get("proposed_label")
    proposed_label = str(raw_label).strip() if raw_label else None
    if proposed_label and proposed_label not in configured_domains():
        # Not a formatting problem worth failing the whole distillation over --
        # an out-of-taxonomy proposal just carries no signal, so drop it.
        proposed_label = None

    return (
        Distillation(
            what=str(payload["what"]),
            why=str(payload["why"]),
            terms=kept,
            proposed_label=proposed_label,
        ),
        rejected,
    )


PROMPT_TEMPLATE = """\
You are writing a retrieval summary for one document in a searchable knowledge \
index. It will be embedded for semantic search, and its key terms are the only \
thing keyword search can match on for documents with no extractable body text.

Return ONE JSON object, nothing else:

{{
  "what":  "One sentence. What this document IS.",
  "why":   "One or two sentences. Why it exists, what it decided or produced, \
and its current standing if stated (draft, superseded, active).",
  "terms": ["concrete", "strings", "..."],
  "proposed_label": "one domain from the list below, or null"
}}

Rules for `terms`:
- Include people, organisations, document codes, identifiers, amounts, dates, \
tickers, product names, systems.
- EVERY term MUST appear VERBATIM in the source below. Copy it exactly. Do not \
paraphrase, expand an abbreviation, or infer a term that is not written there.
- A term that does not appear in the source will be discarded automatically, so \
guessing gains nothing.
- Up to {max_terms} terms. Fewer is fine. An empty list is fine.

Rules for `what` and `why`:
- State only what the source supports. If the purpose is not stated, describe \
what the document contains rather than inventing a rationale.
- No filler openings ("This document is a..."). Lead with the substance.
- If the document is a stub, a test fixture, or otherwise carries no real \
content, say exactly that in `what`.

Rules for `proposed_label`:
- This is ADVISORY ONLY. An automated arbiter decides the final access label; \
your proposal can narrow it but can never grant access on its own.
- Propose exactly ONE domain from this list, based on what the content is \
actually about: {domains}.
- Return null if you are unsure, or if the content plainly does not belong to \
one of these domains.
- Do not propose a domain just because a name or keyword appears in passing -- \
propose the domain the document's SUBJECT belongs to.

{data_notice} The same holds for the title and location below.

--- DOCUMENT METADATA ---
Title: {title}
Source: {source}
Location: {location}
Type: {kind}

--- DOCUMENT TEXT (truncated to {max_chars} chars) ---
{body}
"""


def build_prompt(
    *,
    title: str,
    body: str,
    source: str,
    location: str = "",
    kind: str = "",
) -> str:
    """Render the distillation prompt for one document.

    Every field that comes from the source passes through `prompt_guard`:
    the body is neutralised and wrapped in delimiters made for this prompt,
    and the short fields are neutralised and kept to one line.
    """
    return PROMPT_TEMPLATE.format(
        title=prompt_guard.inline(title),
        source=prompt_guard.inline(source, 40),
        location=prompt_guard.inline(location) or "(unknown)",
        kind=prompt_guard.inline(kind, 120) or "(unspecified)",
        body=prompt_guard.wrap(body or "", max_chars=MAX_SOURCE_CHARS),
        data_notice=prompt_guard.DATA_NOTICE,
        max_terms=MAX_TERMS,
        max_chars=MAX_SOURCE_CHARS,
        domains=", ".join(configured_domains()),
    )
