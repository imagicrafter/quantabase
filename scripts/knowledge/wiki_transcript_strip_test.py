#!/usr/bin/env python3
"""Meeting pages are indexed WITHOUT their `## Transcript` section.

    python -m knowledge.wiki_transcript_strip_test   (from scripts/)

The transcript is searchable as the `fireflies` row; the wiki copy must not
become a second set of rows.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.connectors.wiki import _page_to_documents, strip_transcript  # noqa: E402

PAGE = """---
title: "Build Session"
type: meeting
date: 2026-10-06
---

## Notes

The SOW is $20,000.

## Transcript

**Sam Rivera** [00:01]: unique-transcript-phrase
**Pat Owner** [00:02]: another line

## Source

Fireflies: https://app.fireflies.ai/view/abc
"""


def test_strip_keeps_other_sections() -> None:
    out = strip_transcript(PAGE.split("---\n", 2)[2])
    assert "unique-transcript-phrase" not in out
    assert "## Notes" in out and "## Source" in out


def test_transcript_at_end_of_page() -> None:
    assert strip_transcript("## Notes\n\nx\n\n## Transcript\n\n**A** [00:01]: y") == "## Notes\n\nx"


def test_meeting_page_documents_exclude_transcript() -> None:
    root = Path(tempfile.mkdtemp())
    path = root / "meetings" / "2026-10-06-build-session.md"
    path.parent.mkdir(parents=True)
    path.write_text(PAGE, encoding="utf-8")
    result = _page_to_documents(path, root)
    assert result is not None
    documents, _audit = result
    assert documents
    assert all("unique-transcript-phrase" not in doc.body for doc in documents)
    assert any("$20,000" in doc.body for doc in documents)


TESTS = [
    test_strip_keeps_other_sections,
    test_transcript_at_end_of_page,
    test_meeting_page_documents_exclude_transcript,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
