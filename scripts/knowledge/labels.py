"""Label arbitration -- who decides `domains`, and why a model never widens it.

`domains` on a row decides WHO CAN READ IT. A generation that widens a row's
domains is an access-control failure, not a tidiness issue: a leaked personal
row is not undone by a later correction. So the rule here is absolute and has
no override path -- `arbitrate()` can never return a domain that was not
already in `rules_domains`.

The tags at the source always decide the final value (`tag_resolver.py`;
`rules_domains` below is the resolver's answer). A model may only ever narrow
it, or flag a disagreement for a human to resolve: a model reads the actual
content, while a tag is a person's deliberate statement of who may see it.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import sensitive_domains as configured_sensitive_domains


@dataclass(frozen=True, slots=True)
class LabelDecision:
    """The arbitrated outcome for one document's `domains`."""

    domains: tuple[str, ...]
    label_source: str  # 'rules' | 'model_proposed' | 'human_confirmed'
    needs_review: bool
    reason: str


def arbitrate(
    rules_domains: tuple[str, ...], proposed_label: str | None
) -> LabelDecision:
    """Reconcile the rules-based domains with a model's proposed label.

    Exactly four branches. `domains` is always a subset of `rules_domains` --
    never a superset, regardless of what the model proposed.

    `domains` in `workspace.documents` is matched against a caller's grants by
    array overlap (`domains && caller_domains`), so a SHORTER `domains` array
    is a NARROWER, safer audience -- it can only remove readers, never add
    one. That is what makes branch 2 a safe auto-accept instead of a review
    flag: the model isn't granted new authority, it is only allowed to point
    at one of the domains the rules already approved.
    """
    rules_set = frozenset(rules_domains)

    # 1. No proposal (or nothing to arbitrate) -- rules stand as-is.
    if proposed_label is None:
        return LabelDecision(
            domains=rules_domains,
            label_source="rules",
            needs_review=False,
            reason="no label proposed",
        )

    # 2. Proposal names a domain the rules already assigned. If the rules
    #    assigned more than one, narrowing to just this one is safe -- fewer
    #    domains, never more. If the rules assigned exactly this one domain
    #    already, there is nothing to narrow; the value is unchanged.
    if proposed_label in rules_set:
        if len(rules_domains) > 1:
            return LabelDecision(
                domains=(proposed_label,),
                label_source="rules",
                needs_review=False,
                reason=(
                    f"narrowed to {proposed_label!r}, a subset of rules "
                    f"domains {rules_domains!r}"
                ),
            )
        return LabelDecision(
            domains=rules_domains,
            label_source="rules",
            needs_review=False,
            reason="proposal matches the single rules domain; unchanged",
        )

    # 3. Proposal names a sensitive domain the rules missed entirely. Do NOT
    #    widen -- but a model spotting personal content the rules did not is
    #    a signal worth a human look, so this is flagged with elevated intent
    #    even though the returned domains are unchanged.
    if proposed_label in configured_sensitive_domains():
        return LabelDecision(
            domains=rules_domains,
            label_source="model_proposed",
            needs_review=True,
            reason=(
                f"model proposed sensitive domain {proposed_label!r} the rules "
                "did not assign -- kept rules domains, flagged for review"
            ),
        )

    # 4. Proposal names a non-sensitive domain outside `rules_domains` -- a
    #    plain widening attempt. Rejected; rules domains are kept unchanged.
    return LabelDecision(
        domains=rules_domains,
        label_source="model_proposed",
        needs_review=True,
        reason=(
            f"model proposed {proposed_label!r}, not in rules domains "
            f"{rules_domains!r} -- widening rejected, kept rules domains"
        ),
    )
