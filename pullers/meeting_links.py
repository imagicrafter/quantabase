"""Resolve a meeting's attendees and `related` pages against the knowledge wiki.

Two layers:

1. **People (deterministic).** Speaker names, attendee display names and
   participant emails are matched EXACTLY (normalised: lowercase, punctuation
   stripped) against each `people/*.md` title, its `aliases`, and an optional
   `email` field. No substring or first-name matching -- that is what made the
   old `fireflies_ingest.py` matcher both miss real people and risk linking
   a first name to the wrong person's page.
2. **Everything else (LLM, closed list).** The model picks up to
   MAX_LLM_PICKS titles from the wiki's existing project / people / concept
   pages. Every returned title is checked against that list; anything else is
   dropped, so the model can never invent a page. If the call fails, the page
   still gets the people links plus the project pages those people's own
   `related` lists point at (e.g. a person's page -> their company's page).

The owner is left out of a meeting's people links -- they are in every meeting.
Who the owner is comes from the Engine config: `engine.owner.names` and
`engine.owner.emails`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from knowledge import prompt_guard
from knowledge.engine_config import get_config
from knowledge.frontmatter import as_list, parse as parse_frontmatter

INDEX_DIRS = ("people", "projects", "concepts")
MAX_LLM_PICKS = 8
MAX_RELATED = 12
_LINK = re.compile(r"\[\[([^\]|#]+)")


@dataclass(frozen=True, slots=True)
class WikiPage:
    title: str
    directory: str
    aliases: tuple[str, ...] = ()
    emails: tuple[str, ...] = ()
    related: tuple[str, ...] = ()
    description: str = ""


@dataclass(frozen=True, slots=True)
class WikiIndex:
    pages: tuple[WikiPage, ...] = ()
    by_title: dict[str, WikiPage] = field(default_factory=dict)

    def titles(self) -> tuple[str, ...]:
        return tuple(page.title for page in self.pages)

    def catalog(self) -> str:
        """One line per page for the model: `- Title (dir) -- description`."""
        return "\n".join(
            f"- {p.title} ({p.directory})" + (f" -- {p.description}" if p.description else "")
            for p in self.pages
        )


@dataclass(frozen=True, slots=True)
class MeetingLinks:
    attendees: tuple[tuple[str, str | None], ...]  # (display, "[[Title]]" or None)
    related: tuple[str, ...]                       # "[[Title]]" strings
    llm_used: bool = False


def normalise(name: str) -> str:
    """Lowercase, drop "(company)"-style suffixes and punctuation."""
    name = re.sub(r"\([^)]*\)", " ", (name or "").lower())
    return " ".join(re.sub(r"[^a-z0-9@.\s]", " ", name).split())


def self_names() -> frozenset[str]:
    """The owner's names (engine.owner.names in the config), normalised."""
    return frozenset(normalise(name) for name in get_config().owner.names)


def self_emails() -> frozenset[str]:
    """Every address that is the owner (engine.owner.email + .emails)."""
    return get_config().owner_emails


def is_self(name: str) -> bool:
    """True when `name` is one of the owner's own names."""
    return normalise(name) in self_names()


def build_index(root: Path) -> WikiIndex:
    pages: list[WikiPage] = []
    for directory in INDEX_DIRS:
        folder = root / directory
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.md")):
            try:
                parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError):
                continue
            fm = parsed.frontmatter
            title = str(fm.get("title") or path.stem).strip()
            related = tuple(
                m.group(1).strip() for item in as_list(fm.get("related")) for m in _LINK.finditer(item)
            )
            pages.append(WikiPage(
                title=title,
                directory=directory,
                aliases=tuple(a.strip() for a in as_list(fm.get("aliases")) if a.strip()),
                emails=tuple(e.strip().lower() for e in as_list(fm.get("email")) if e.strip()),
                related=related,
                description=" ".join(str(fm.get("description") or "").split())[:160],
            ))
    return WikiIndex(pages=tuple(pages), by_title={p.title: p for p in pages})


def _people_lookup(index: WikiIndex) -> tuple[dict[str, WikiPage], dict[str, WikiPage]]:
    by_name: dict[str, WikiPage] = {}
    by_email: dict[str, WikiPage] = {}
    for page in index.pages:
        if page.directory != "people":
            continue
        for name in (page.title, *page.aliases):
            by_name.setdefault(normalise(name), page)
        for email in page.emails:
            by_email.setdefault(email, page)
    return by_name, by_email


