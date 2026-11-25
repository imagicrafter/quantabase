"""`kbe tags suggest` -- have the model propose a topic for untagged items.

It only writes a CSV for a person to read and edit. It never writes to a
source and never to the database. The model may only answer with a topic the
config declares, and never a sensitive one: a sensitive topic is a person's
call, made by editing the file.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from knowledge import prompt_guard
from knowledge.engine_config import UNCLASSIFIED

CSV_COLUMNS = ("source", "external_id", "title", "current", "proposed", "reason")
BODY_COLUMNS = "source, external_id, title, body, domains, tag_source, tag_signals"
EXCERPT_CHARS = 2000
REASON_MAX = 200
DEFAULT_LIMIT = 50

SYSTEM_PROMPT = (
    "You sort documents into topics for an access-controlled knowledge index. "
    "You return ONLY a single JSON object, no markdown and no prose: "
    '{"topic": "<one topic id from the list, or null>", "reason": "<one short sentence>"}. '
    "Choose a topic only from the list you are given. If none clearly fits, "
    "answer null. Never invent a topic."
)

Ask = Callable[[str], Mapping[str, Any]]


class TagSuggestError(RuntimeError):
    """Suggestions could not be produced."""


@dataclass(frozen=True, slots=True)
class Proposal:
    source: str
    external_id: str
    title: str
    current: str
    proposed: str
    reason: str

    def as_row(self) -> dict[str, str]:
        return {column: _cell(getattr(self, column)) for column in CSV_COLUMNS}


def allowed_topics(config: Any) -> tuple[tuple[str, str], ...]:
    """(id, label) of every topic the model may propose: declared, not sensitive."""
    sensitive = config.sensitive_domain_ids
    return tuple(
        (domain.id, domain.label)
        for domain in config.domains
        if domain.id not in sensitive and domain.id != UNCLASSIFIED
    )


def build_prompt(title: str, body: str, topics: Sequence[tuple[str, str]]) -> str:
    listing = "\n".join(f"- {topic_id}: {label}" for topic_id, label in topics)
    # The title and text are written by other people: they are data, wrapped
    # and neutralised before they reach the model (knowledge.prompt_guard).
    return (
        f"Topics:\n{listing}\n\n"
        f"{prompt_guard.DATA_NOTICE}\n\n"
        f"Document title: {prompt_guard.inline(title)}\n\n"
        f"Document text (start):\n{prompt_guard.wrap(body or '', max_chars=EXCERPT_CHARS)}\n\n"
        "Which one topic does this document belong to?"
    )


def _one_line(text: Any) -> str:
    return " ".join(str(text or "").split())[:REASON_MAX]


def _cell(value: str) -> str:
    """Keep a spreadsheet from running a cell that starts like a formula."""
    return f"'{value}" if value[:1] in ("=", "+", "-", "@") else value


def read_reply(reply: Any, allowed: frozenset[str]) -> tuple[str, str]:
    """(proposed topic or "", reason). Anything outside `allowed` is dropped."""
    if not isinstance(reply, Mapping):
        return "", "the model did not answer with an object"
    topic = reply.get("topic")
    reason = _one_line(reply.get("reason"))
    if topic is None or not str(topic).strip():
        return "", reason or "no topic clearly fits"
    cleaned = str(topic).strip().lower()
    if cleaned not in allowed:
        return "", f"the model answered {_one_line(cleaned)!r}, which it may not propose"
    return cleaned, reason


def _propose(row: Mapping[str, Any], topics, allowed: frozenset[str], ask: Ask) -> Proposal:
    title = str(row.get("title") or "")
    try:
        proposed, reason = read_reply(ask(build_prompt(title, row.get("body") or "", topics)), allowed)
    except Exception as error:  # noqa: BLE001 - one failed call must not end the batch
        proposed, reason = "", f"model call failed: {type(error).__name__}"
    return Proposal(
        source=str(row.get("source") or ""),
        external_id=str(row.get("external_id") or ""),
        title=title,
        current=",".join(row.get("domains") or ()),
        proposed=proposed,
        reason=reason,
    )


def suggest(rows: Sequence[Mapping[str, Any]], config: Any, ask: Ask) -> list[Proposal]:
    """One proposal per row. `rows` are the untagged items to look at."""
    topics = allowed_topics(config)
    if not topics:
        raise TagSuggestError(
            "The config declares no topic the model may propose (every topic is sensitive)."
        )
    allowed = frozenset(topic_id for topic_id, _label in topics)
    return [_propose(row, topics, allowed, ask) for row in rows]


def write_csv(proposals: Sequence[Proposal], path: Path) -> Path:
    """Write the proposals file. Refuses to replace an existing file."""
    target = Path(path)
    if target.exists():
        raise TagSuggestError(f"{target} already exists; choose another --out")
    try:
        with target.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
            writer.writeheader()
            writer.writerows(proposal.as_row() for proposal in proposals)
    except OSError as error:
        raise TagSuggestError(f"could not write {target}: {error}") from error
    return target
