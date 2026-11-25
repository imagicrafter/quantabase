#!/usr/bin/env python3
"""Offline tests for the distillation model eval harness.

No network calls. Exercises `_score_reply` (which wraps production
`distill.parse` / `distill.verify_terms` unchanged), the cost estimator, and
the hard spend cap -- the pieces that must be right before any model call
actually spends money.

Run:

    cd scripts && ../.venv/bin/python -m knowledge.model_eval_test
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.model_backends import ModelReply
from knowledge.model_eval import (
    ARMS,
    CONFIRM_THRESHOLD,
    SpendCapExceeded,
    _estimate_cost,
    _score_reply,
    select_for_run,
)

SOURCE_TEXT = (
    "Northwind Traders signed SOW-2026-NWT-04 on 2026-08-01 for $10,840. "
    "Dana Foster is the primary contact. The engagement covers Phase 2 dispatch."
)

_check_count = 0


class AssertionFailure(AssertionError):
    pass


def _check(label: str, condition: bool, detail: str) -> None:
    global _check_count
    _check_count += 1
    if not condition:
        raise AssertionFailure(f"{label}: {detail}")
    print(f"PASS  {label}: {detail}")


def _candidate() -> dict:
    return {
        "doc_id": "doc-1",
        "source": "wiki",
        "external_id": "ext-1",
        "title": "Client Phase 2 SOW",
        "body": SOURCE_TEXT,
        "location": "clients/northwind",
        "kind": "wiki_page",
    }


def _reply(text: str, *, input_tokens=100, output_tokens=50, error=None) -> ModelReply:
    return ModelReply(
        text=text,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=123.0,
        used_json_mode=True,
        error=error,
    )


def test_malformed_json_is_a_json_failure_not_a_crash() -> None:
    reply = _reply("this is not { json at all")
    score = _score_reply(_candidate(), reply)
    _check(
        "malformed JSON scores json_ok=False",
        score["json_ok"] is False and score["hard_fail"] is False,
        f"score={score}",
    )
    _check(
        "malformed JSON records an error message",
        bool(score["error"]),
        f"error={score['error']!r}",
    )


def test_all_terms_fabricated_scores_zero_kept_no_crash() -> None:
    reply = _reply(
        '{"what": "A statement of work.", "why": "It authorizes Phase 2 work.", '
        '"terms": ["totally-invented-code-999", "not-in-source-either"]}'
    )
    score = _score_reply(_candidate(), reply)
    _check(
        "fully fabricated terms parse ok with zero kept",
        score["json_ok"] is True and score["hard_fail"] is False and score["terms_kept"] == 0,
        f"score={score}",
    )
    _check(
        "fabricated terms are counted as rejected, not silently dropped",
        score["terms_rejected"] == 2,
        f"terms_rejected={score['terms_rejected']}",
    )


def test_empty_what_is_a_hard_fail_distinct_from_json_failure() -> None:
    reply = _reply('{"what": "", "why": "It authorizes Phase 2 work.", "terms": []}')
    score = _score_reply(_candidate(), reply)
    _check(
        "empty `what` is valid JSON but a hard parse() failure",
        score["json_ok"] is True and score["hard_fail"] is True,
        f"score={score}",
    )


def test_verbatim_terms_are_kept() -> None:
    reply = _reply(
        '{"what": "A statement of work.", "why": "Signed 2026-08-01 for $10,840.", '
        '"terms": ["SOW-2026-NWT-04", "Dana Foster", "made-up-term"]}'
    )
    score = _score_reply(_candidate(), reply)
    _check(
        "two of three terms verify verbatim against the source",
        score["terms_kept"] == 2 and score["terms_rejected"] == 1,
        f"score={score}",
    )


def test_backend_error_scores_as_not_json_ok_without_crashing() -> None:
    reply = _reply("", error="HTTP 500: internal error")
    score = _score_reply(_candidate(), reply)
    _check(
        "a backend error is recorded, not raised",
        score["json_ok"] is False and score["hard_fail"] is False,
        f"score={score}",
    )


def test_bad_label_outside_taxonomy_is_flagged() -> None:
    reply = _reply(
        '{"what": "A statement of work.", "why": "It authorizes work.", '
        '"terms": [], "proposed_label": "not-a-real-domain"}'
    )
    score = _score_reply(_candidate(), reply)
    _check(
        "a proposed_label outside DOMAINS is flagged bad_label",
        score["bad_label"] is True,
        f"score={score}",
    )


def test_cost_estimator_matches_known_token_counts() -> None:
    arm = ARMS["gpt-oss-20b"]  # $0.05 in / $0.45 out per million
    reply = _reply("ignored", input_tokens=1_000_000, output_tokens=1_000_000)
    cost = _estimate_cost(reply, arm)
    _check(
        "cost = in_per_m + out_per_m at exactly 1M tokens each",
        abs(cost - 0.50) < 1e-9,
        f"cost={cost}",
    )


def test_cost_estimator_handles_missing_token_counts() -> None:
    arm = ARMS["gpt-oss-20b"]
    reply = _reply("ignored", input_tokens=None, output_tokens=None)
    cost = _estimate_cost(reply, arm)
    _check("missing token counts cost $0, not a crash", cost == 0.0, f"cost={cost}")


def test_max_docs_cap_truncates_below_confirm_threshold() -> None:
    candidates = [{"doc_id": str(i)} for i in range(30)]
    selected = select_for_run(candidates, max_docs=25, confirm=False)
    _check("30 candidates capped to 25", len(selected) == 25, f"len={len(selected)}")


def test_max_docs_cap_refuses_above_confirm_threshold_without_confirm() -> None:
    candidates = [{"doc_id": str(i)} for i in range(CONFIRM_THRESHOLD + 10)]
    raised = False
    try:
        select_for_run(candidates, max_docs=CONFIRM_THRESHOLD + 5, confirm=False)
    except SpendCapExceeded:
        raised = True
    _check(
        "exceeding the confirm threshold without --confirm refuses to run",
        raised,
        f"SpendCapExceeded raised={raised}",
    )


def test_max_docs_cap_proceeds_above_confirm_threshold_with_confirm() -> None:
    candidates = [{"doc_id": str(i)} for i in range(CONFIRM_THRESHOLD + 10)]
    selected = select_for_run(candidates, max_docs=CONFIRM_THRESHOLD + 5, confirm=True)
    _check(
        "--confirm allows exceeding the threshold, still respects --max-docs",
        len(selected) == CONFIRM_THRESHOLD + 5,
        f"len={len(selected)}",
    )


def main() -> int:
    tests = [
        test_malformed_json_is_a_json_failure_not_a_crash,
        test_all_terms_fabricated_scores_zero_kept_no_crash,
        test_empty_what_is_a_hard_fail_distinct_from_json_failure,
        test_verbatim_terms_are_kept,
        test_backend_error_scores_as_not_json_ok_without_crashing,
        test_bad_label_outside_taxonomy_is_flagged,
        test_cost_estimator_matches_known_token_counts,
        test_cost_estimator_handles_missing_token_counts,
        test_max_docs_cap_truncates_below_confirm_threshold,
        test_max_docs_cap_refuses_above_confirm_threshold_without_confirm,
        test_max_docs_cap_proceeds_above_confirm_threshold_with_confirm,
    ]
    failures = 0
    for test in tests:
        try:
            test()
        except AssertionFailure as error:
            print(f"FAIL  {error}")
            failures += 1

    print(f"\n{_check_count} assertion(s) checked across {len(tests)} test(s).")
    if failures:
        print(f"{failures} test(s) failed.")
        return 1

    print("All model_eval tests pass.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
