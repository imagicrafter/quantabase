"""System issues for the issue log (`workspace.issues`, migration 0032).

An issue row may leave the Engine through the support view, so it must never
hold document text, a document title or a participant name. This module builds
an issue from an exception under that rule:

  * the TITLE is a fixed sentence built from the source name -- no free text;
  * the DETAIL is the first line of the exception message with everything that
    could carry content removed (see `redact`), capped at 500 characters;
  * the error class is the exception's type name.

`redact` removes more than it has to. A message that loses its meaning is
fine -- the error class and any status code survive; a leaked title is not.
The database applies a second, smaller scrub and the same cap.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from knowledge.kb_schema import db

MAX_DETAIL = 500
MAX_ERROR_CLASS = 120
RUN_FAILURE = "source_failure"
SHORT_OUTAGE_STATUSES = frozenset({502, 503, 504})

# Keys whose value is content by definition: everything after them goes.
_CONTENT_KEYS = (
    "title|name|subject|participants?|attendees?|organi[sz]er|speakers?|author|"
    "from|to|cc|file ?name|file|path|body|text|content|summary|snippet|query|page"
)

_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    # Structured payloads and bracketed asides, first opener to last closer.
    (re.compile(r"\{.*\}"), "<data>"),
    (re.compile(r"\[.*\]"), "<data>"),
    (re.compile(r"\(.*\)"), "<detail>"),
    # Anything quoted.
    (re.compile(r"\"[^\"]*\"|'[^']*'|`[^`]*`|\u201c[^\u201d]*\u201d|\u2018[^\u2019]*\u2019"), "<quoted>"),
    # Email addresses.
    (re.compile(r"[^\s<>()\"']+@[^\s<>()\"']+"), "<email>"),
    # Links: keep the scheme and host, drop path, query and fragment.
    (re.compile(r"\b([a-z][a-z0-9+.-]*://[^\s/?#]+)[^\s]*", re.IGNORECASE), r"\1"),
    # A content key and the rest of the line.
    (re.compile(rf"\b(?:{_CONTENT_KEYS})\s*[=:].*$", re.IGNORECASE), "<content>"),
    # File paths (two or more segments) and Windows drive paths.
    (re.compile(r"(?<![\w:/])~?(?:/[^\s/:]+){2,}/?"), "<path>"),
    (re.compile(r"\b[A-Za-z]:\\[^\s]+"), "<path>"),
    # Ids, hashes, keys and other long tokens.
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<id>"),
    (re.compile(r"\b[0-9a-fA-F]{16,}\b"), "<hex>"),
    (re.compile(r"[A-Za-z0-9_\-+/=.]{20,}"), "<token>"),
    # Two or more Capitalised words in a row read like a person or a title.
    (re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b"), "<name>"),
)
_SPACE = re.compile(r"\s+")
_NOT_CLASS_CHAR = re.compile(r"[^A-Za-z0-9_.]")
_STATUS_IN_TEXT = re.compile(
    r"\bHTTP[ /]?(?:Error\s+|status\s+)?(\d{3})\b|\bstatus(?:\s+code)?\s*[=:]?\s*(\d{3})\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class SystemIssue:
    """One row for `workspace.issue_upsert`."""

    category: str
    title: str
    detail: str
    source: str
    error_class: str
    dedupe_key: str


def redact(text: object, cap: int = MAX_DETAIL) -> str:
    """The first line of `text` with anything that could carry content removed."""
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return ""
    cleaned = lines[0]
    for pattern, replacement in _RULES:
        cleaned = pattern.sub(replacement, cleaned)
    return _SPACE.sub(" ", cleaned).strip()[: max(cap, 0)]


def error_class_of(error: BaseException) -> str:
    """The exception's type name, limited to identifier characters."""
    return _NOT_CLASS_CHAR.sub("", type(error).__name__)[:MAX_ERROR_CLASS] or "Exception"


def run_key(source: str) -> str:
    """The dedupe key shared by a source's failed runs and its closing proof."""
    return f"run-{source}"


def from_exception(source: str, error: BaseException) -> SystemIssue:
    """The issue for a failed run of `source`."""
    return SystemIssue(
        category=RUN_FAILURE,
        title=f"{source} run failed",
        detail=redact(error),
        source=source,
        error_class=error_class_of(error),
        dedupe_key=run_key(source),
    )


def _chain(error: BaseException, limit: int = 6) -> list[BaseException]:
    """`error` and the exceptions it was raised from, outermost first."""
    links: list[BaseException] = []
    current: BaseException | None = error
    while current is not None and current not in links and len(links) < limit:
        links.append(current)
        current = current.__cause__ or current.__context__
    return links


def _status_of(error: BaseException) -> int | None:
    """The HTTP status an exception carries, as its library exposes it."""
    candidates = (
        getattr(error, "status_code", None),
        getattr(getattr(error, "response", None), "status_code", None),
        getattr(getattr(error, "resp", None), "status", None),
        getattr(error, "status", None),
    )
    for value in candidates:
        if isinstance(value, bool):
            continue
        if isinstance(value, int) or (isinstance(value, str) and value.isdigit()):
            return int(value)
    match = _STATUS_IN_TEXT.search(str(error))
    if match:
        return int(match.group(1) or match.group(2))
    return None


def _is_timeout(error: BaseException) -> bool:
    if isinstance(error, TimeoutError):
        return True
    names = (cls.__name__ for cls in type(error).__mro__)
    return any(name.endswith(("Timeout", "TimeoutError", "TimeoutException")) for name in names)


def is_short_outage(error: BaseException) -> bool:
    """True for HTTP 502/503/504 and timeouts -- failures a later run retries.

    The first HTTP status found in the exception chain decides, so a 429 (or
    any other status) is never a short outage even when a timeout wraps it.
    """
    links = _chain(error)
    for link in links:
        status = _status_of(link)
        if status is not None:
            return status in SHORT_OUTAGE_STATUSES
    return any(_is_timeout(link) for link in links)


def upsert(sb, issue: SystemIssue) -> None:
    """Open the issue, or bump the open one with the same dedupe key."""
    db(sb).rpc(
        "issue_upsert",
        {
            "p_category": issue.category,
            "p_title": issue.title,
            "p_detail": issue.detail,
            "p_source": issue.source,
            "p_error_class": issue.error_class,
            "p_dedupe_key": issue.dedupe_key,
        },
    ).execute()


def close(sb, dedupe_key: str, proof: str) -> None:
    """Close the open issue with this key, if there is one."""
    db(sb).rpc(
        "issue_close_by_key",
        {"p_dedupe_key": dedupe_key, "p_proof": redact(proof)},
    ).execute()
