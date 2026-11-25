#!/usr/bin/env python3
"""`fireflies_retention` deletes ONLY meetings whose notes and page are saved.

    python -m pullers.fireflies_retention_test

Fake Supabase + fake delete -- never touches Fireflies.
"""

from __future__ import annotations

import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.fireflies_retention import NOT_FOUND, compare_live, gate, run, settings  # noqa: E402
from pullers.meeting_page import render_notes_block  # noqa: E402

NOW = datetime(2026, 10, 15, tzinfo=timezone.utc)
NOTES_BODY = "# Transcript: x\n\n" + render_notes_block({"overview": "o"}) + "\n\n---\n\n**A** [00:01]: hi"


class _Query:
    def __init__(self, store, table):
        self.store, self.table, self.filters, self.payload = store, table, {}, None

    def select(self, *_a): return self
    def eq(self, k, v): self.filters[k] = v; return self
    def is_(self, *_a): return self
    def lt(self, k, v): self.filters["lt"] = v; return self
    def order(self, *_a): return self
    def range(self, *_a): return self
    def limit(self, *_a): return self
    def update(self, payload): self.payload = payload; return self

    def execute(self):
        class R:
            pass
        r = R()
        if self.payload is not None:
            self.store.updates.append((self.filters.get("external_id"), self.payload))
            r.data = []
        else:
            r.data = [row for row in self.store.rows if row["source_created_at"] < self.filters["lt"]]
        return r


class FakeSb:
    def __init__(self, rows):
        self.rows, self.updates = rows, []

    def schema(self, _s): return self
    def table(self, name): return _Query(self, name)


def _row(external_id, *, age_date="2026-06-01", body=NOTES_BODY, **meta):
    metadata = {"fireflies_id": f"ff-{external_id}", "wiki_page_id": f"meetings/{external_id}", **meta}
    return {"external_id": external_id, "body": body, "metadata": metadata,
            "source_created_at": f"{age_date}T00:00:00+00:00"}


def _exists(*names):
    pages = {f"meetings/{n}" for n in names}
    return lambda page_id: page_id in pages


def _bronze_ok(_sb, _eid):
    return NOTES_BODY


def _live_ok(_fid, _rows):
    return None


def _run(sb, names, **kwargs):
    kwargs.setdefault("bronze", _bronze_ok)
    kwargs.setdefault("live_check", _live_ok)
    return run(sb, page_exists=_exists(*names), now=NOW, **kwargs)


def test_each_gate_blocks_alone() -> None:
    ok = _exists("a.md")
    assert gate(_row("a.md"), ok, NOTES_BODY) is None
    assert gate(_row("a.md", body="no notes"), ok, NOTES_BODY) == "notes not saved in Supabase"
    assert gate(_row("a.md", wiki_page_id=None), ok, NOTES_BODY) == "no wiki_page_id"
    assert "not on origin/main" in gate(_row("b.md"), ok, NOTES_BODY)
    assert gate(_row("a.md"), ok, None) == "no bronze capture"
    assert gate(_row("a.md"), ok, "old body") == "notes not saved in bronze"
    assert gate(_row("a.md", fireflies_id=None), ok, NOTES_BODY) == "no fireflies_id"


def test_notes_unavailable_flag_passes_gate() -> None:
    assert gate(_row("a.md", body="x", fireflies_notes_unavailable=True), _exists("a.md"), "x") is None


def test_transcript_unavailable_blocks_delete() -> None:
    assert gate(_row("a.md", fireflies_transcript_unavailable=True), _exists("a.md"), NOTES_BODY) == "no transcript stored"


def test_late_fireflies_notes_block_delete() -> None:
    """Notes Fireflies finished AFTER ingest must stop the delete."""
    row = _row("a.md", body="x", fireflies_notes_unavailable=True)
    sb = FakeSb([row])
    deleted = []
    live = lambda _fid, rows: compare_live({"notes": "written later", "keywords": []}, rows)
    receipt = _run(sb, ["a.md"], delete=deleted.append, live_check=live, bronze=lambda *_: "x")
    assert deleted == []
    assert any("notes not saved" in reason for _, reason in receipt.skipped)


def test_compare_live_partial_summary() -> None:
    stored = ({"body": "# T\n\n" + render_notes_block({"keywords": ["k"]})},)
    assert compare_live({"keywords": ["k"], "notes": ""}, stored) is None
    assert "notes" in compare_live({"keywords": ["k"], "notes": "late"}, stored)


def test_not_found_marks_without_deleting() -> None:
    sb = FakeSb([_row("a.md")])
    deleted = []
    _run(sb, ["a.md"], delete=deleted.append, live_check=lambda *_: NOT_FOUND)
    assert deleted == [] and sb.updates and sb.updates[0][1]["metadata"]["fireflies_deleted_at"]


def test_recent_meetings_kept() -> None:
    sb = FakeSb([_row("new.md", age_date="2026-07-20")])
    deleted = []
    receipt = _run(sb, ["new.md"], days=90, delete=deleted.append)
    assert deleted == [] and receipt.eligible == []


def test_cap_limits_deletes() -> None:
    names = [f"m{i}.md" for i in range(30)]
    sb = FakeSb([_row(n) for n in names])
    deleted = []
    receipt = _run(sb, names, cap=25, delete=deleted.append)
    assert len(deleted) == 25 and len(receipt.eligible) == 30
    assert all("fireflies_deleted_at" in payload["metadata"] for _, payload in sb.updates)


def test_shared_recording_marks_every_row() -> None:
    sb = FakeSb([_row("a.md", fireflies_id="same"), _row("b.md", fireflies_id="same")])
    deleted = []
    receipt = _run(sb, ["a.md", "b.md"], delete=deleted.append)
    assert deleted == ["same"] and sorted(receipt.deleted) == ["a.md", "b.md"]
    assert sorted(eid for eid, _ in sb.updates) == ["a.md", "b.md"]


def test_dry_run_never_deletes() -> None:
    sb = FakeSb([_row("a.md")])
    deleted = []
    receipt = _run(sb, ["a.md"], dry_run=True, delete=deleted.append)
    assert deleted == [] and receipt.eligible == ["a.md"] and not sb.updates


def test_delete_error_recorded_and_run_continues() -> None:
    sb = FakeSb([_row("a.md"), _row("b.md")])

    def flaky(fid):
        if fid == "ff-a.md":
            raise RuntimeError("429")

    receipt = _run(sb, ["a.md", "b.md"], delete=flaky)
    assert receipt.deleted == ["b.md"] and receipt.errors[0][0] == "a.md"


def test_settings_default_off_and_bad_days() -> None:
    assert settings({}) == (False, False, 90)
    assert settings({"FIREFLIES_RETENTION_ENABLED": "true", "FIREFLIES_RETENTION_DAYS": "7"}) == (True, False, 30)
    assert settings({"FIREFLIES_RETENTION_DAYS": "ninety"}) == (False, False, 90)


TESTS = [
    test_each_gate_blocks_alone,
    test_notes_unavailable_flag_passes_gate,
    test_transcript_unavailable_blocks_delete,
    test_late_fireflies_notes_block_delete,
    test_compare_live_partial_summary,
    test_not_found_marks_without_deleting,
    test_recent_meetings_kept,
    test_cap_limits_deletes,
    test_shared_recording_marks_every_row,
    test_dry_run_never_deletes,
    test_delete_error_recorded_and_run_continues,
    test_settings_default_off_and_bad_days,
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
