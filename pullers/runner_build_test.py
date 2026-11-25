#!/usr/bin/env python3
"""`runner.build_documents` skips, keeps alignment, and fails loudly on abuse.

    python -m pullers.runner_build_test

No network: a fake puller stands in for a real one. `dotenv` is stubbed so
importing `runner` (which imports `fireflies`) works wherever python-dotenv is
not installed.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

if "dotenv" not in sys.modules:
    _stub = types.ModuleType("dotenv")
    _stub.dotenv_values = lambda *_a, **_k: {}
    sys.modules["dotenv"] = _stub

from pullers import runner  # noqa: E402
from pullers.base import SkipPayload  # noqa: E402


def _puller(*, full_sync: bool = False):
    """A raw is `{"doc": marker}` (converts) or `{"bad": reason}` (skips)."""
    def to_document(raw):
        if raw.get("bad"):
            raise SkipPayload(None, raw["bad"])
        return raw["doc"]

    return types.SimpleNamespace(SOURCE="fake", FULL_SYNC=full_sync, to_document=to_document)


def test_skip_keeps_alignment() -> None:
    doc_a, doc_b = object(), object()
    raws = [{"doc": doc_a}, {"bad": "bad 1"}, {"doc": doc_b}]
    kept, documents, skipped = runner.build_documents(_puller(), raws)
    assert kept == [{"doc": doc_a}, {"doc": doc_b}]
    assert documents == [doc_a, doc_b]
    assert skipped == [{"index": 1, "external_id": None, "reason": "bad 1"}]


def test_all_good_no_skips() -> None:
    doc_a, doc_b = object(), object()
    kept, documents, skipped = runner.build_documents(_puller(), [{"doc": doc_a}, {"doc": doc_b}])
    assert kept == [{"doc": doc_a}, {"doc": doc_b}]
    assert documents == [doc_a, doc_b]
    assert skipped == []


def test_other_errors_propagate() -> None:
    def to_document(_raw):
        raise ValueError("boom")

    puller = types.SimpleNamespace(SOURCE="fake", FULL_SYNC=False, to_document=to_document)
    try:
        runner.build_documents(puller, [{"doc": object()}])
    except ValueError:
        return
    raise AssertionError("expected ValueError to propagate")


def test_full_sync_skip_fails() -> None:
    try:
        runner.build_documents(_puller(full_sync=True), [{"bad": "bad 0"}])
    except runner.RunnerError:
        return
    raise AssertionError("expected RunnerError for a skip in a full-sync source")


def test_too_many_skips_fails() -> None:
    cap = runner.MAX_SKIPPED_PER_RUN
    over = [{"bad": f"bad {i}"} for i in range(cap + 1)]
    try:
        runner.build_documents(_puller(), over)
    except runner.RunnerError:
        pass
    else:
        raise AssertionError(f"expected RunnerError for more than {cap} skips")

    exact = [{"bad": f"bad {i}"} for i in range(cap)]
    kept, documents, skipped = runner.build_documents(_puller(), exact)
    assert kept == [] and documents == [] and len(skipped) == cap


def test_skip_warning_text() -> None:
    assert runner.success_warning({}, []) is None
    one = runner.success_warning({}, [{"index": 0, "reason": "bad 1"}])
    assert one == "warning: skipped 1: bad 1"
    both = runner.success_warning({"wiki_error": "push rejected"}, [{"index": 0, "reason": "bad 1"}])
    assert both.startswith("warning:") and "wiki" in both and "skipped" in both


def test_skip_warning_all_reasons() -> None:
    skips = [{"index": i, "reason": f"bad {i}"} for i in range(3)]
    warn = runner.success_warning({}, skips)
    assert warn is not None and "bad 0" in warn and "bad 1" in warn and "bad 2" in warn


def test_skip_warning_wiki_only() -> None:
    warn = runner.success_warning({"wiki_error": "push rejected"}, [])
    assert warn == "warning: wiki push rejected"


TESTS = [
    test_skip_keeps_alignment,
    test_all_good_no_skips,
    test_other_errors_propagate,
    test_full_sync_skip_fails,
    test_too_many_skips_fails,
    test_skip_warning_text,
    test_skip_warning_all_reasons,
    test_skip_warning_wiki_only,
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
