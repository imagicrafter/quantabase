"""Which app secrets to set from local values, and the spec that sets them. No I/O.

The live spec of the app is the starting point and nothing in it is changed
but the `value` of an entry declared `type: SECRET`.

DigitalOcean does not reveal whether a secret holds a value: the live spec
carries an encrypted `EV[...]` text for EVERY declared secret, also for one
that was never given a value. So nothing here tries to tell a stored secret
from an empty one. A secret that has a local value is set, always; one that
has none goes back with the exact text it came with. Setting a secret to the
value it already has changes nothing, so a push is safe to run again.

Nothing here returns text that holds a value except the new spec itself,
which goes to `doctl` and nowhere else.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator, Mapping

from .deploy_merge import KINDS

# App secret -> the name the same value has in the local env file, where the
# two differ. The one place a pair is written. Every other secret is looked
# up under its own name.
LOCAL_NAMES = {
    # The service's embed token is the jobs' KNOWLEDGE_EMBED_TOKEN, which is
    # what `kbe tokens mint --embed --write-env` writes.
    "EMBED_TOKEN": "KNOWLEDGE_EMBED_TOKEN",
}
APP_WIDE = "(app-wide)"
SET, SKIP = "set", "skip"


@dataclass(frozen=True)
class Item:
    """One declared secret and what a push would do with it."""

    component: str
    key: str
    action: str


def local_name(key: str) -> str:
    """The name a secret's value has in the local env file."""
    return LOCAL_NAMES.get(key, key)


def _is_secret(entry: Any) -> bool:
    return isinstance(entry, Mapping) and entry.get("type") == "SECRET" and bool(entry.get("key"))


def _action(entry: Mapping[str, Any], values: Mapping[str, str]) -> str:
    return SET if values.get(local_name(str(entry["key"]))) else SKIP


def _holders(spec: Mapping[str, Any]) -> Iterator[tuple[str, Mapping[str, Any]]]:
    """(name, holder of an `envs` list): the app itself, then every component."""
    yield APP_WIDE, spec
    for kind in KINDS:
        for component in spec.get(kind) or []:
            if isinstance(component, Mapping):
                yield str(component.get("name")), component


def plan(live: Mapping[str, Any], values: Mapping[str, str]) -> tuple[Item, ...]:
    """Every secret the live spec declares, in spec order, with its action."""
    return tuple(
        Item(name, str(entry["key"]), _action(entry, values))
        for name, holder in _holders(live)
        for entry in holder.get("envs") or []
        if _is_secret(entry)
    )


def _entry(entry: Any, values: Mapping[str, str]) -> Any:
    if not _is_secret(entry) or _action(entry, values) != SET:
        return entry
    return {**entry, "value": values[local_name(str(entry["key"]))]}


def _with_values(holder: Any, values: Mapping[str, str]) -> Any:
    if not isinstance(holder, Mapping) or not isinstance(holder.get("envs"), list):
        return holder
    return {**holder, "envs": [_entry(e, values) for e in holder["envs"]]}


def updated(live: Mapping[str, Any], values: Mapping[str, str]) -> dict[str, Any]:
    """A new spec: `live`, with the local value on each secret that has one."""
    spec = _with_values(dict(live), values)
    for kind in KINDS:
        if isinstance(spec.get(kind), list):
            spec = {**spec, kind: [_with_values(c, values) for c in spec[kind]]}
    return spec


def _without_value(holder: Any, key: str) -> Any:
    if not isinstance(holder, Mapping) or not isinstance(holder.get("envs"), list):
        return holder
    envs = [
        {name: value for name, value in entry.items() if name != "value"}
        if _is_secret(entry) and entry.get("key") == key else entry
        for entry in holder["envs"]
    ]
    return {**holder, "envs": envs}


def cleared(live: Mapping[str, Any], key: str) -> dict[str, Any]:
    """A new spec: `live`, with the secret `key` still declared but holding nothing.

    A declared secret sent with no `value` is blanked by the platform (that is
    why `deploy_merge.carry_over` exists). The declaration stays, so the secret
    can be given a value again later.
    """
    spec = _without_value(dict(live), key)
    for kind in KINDS:
        if isinstance(spec.get(kind), list):
            spec = {**spec, kind: [_without_value(c, key) for c in spec[kind]]}
    return spec


def declares(live: Mapping[str, Any], key: str) -> bool:
    """True when the live spec declares `key` as a secret anywhere."""
    return any(item.key == key for item in plan(live, {}))
