"""Reading `setup/manifest.yaml`: the setup phases and how each is verified.

A phase lists `verify` checks. A check is one of:

  kind: sql     `run` is SQL, run inside a transaction that is rolled back.
  kind: shell   `run` is a shell command, run from the repo root.
  kind: manual  nothing can run it yet; it is always reported as skipped.

`expect` says what passing looks like (any mix of):
  equals / contains / not_contains   against the trimmed output
  exit_code                          for shell checks (default 0)
  error_contains                     the run must FAIL, with this text

`env` names values a shell check needs from the local env file; they are
given to that one child process and never printed. `{state.<name>}` in `run`
is filled from local state, quoted for SQL or the shell. `{python}` is the
Python running this tool.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from .errors import KbeError, UsageError

KINDS = ("sql", "shell", "manual")
EXPECT_KEYS = ("equals", "contains", "not_contains", "exit_code", "error_contains")
STATUSES = ("ready", "planned")


@dataclass(frozen=True)
class Check:
    id: str
    description: str
    kind: str
    run: str = ""
    expect: Mapping[str, Any] | None = None
    env: tuple[str, ...] = ()


@dataclass(frozen=True)
class Phase:
    id: str
    title: str
    actor: str = "either"
    status: str = "ready"
    depends_on: tuple[str, ...] = ()
    command: str | None = None
    checks: tuple[Check, ...] = ()

    @property
    def planned(self) -> bool:
        return self.status == "planned"


def _fail(where: str, problem: str) -> KbeError:
    return KbeError(f"setup manifest: {where}: {problem}")


def _check(raw: Any, phase_id: str, index: int) -> Check:
    where = f"{phase_id}.verify[{index}]"
    if not isinstance(raw, Mapping):
        raise _fail(where, "must be a mapping")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise _fail(where, f"kind must be one of {', '.join(KINDS)}")
    if not raw.get("id") or not raw.get("description"):
        raise _fail(where, "needs an id and a description")
    expect = raw.get("expect") or {}
    if not isinstance(expect, Mapping) or any(key not in EXPECT_KEYS for key in expect):
        raise _fail(where, f"expect may only use {', '.join(EXPECT_KEYS)}")
    if kind != "manual" and not str(raw.get("run") or "").strip():
        raise _fail(where, "needs something to run")
    if kind == "sql" and not expect:
        raise _fail(where, "a sql check must say what it expects")
    return Check(
        id=str(raw["id"]),
        description=str(raw["description"]),
        kind=kind,
        run=str(raw.get("run") or "").strip(),
        expect=dict(expect),
        env=tuple(str(name) for name in raw.get("env") or ()),
    )


def _phase(raw: Any, index: int) -> Phase:
    if not isinstance(raw, Mapping) or not raw.get("id"):
        raise _fail(f"phases[{index}]", "must be a mapping with an id")
    phase_id = str(raw["id"])
    status = raw.get("status", "ready")
    if status not in STATUSES:
        raise _fail(phase_id, f"status must be one of {', '.join(STATUSES)}")
    checks = tuple(_check(item, phase_id, i) for i, item in enumerate(raw.get("verify") or ()))
    if status == "ready" and not checks:
        raise _fail(phase_id, "has no verify checks (mark it `status: planned` if not built yet)")
    return Phase(
        id=phase_id,
        title=str(raw.get("title") or phase_id),
        actor=str(raw.get("actor") or "either"),
        status=status,
        depends_on=tuple(str(d) for d in raw.get("depends_on") or ()),
        command=raw.get("command"),
        checks=checks,
    )


def parse(raw: Any) -> tuple[Phase, ...]:
    """Validate a parsed manifest."""
    if not isinstance(raw, Mapping) or not isinstance(raw.get("phases"), list):
        raise _fail("top level", "needs a `phases` list")
    phases = tuple(_phase(item, i) for i, item in enumerate(raw["phases"]))
    ids = [p.id for p in phases]
    repeated = sorted({i for i in ids if ids.count(i) > 1})
    if repeated:
        raise _fail("phases", f"repeated id: {', '.join(repeated)}")
    for phase in phases:
        for needed in phase.depends_on:
            if needed not in ids:
                raise _fail(phase.id, f'depends on "{needed}", which is not a phase')
        check_ids = [c.id for c in phase.checks]
        if len(set(check_ids)) != len(check_ids):
            raise _fail(phase.id, "two checks share an id")
    return phases


def load(path: Path) -> tuple[Phase, ...]:
    try:
        import yaml

        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except ImportError as error:
        raise KbeError(
            "PyYAML is not installed. Run: pip install -r pullers/requirements.txt"
        ) from error
    except OSError as error:
        raise KbeError(f"Could not read the setup manifest at {path}.") from error
    except yaml.YAMLError as error:
        raise KbeError(f"The setup manifest is not valid YAML:\n{error}") from error
    return parse(raw)


def select(phases: Sequence[Phase], wanted: Sequence[str] | None) -> tuple[Phase, ...]:
    """The named phases, in manifest order. None means all of them."""
    if not wanted:
        return tuple(phases)
    known = {p.id for p in phases}
    unknown = [name for name in wanted if name not in known]
    if unknown:
        raise UsageError(
            f"Unknown phase: {', '.join(unknown)}. Run `kbe verify --list` to see them."
        )
    return tuple(p for p in phases if p.id in wanted)
