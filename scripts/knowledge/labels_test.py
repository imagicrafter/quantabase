#!/usr/bin/env python3
"""Unit tests for the four `arbitrate()` branches. Offline, no database.

Run:

    python3 -m knowledge.labels_test
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.labels import arbitrate


class AssertionFailure(AssertionError):
    pass


def _check(label: str, condition: bool, detail: str) -> None:
    if not condition:
        raise AssertionFailure(f"{label}: {detail}")
    print(f"PASS  {label}: {detail}")


def test_branch_1_no_proposal() -> None:
    decision = arbitrate(("consulting",), None)
    _check(
        "branch 1 (no proposal)",
        decision.domains == ("consulting",)
        and decision.label_source == "rules"
        and decision.needs_review is False,
        f"-> {decision}",
    )


def test_branch_2_narrowing() -> None:
    decision = arbitrate(("consulting", "properties"), "consulting")
    _check(
        "branch 2 (narrowing, multi-domain)",
        decision.domains == ("consulting",)
        and decision.label_source == "rules"
        and decision.needs_review is False,
        f"-> {decision}",
    )

    # Degenerate narrowing: proposal matches the only rules domain already.
    decision_single = arbitrate(("consulting",), "consulting")
    _check(
        "branch 2 (narrowing, single-domain no-op)",
        decision_single.domains == ("consulting",)
        and decision_single.label_source == "rules"
        and decision_single.needs_review is False,
        f"-> {decision_single}",
    )


def test_branch_3_widening_non_sensitive() -> None:
    decision = arbitrate(("consulting",), "properties")
    _check(
        "branch 3 (non-sensitive widening rejected)",
        decision.domains == ("consulting",)
        and decision.label_source == "model_proposed"
        and decision.needs_review is True,
        f"-> {decision}",
    )


def test_branch_4_widening_sensitive() -> None:
    decision = arbitrate(("properties",), "private")
    _check(
        "branch 4 (sensitive domain the rules missed)",
        decision.domains == ("properties",)
        and decision.label_source == "model_proposed"
        and decision.needs_review is True
        and "private" in decision.reason,
        f"-> {decision}",
    )


def test_never_widens() -> None:
    """Property check: for any proposal, returned domains is a subset of input."""
    cases = [
        (("consulting",), None),
        (("consulting", "properties"), "properties"),
        (("consulting",), "unclassified"),
        (("properties",), "consulting"),
        (("private", "unclassified"), "unclassified"),
    ]
    for rules_domains, proposed in cases:
        decision = arbitrate(rules_domains, proposed)
        subset = set(decision.domains) <= set(rules_domains)
        _check(
            "never-widens property",
            subset,
            f"rules={rules_domains!r} proposed={proposed!r} -> {decision.domains!r}",
        )


def main() -> int:
    tests = [
        test_branch_1_no_proposal,
        test_branch_2_narrowing,
        test_branch_3_widening_non_sensitive,
        test_branch_4_widening_sensitive,
        test_never_widens,
    ]
    failures = 0
    for test in tests:
        try:
            test()
        except AssertionFailure as error:
            print(f"FAIL  {error}")
            failures += 1

    if failures:
        print(f"\n{failures} test(s) failed.")
        return 1

    print("\nAll arbitrate() branch tests pass.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
