"""One open issue per source while any of its documents carries an unknown tag.

A tag that names a topic the config does not declare leaves its document in
`unclassified` (owner-only). That is safe, but nobody sees it happen. After
each run the runner calls `report`, which:

  * counts the source's live documents whose `tag_signals` hold `unknown_tag`
    (read from the database, so an incremental run still sees older ones);
  * opens or bumps ONE issue keyed `unknown-tag-<source>` when there are any;
  * closes that issue when there are none.

What the issue holds: a count, and up to `MAX_TAGS` of the unknown topic
texts, each cut to `MAX_TAG_CHARS` and reduced to tag characters. A tag text
names a topic that does not exist, so it is not private. No document title,
id or body is ever put in the issue.

`report` never raises: a problem here must not fail a run that was clean.
"""

from __future__ import annotations

import re
import sys
from typing import Any, Callable, Iterable, Sequence

from knowledge import issues
from knowledge.kb_schema import db
from knowledge.tag_resolver import UNKNOWN_TAG

CATEGORY = "unknown_tag"
MAX_TAGS = 5
MAX_TAG_CHARS = 40
PAGE_SIZE = 1000
_NOT_TAG_CHAR = re.compile(r"[^a-z0-9_/-]")
_DETAIL_PREFIX = f"{UNKNOWN_TAG}:"

Reader = Callable[[str, Any], Sequence[Sequence[str]]]


def issue_key(source: str) -> str:
    return f"unknown-tag-{source}"


def read_signals(source: str, sb: Any) -> list[tuple[str, ...]]:
    """`tag_signals` of every live document of `source` with an unknown tag."""
    response = (
        db(sb)
        .table("documents")
        .select("tag_signals")
        .eq("source", source)
        .is_("deleted_at", "null")
        .contains("tag_signals", [UNKNOWN_TAG])
        .limit(PAGE_SIZE)
        .execute()
    )
    return [tuple(row.get("tag_signals") or ()) for row in (response.data or [])]


def _clean(text: str) -> str:
    return _NOT_TAG_CHAR.sub("", text.lower())[:MAX_TAG_CHARS]


def unknown_tags(signal_sets: Iterable[Sequence[str]]) -> tuple[str, ...]:
    """The distinct unknown topic texts, cleaned, in name order."""
    found = {
        _clean(signal[len(_DETAIL_PREFIX):])
        for signals in signal_sets
        for signal in signals
        if isinstance(signal, str) and signal.startswith(_DETAIL_PREFIX)
    }
    return tuple(sorted(tag for tag in found if tag))


def build_issue(source: str, signal_sets: Sequence[Sequence[str]]) -> issues.SystemIssue:
    """The issue for `source`: a count and a capped list of tag texts."""
    count = len(signal_sets)
    tags = unknown_tags(signal_sets)
    shown = ", ".join(tags[:MAX_TAGS])
    more = f" and {len(tags) - MAX_TAGS} more" if len(tags) > MAX_TAGS else ""
    at_least = "at least " if count >= PAGE_SIZE else ""
    detail = f"{at_least}{count} item(s) carry a tag that names no topic"
    return issues.SystemIssue(
        category=CATEGORY,
        title=f"{source} has items with an unknown tag",
        detail=f"{detail}: {shown}{more}" if shown else detail,
        source=source,
        error_class="",
        dedupe_key=issue_key(source),
    )


def report(source: str, *, sb: Any, read: Reader = read_signals) -> str:
    """Open, bump or close the source's unknown-tag issue.

    Returns `opened`, `closed` or `failed`.
    """
    try:
        signal_sets = [tuple(signals) for signals in read(source, sb)]
        if signal_sets:
            issues.upsert(sb, build_issue(source, signal_sets))
            return "opened"
        issues.close(sb, issue_key(source), "no item carries an unknown tag")
        return "closed"
    except Exception as error:  # noqa: BLE001 -- never fail a clean run
        print(
            f"[runner:{source}] WARNING could not update the unknown-tag issue: "
            f"{type(error).__name__}",
            file=sys.stderr,
        )
        return "failed"
