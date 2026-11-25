"""Render a Fireflies meeting as an OKF v0.1 wiki page -- pure, no I/O.

One `MeetingInput` comes from either a fresh Fireflies payload
(`MeetingInput.from_raw`) or a stored `workspace.documents` row
(`MeetingInput.from_row`), so the daily run, the self-heal sweep and the
backfill all render through the same code.

The Supabase body carries Fireflies' summary fields between explicit markers
(`render_notes_block` / `parse_notes_block`), so the notes survive after the
recording is deleted from Fireflies and a page can be re-rendered from the
row alone.

Frontmatter values are emitted with `json.dumps`: a JSON string is a valid
YAML double-quoted scalar, which avoids the quoting bugs a hand-built f-string
had with titles containing `:`, `&` or quotes.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

GENERATOR = "kb-engine puller-fireflies"
DESCRIPTION_MAX = 140
FIREFLIES_VIEW_URL = "https://app.fireflies.ai/view/{id}"

NOTES_START = "<!-- fireflies-notes -->"
NOTES_END = "<!-- /fireflies-notes -->"

# (summary key, heading in the notes block AND on the wiki page)
SUMMARY_SECTIONS: tuple[tuple[str, str], ...] = (
    ("short_summary", "Summary"),
    ("overview", "Overview"),
    ("notes", "Notes"),
    ("shorthand_bullet", "Topics"),
    ("action_items", "Action Items"),
    ("keywords", "Keywords"),
)
# Every `## ` heading the generator owns. Anything else on a page is a human's.
OWNED_HEADINGS = frozenset(
    [heading for _, heading in SUMMARY_SECTIONS] + ["Attendees", "Transcript", "Source"]
)

_TRANSCRIPT_LINE = re.compile(r"^\*\*(?P<name>[^*]+)\*\* \[\d{1,2}:\d{2}(?::\d{2})?\]: ")
_HEADING = re.compile(r"^(#{1,4}) ", re.MULTILINE)


@dataclass(frozen=True, slots=True)
class MeetingInput:
    """Everything a meeting page is rendered from."""

    fireflies_id: str
    title: str
    date_str: str
    duration_minutes: int
    external_id: str
    summary: dict[str, Any] = field(default_factory=dict)
    transcript_lines: tuple[str, ...] = ()
    speakers: tuple[str, ...] = ()
    attendee_emails: tuple[str, ...] = ()
    domain_tags: tuple[str, ...] = ()
    # Topics a NEW page may be written with (its access tag). Only set from a
    # fresh read of the source; a stored row never supplies them.
    page_topics: tuple[str, ...] = ()

    @property
    def page_name(self) -> str:
        return self.external_id

    @staticmethod
    def from_raw(
        raw: dict, *, external_id: str, domain_tags: tuple[str, ...],
        page_topics: tuple[str, ...] = (),
    ) -> "MeetingInput":
        speakers = _unique(
            (s.get("name") or "").strip() for s in raw.get("speakers") or []
        )
        emails = _unique(
            [(a.get("email") or "").strip().lower() for a in raw.get("meeting_attendees") or []]
            + [str(p).strip().lower() for p in raw.get("participants") or []]
        )
        return MeetingInput(
            fireflies_id=str(raw.get("id") or ""),
            title=(raw.get("title") or "Untitled Meeting").strip(),
            date_str=external_id[:10],
            duration_minutes=int(round(float(raw.get("duration") or 0))),
            external_id=external_id,
            summary=dict(raw.get("summary") or {}),
            transcript_lines=transcript_lines_from_sentences(raw.get("sentences") or []),
            speakers=speakers,
            attendee_emails=emails,
            domain_tags=tuple(domain_tags),
            page_topics=tuple(page_topics),
        )

    @staticmethod
    def from_row(row: dict, *, page_name: str | None = None) -> "MeetingInput":
        """A stored `workspace.documents` fireflies row -> MeetingInput."""
        body = row.get("body") or ""
        metadata = row.get("metadata") or {}
        lines, speakers = parse_transcript_lines(body)
        duration = re.search(r"\*\*Duration:\*\* (\d+(?:\.\d+)?) min", body)
        external_id = page_name or row.get("external_id") or ""
        return MeetingInput(
            fireflies_id=str(metadata.get("fireflies_id") or ""),
            title=(row.get("title") or "Untitled Meeting").strip(),
            date_str=external_id[:10],
            duration_minutes=int(round(float(duration.group(1)))) if duration else 0,
            external_id=external_id,
            summary=parse_notes_block(body),
            transcript_lines=lines,
            speakers=speakers,
            attendee_emails=(),
            domain_tags=tuple(row.get("domains") or ()),
        )


def _unique(values) -> tuple[str, ...]:
    seen: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.append(value)
    return tuple(seen)


def format_timestamp(seconds: float | None) -> str:
    """Fireflies `start_time` is SECONDS (float) -> `mm:ss` or `h:mm:ss`."""
    if seconds is None:
        return "00:00"
    total = int(float(seconds))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


def transcript_lines_from_sentences(sentences: list[dict]) -> tuple[str, ...]:
    return tuple(
        f"**{s.get('speaker_name') or 'Unknown'}** [{format_timestamp(s.get('start_time'))}]: "
        f"{s.get('text') or ''}"
        for s in sentences
    )


def parse_transcript_lines(body: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Speaker-attributed lines from a stored body, plus unique speakers in order."""
    lines = tuple(line for line in body.splitlines() if _TRANSCRIPT_LINE.match(line))
    speakers = _unique(_TRANSCRIPT_LINE.match(line).group("name").strip() for line in lines)
    return lines, speakers


def _keywords_text(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(v).strip() for v in value if str(v).strip())
    return str(value or "").strip()


