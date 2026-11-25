"""Merging a freshly rendered spec with the spec of the live app. No I/O.

The rendered spec declares every secret with no value. Sent as it is, an
update would blank them. `carry_over` copies each secret's stored (encrypted)
value from the live spec, matched by component kind, component name and
variable name. Nothing here ever returns text that holds such a value except
the merged spec itself, which goes to `doctl` and nowhere else.
"""

from __future__ import annotations

import copy
import difflib
from typing import Any, Mapping, Sequence

KINDS = ("services", "jobs", "workers", "static_sites", "functions", "databases")
_SINGULAR = {
    "services": "service", "jobs": "job", "workers": "worker",
    "static_sites": "static site", "functions": "function", "databases": "database",
}
# The platform returns an encrypted text for every secret of a live app, with
# or without a value behind it. So a value that is present is only "hidden":
# nothing here claims it is set.
SET = "(hidden)"
UNSET = "(no value in the spec)"


def _is_secret(entry: Mapping[str, Any]) -> bool:
    return entry.get("type") == "SECRET"


def _entries(holder: Any) -> list[Mapping[str, Any]]:
    envs = holder.get("envs") if isinstance(holder, Mapping) else None
    return [e for e in envs or [] if isinstance(e, Mapping)]


def _named(spec: Mapping[str, Any], kind: str) -> dict[str, Mapping[str, Any]]:
    items = spec.get(kind) or []
    return {str(c.get("name")): c for c in items if isinstance(c, Mapping)}


def _carry_entry(entry: Mapping[str, Any], live: Mapping[str, Mapping[str, Any]]) -> dict:
    """One rendered variable, with the live value where the new spec has none."""
    was = live.get(str(entry.get("key")))
    if was is None or not was.get("value"):
        return dict(entry)
    # Also when the live one was typed in without "Encrypt": the value is kept
    # (never blanked) and becomes a secret, which the platform then encrypts.
    if _is_secret(entry) and "value" not in entry:
        return {**entry, "value": was["value"]}
    # A plain setting left blank for the dashboard keeps what was typed there.
    if not _is_secret(entry) and entry.get("value") == "" and not _is_secret(was):
        return {**entry, "value": was["value"]}
    return dict(entry)


def _carry_envs(holder: Mapping[str, Any], live_holder: Any) -> dict[str, Any]:
    if "envs" not in holder:
        return dict(holder)
    live = {str(e.get("key")): e for e in _entries(live_holder)}
    return {**holder, "envs": [_carry_entry(e, live) for e in _entries(holder)]}


def _keep_unmanaged(rendered: Mapping[str, Any], live: Mapping[str, Any]) -> dict[str, Any]:
    """`rendered`, plus every top-level setting only the live app has.

    The template does not describe everything an app can hold (ingress rules,
    app-wide variables, egress). What it does not describe is not this tool's
    to remove. Components are different: see `removed_components`.
    """
    kept = {key: value for key, value in live.items() if key not in rendered and key not in KINDS}
    return {**rendered, **copy.deepcopy(kept)}


def carry_over(rendered: Mapping[str, Any], live: Mapping[str, Any]) -> dict[str, Any]:
    """A new spec: `rendered`, with stored secret values taken from `live`."""
    merged = _carry_envs(_keep_unmanaged(copy.deepcopy(dict(rendered)), live), live)
    for kind in KINDS:
        if not isinstance(merged.get(kind), list):
            continue
        was = _named(live, kind)
        merged = {
            **merged,
            kind: [
                _carry_envs(c, was.get(str(c.get("name")))) if isinstance(c, Mapping) else c
                for c in merged[kind]
            ],
        }
    return merged


def _holders(spec: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    found = [("(app-wide)", spec)] if _entries(spec) else []
    for kind in KINDS:
        found = [*found, *_named(spec, kind).items()]
    return found


def removed_components(rendered: Mapping[str, Any], live: Mapping[str, Any]) -> list[str]:
    """Live components the new spec does not have. An update would delete them."""
    return [
        f"{_SINGULAR[kind]} {name}"
        for kind in KINDS
        for name in sorted(_named(live, kind).keys() - _named(rendered, kind).keys())
    ]


def secret_keys(*specs: Mapping[str, Any]) -> frozenset[str]:
    """Every variable name that any of the specs declares as a secret."""
    return frozenset(
        str(entry.get("key"))
        for spec in specs
        for _name, holder in [("", spec), *_holders(spec)]
        for entry in _entries(holder)
        if _is_secret(entry)
    )


def _mask_envs(holder: Any, hidden: frozenset[str]) -> Any:
    if not isinstance(holder, Mapping) or not isinstance(holder.get("envs"), list):
        return holder
    shown = [
        {**e, "value": SET if e.get("value") else UNSET}
        if isinstance(e, Mapping) and (_is_secret(e) or str(e.get("key")) in hidden)
        else e
        for e in holder["envs"]
    ]
    return {**holder, "envs": shown}


def masked(spec: Mapping[str, Any], hidden: frozenset[str] = frozenset()) -> dict[str, Any]:
    """A copy safe to show: every secret's value is replaced by a marker.

    `hidden` names variables to hide whatever their type says, so a secret
    that was typed into the live app as a plain value is not shown either.
    """
    shown = _mask_envs(copy.deepcopy(dict(spec)), hidden)
    for kind in KINDS:
        if isinstance(shown.get(kind), list):
            shown = {**shown, kind: [_mask_envs(c, hidden) for c in shown[kind]]}
    return shown


def _lines(spec: Mapping[str, Any], hidden: frozenset[str]) -> Sequence[str]:
    import yaml

    return yaml.safe_dump(
        masked(spec, hidden), sort_keys=True, default_flow_style=False
    ).splitlines()


def diff(live: Mapping[str, Any], merged: Mapping[str, Any]) -> list[str]:
    """Unified diff of the non-secret content, live -> new. Empty when equal."""
    hidden = secret_keys(live, merged)
    return list(difflib.unified_diff(
        _lines(live, hidden), _lines(merged, hidden), "live app", "new spec", lineterm="", n=2,
    ))