def resolve_attendees(
    speakers: tuple[str, ...], emails: tuple[str, ...], index: WikiIndex
) -> tuple[tuple[str, str | None], ...]:
    """Each attendee once, as (display, link-or-None). Emails only add people
    a speaker name did not already cover."""
    by_name, by_email = _people_lookup(index)
    seen: set[str] = set()
    result: list[tuple[str, str | None]] = []

    for name in speakers:
        key = normalise(name)
        if not key or key in seen:
            continue
        seen.add(key)
        page = by_name.get(key)
        result.append((name, f"[[{page.title}]]" if page else None))

    for email in emails:
        email = email.lower()
        if not email or email in self_emails():
            continue
        page = by_email.get(email)
        if page and normalise(page.title) not in seen:
            seen.add(normalise(page.title))
            result.append((page.title, f"[[{page.title}]]"))
    return tuple(result)


MAX_SUMMARY_CHARS = 3000


def _llm_prompt(title: str, summary_text: str, people: list[str], catalog: str) -> str:
    return (
        "You link a meeting to pages in a knowledge wiki.\n"
        f"Pick at most {MAX_LLM_PICKS} page titles from CANDIDATES. In this order of priority:\n"
        "1. The client or partner ORGANIZATION page(s) the meeting is for (always include these).\n"
        "2. The specific project or phase page being worked on.\n"
        "3. People discussed who are not attendees.\n"
        "4. At most two concept pages, only if the meeting is substantially about them.\n"
        "Use exact titles from the list only. Prefer fewer, more certain links.\n"
        'Reply with JSON only: {"related": ["Title", ...]}\n'
        f"{prompt_guard.DATA_NOTICE} The same holds for the meeting title.\n\n"
        f"MEETING TITLE: {prompt_guard.inline(title)}\n"
        f"ATTENDEES WITH PAGES: {', '.join(people) or 'none'}\n"
        f"SUMMARY:\n{prompt_guard.wrap(summary_text, max_chars=MAX_SUMMARY_CHARS)}\n\n"
        f"CANDIDATES:\n{catalog}"
    )


def default_llm(prompt: str) -> str:
    """One call through the same backend the distiller uses. Raises on failure."""
    from knowledge.model_backends import call_model
    from knowledge.model_client import resolve_backend

    backend, model = resolve_backend()
    reply = call_model(prompt, backend=backend, model=model, timeout_s=60.0)
    if reply.error:
        raise RuntimeError(f"related-pages model call failed: {reply.error}")
    return reply.text


def parse_llm_titles(text: str, valid: set[str]) -> list[str]:
    """Titles from the model reply that are REAL pages. Unknown titles are dropped."""
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        return []
    try:
        picked = json.loads(match.group(0)).get("related") or []
    except (json.JSONDecodeError, AttributeError):
        return []
    out: list[str] = []
    for title in picked:
        title = str(title).strip().removeprefix("[[").removesuffix("]]")
        title = re.sub(r"\s+\((people|projects|concepts)\)$", "", title)  # echoed catalog tag
        if title in valid and title not in out:
            out.append(title)
    return out[:MAX_LLM_PICKS]


def build_links(
    *,
    title: str,
    summary_text: str,
    speakers: tuple[str, ...],
    emails: tuple[str, ...],
    index: WikiIndex,
    llm: Callable[[str], str] | None = default_llm,
) -> MeetingLinks:
    attendees = resolve_attendees(speakers, emails, index)
    people = [
        link[2:-2] for display, link in attendees
        if link and not is_self(display) and not is_self(link[2:-2])
    ]

    picked: list[str] = []
    llm_used = False
    if llm is not None:
        try:
            raw = llm(_llm_prompt(title, summary_text, people, index.catalog()))
            picked = parse_llm_titles(raw, set(index.titles()))
            llm_used = True
        except Exception:  # noqa: BLE001 -- fall back to deterministic links
            picked = []

    haystack = f" {title} {summary_text} ".lower()
    mentioned = [
        page.title for page in index.pages
        if page.directory != "people" and len(page.title) >= 8
        and re.search(rf"(?<![a-z0-9]){re.escape(page.title.lower())}(?![a-z0-9])", haystack)
    ]

    if not llm_used:
        for person in people:
            page = index.by_title.get(person)
            for target in page.related if page else ():
                target_page = index.by_title.get(target)
                if target_page and target_page.directory == "projects":
                    picked.append(target)

    ordered: list[str] = []
    for title_ in [*people, *mentioned, *picked]:
        if title_ not in ordered and not is_self(title_):
            ordered.append(title_)
    return MeetingLinks(
        attendees=attendees,
        related=tuple(f"[[{t}]]" for t in ordered[:MAX_RELATED]),
        llm_used=llm_used,
    )