def _section_text(key: str, summary: dict[str, Any]) -> str:
    value = summary.get(key)
    if key == "keywords":
        return _keywords_text(value)
    return str(value or "").strip()


def demote_headings(text: str, levels: int = 2) -> str:
    """Push markdown headings down so Fireflies' `## **X**` nests under our `## Notes`."""
    return _HEADING.sub(lambda m: "#" * min(6, len(m.group(1)) + levels) + " ", text)


def render_notes_block(summary: dict[str, Any]) -> str:
    """Fireflies summary fields for the Supabase body. Empty block if nothing to keep."""
    parts = [NOTES_START, "## Fireflies Notes", ""]
    for key, heading in SUMMARY_SECTIONS:
        text = _section_text(key, summary)
        if text:
            parts += [f"### {heading}", "", demote_headings(text, 2), ""]
    parts.append(NOTES_END)
    return "\n".join(parts)


def parse_notes_block(body: str) -> dict[str, Any]:
    """Inverse of `render_notes_block`. {} when the body predates the block."""
    start = body.find(NOTES_START)
    end = body.find(NOTES_END)
    if start < 0 or end < start:
        return {}
    block = body[start + len(NOTES_START):end]
    by_heading = {heading: key for key, heading in SUMMARY_SECTIONS}
    result: dict[str, Any] = {}
    current: str | None = None
    buffer: list[str] = []

    def _flush() -> None:
        if current is None:
            return
        text = "\n".join(buffer).strip()
        text = re.sub(r"^(#{3,6}) ", lambda m: "#" * (len(m.group(1)) - 2) + " ", text, flags=re.MULTILINE)
        if text:
            result[current] = [k.strip() for k in text.split(",")] if current == "keywords" else text

    for line in block.splitlines():
        match = re.match(r"^### (.+?)\s*$", line)
        if match and match.group(1) in by_heading:
            _flush()
            current, buffer = by_heading[match.group(1)], []
        elif current is not None:
            buffer.append(line)
    _flush()
    return result


def has_notes(body: str) -> bool:
    return bool(parse_notes_block(body))


def headings(page: str) -> list[str]:
    """The page's `## ` headings in order (frontmatter excluded)."""
    text = page.split("\n---\n", 1)[1] if page.startswith("---\n") else page
    return [m.group(1).strip() for m in re.finditer(r"^## (.+)$", text, re.MULTILINE)]


def _yaml_list(values) -> str:
    return "[" + ", ".join(json.dumps(v, ensure_ascii=False) for v in values) + "]"


def _description(summary: dict[str, Any], title: str) -> str:
    text = (
        _section_text("gist", summary)
        or _section_text("short_summary", summary)
        or f"Meeting: {title}"
    )
    text = " ".join(text.split())
    return text if len(text) <= DESCRIPTION_MAX else text[: DESCRIPTION_MAX - 1].rstrip() + "…"


def render_meeting_page(
    inp: MeetingInput,
    *,
    attendees: tuple[tuple[str, str | None], ...],
    related: tuple[str, ...],
    today: date,
    created: str | None = None,
    extra_sections: str = "",
    topics: tuple[str, ...] = (),
    topics_key: str = "domains",
) -> str:
    """The full page text. `extra_sections` (human-owned `## ` sections) go before Source.

    `topics` is written under `topics_key` -- the page's tag, which decides who
    can see the meeting from then on. Nothing is written when it is empty.
    """
    today_str = today.isoformat()
    tags = _unique(["meeting", *inp.domain_tags])
    frontmatter = [
        "---",
        f"title: {json.dumps(inp.title, ensure_ascii=False)}",
        "aliases:",
        f"  - {json.dumps(inp.title, ensure_ascii=False)}",
        *([f"  - {json.dumps(inp.fireflies_id)}"] if inp.fireflies_id else []),
        "type: meeting",
        f"date: {inp.date_str}",
        f"created: {created if created and re.fullmatch(r'\d{4}-\d{2}-\d{2}', created) else today_str}",
        f"updated: {today_str}",
        f"timestamp: {inp.date_str}T00:00:00Z",
        f"tags: {_yaml_list(tags)}",
        *([f"{topics_key}: {_yaml_list(topics)}"] if topics else []),
        f"related: {_yaml_list(related)}",
        f"description: {json.dumps(_description(inp.summary, inp.title), ensure_ascii=False)}",
        f"sources: {_yaml_list([f'fireflies-{inp.fireflies_id}'] if inp.fireflies_id else [])}",
        "generated:",
        f"  by: {json.dumps(GENERATOR)}",
        f"  at: {today_str}",
        "verified: []",
        "status: draft",
        f"fireflies_id: {json.dumps(inp.fireflies_id)}",
        f"duration_minutes: {inp.duration_minutes}",
        f"attendees: {_yaml_list([display for display, _ in attendees])}",
        "---",
        "",
    ]

    body: list[str] = []
    for key, heading in SUMMARY_SECTIONS:
        text = _section_text(key, inp.summary)
        if text:
            body += [f"## {heading}", "", demote_headings(text, 2), ""]

    body += ["## Attendees", ""]
    body += [f"- {link or display}" for display, link in attendees] or ["- (not recorded)"]
    body.append("")

    body += ["## Transcript", ""]
    body += list(inp.transcript_lines) or ["(no transcript stored)"]
    body.append("")

    if extra_sections.strip():
        body += [extra_sections.strip(), ""]

    source = ["## Source", ""]
    if inp.fireflies_id:
        source.append(f"Fireflies: {FIREFLIES_VIEW_URL.format(id=inp.fireflies_id)}")
    source.append(f"Generated by {GENERATOR} on {today_str}.")
    body += source

    return "\n".join(frontmatter + body).rstrip() + "\n"


def today_utc() -> date:
    return datetime.now(timezone.utc).date()
