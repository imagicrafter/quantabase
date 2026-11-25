"""`kbe verify` -- run the verify checks in setup/manifest.yaml.

    kbe verify [--phases a,b,c] [--list] [--json]

A check passes, fails, or is skipped (it could not be run: a value is
missing, or nobody has automated it yet). A skipped check is not a passing
check: any skip makes the whole run fail.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import sys
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping, Sequence

from . import manifest, pg, proc, schema as kb, secrets, state
from .context import ENV_FILE_VAR, Context
from .errors import KbeError
from .schema_rewrite import rewrite_schema

PASS, FAIL, SKIP = "pass", "fail", "skip"
_STATE_REF = re.compile(r"\{state\.([A-Za-z0-9_]+)\}")
_DETAIL_LIMIT = 300


@dataclass(frozen=True)
class CheckResult:
    phase: str
    check: str
    description: str
    status: str
    detail: str = ""


@dataclass(frozen=True)
class Tools:
    """Everything a check may use."""

    values: Mapping[str, str] = field(repr=False)
    answers: Mapping[str, Any]
    psql: pg.Psql | None
    runner: proc.Runner
    root: Any
    env_file: Any
    python: str = sys.executable
    # Checks are written for the default schema name and renamed for this one.
    schema: str = kb.DEFAULT_SCHEMA


class _Skip(Exception):
    """A check could not be run; the message says what is missing."""


def _short(text: str, tools: Tools) -> str:
    cleaned = secrets.redact(text.strip(), tools.values)
    return cleaned if len(cleaned) <= _DETAIL_LIMIT else cleaned[:_DETAIL_LIMIT] + "..."


def _fill(text: str, tools: Tools, quote) -> str:
    """Fill {state.x} and {python}; skip the check if a value is not known yet."""
    missing = sorted({m for m in _STATE_REF.findall(text) if not state.answer(tools.answers, m)})
    if missing:
        raise _Skip(f"needs {', '.join(missing)} in local state (an earlier setup step sets it)")
    filled = _STATE_REF.sub(lambda m: quote(str(state.answer(tools.answers, m.group(1)))), text)
    return filled.replace("{python}", quote(tools.python))


def judge(expect: Mapping[str, Any], result: proc.ProcResult, kind: str) -> tuple[bool, str]:
    """Does the outcome match `expect`? Returns (passed, why not)."""
    output = result.stdout.strip()
    wanted_error = expect.get("error_contains")
    if wanted_error is not None:
        text = f"{result.stderr}\n{result.stdout}"
        if result.ok:
            return False, f'expected it to fail with "{wanted_error}", but it succeeded'
        if str(wanted_error) not in text:
            return False, f'failed, but not with "{wanted_error}": {result.stderr}'
        return True, ""
    output_keys = [k for k in ("equals", "contains", "not_contains") if k in expect]
    code_matters = kind == "sql" or "exit_code" in expect or not output_keys
    if code_matters and result.code != int(expect.get("exit_code", 0)):
        return False, f"exit code {result.code}: {result.stderr or output}"
    if "equals" in expect and output != str(expect["equals"]).strip():
        return False, f'expected "{expect["equals"]}", got "{output}"'
    if "contains" in expect and str(expect["contains"]) not in output:
        return False, f'output does not contain "{expect["contains"]}": {output}'
    if "not_contains" in expect and str(expect["not_contains"]) in output:
        return False, f'output contains "{expect["not_contains"]}"'
    return True, ""


def _run_sql(check: manifest.Check, tools: Tools) -> proc.ProcResult:
    if tools.psql is None:
        raise _Skip(f"needs {pg.DATABASE_URL_KEY} in your local env file")
    sql = _fill(rewrite_schema(check.run, tools.schema), tools, pg.quote_literal)
    # Checks may write probe rows; nothing they do is kept.
    return tools.psql.script(f"{sql}\n;\nrollback;\n", tuples=True, timeout=120)


def _run_shell(check: manifest.Check, tools: Tools) -> proc.ProcResult:
    missing = [name for name in check.env if not tools.values.get(name)]
    if missing:
        raise _Skip(f"needs {', '.join(missing)} in your local env file")
    command = _fill(check.run, tools, shlex.quote)
    extra = {
        **{name: tools.values[name] for name in check.env},
        "PYTHONPATH": f"{tools.root / 'scripts'}:{tools.root}",
        ENV_FILE_VAR: str(tools.env_file),
        kb.SCHEMA_ENV_VAR: tools.schema,
    }
    return tools.runner(["sh", "-c", command], extra=extra, cwd=tools.root, timeout=900)


def run_check(phase: manifest.Phase, check: manifest.Check, tools: Tools) -> CheckResult:
    """Run one check. Never raises: every outcome is a result."""

    def result(status: str, detail: str = "") -> CheckResult:
        return CheckResult(phase.id, check.id, check.description, status, _short(detail, tools))

    try:
        if check.kind == "manual":
            raise _Skip("no automated check yet; a person has to confirm this")
        outcome = _run_sql(check, tools) if check.kind == "sql" else _run_shell(check, tools)
    except _Skip as skipped:
        return result(SKIP, str(skipped))
    except KbeError as error:
        return result(FAIL, str(error))
    passed, why = judge(check.expect or {}, outcome, check.kind)
    return result(PASS if passed else FAIL, why)


def run_phases(phases: Sequence[manifest.Phase], tools: Tools) -> tuple[CheckResult, ...]:
    return tuple(
        run_check(phase, check, tools)
        for phase in phases
        if not phase.planned
        for check in phase.checks
    )


def failed(results: Sequence[CheckResult]) -> bool:
    """True when anything failed or was skipped."""
    return any(r.status != PASS for r in results)


def render(phases: Sequence[manifest.Phase], results: Sequence[CheckResult]) -> list[str]:
    marks = {PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP"}
    lines: list[str] = []
    for phase in phases:
        if phase.planned:
            lines.append(f"{phase.id}: planned (no checks yet)")
            continue
        lines.append(f"{phase.id}: {phase.title}")
        for item in (r for r in results if r.phase == phase.id):
            lines.append(f"  {marks[item.status]}  {item.description}")
            if item.detail:
                lines.append(f"        {item.detail}")
    counts = {key: sum(1 for r in results if r.status == key) for key in marks}
    lines.append(
        f"{counts[PASS]} passed, {counts[FAIL]} failed, {counts[SKIP]} skipped"
        + (" (a skipped check counts as a failure)" if counts[SKIP] else "")
    )
    return lines


def render_list(phases: Sequence[manifest.Phase]) -> list[str]:
    lines = []
    for phase in phases:
        needs = f" (after {', '.join(phase.depends_on)})" if phase.depends_on else ""
        note = "planned" if phase.planned else f"{len(phase.checks)} check(s)"
        lines.append(f"{phase.id:<16} {phase.actor:<7} {note:<12} {phase.title}{needs}")
    return lines


def _save_outcome(ctx: Context, phases, results) -> None:
    updated = state.load(ctx.state_file)
    for phase in phases:
        mine = [r for r in results if r.phase == phase.id]
        if mine:
            updated = state.with_phase(updated, phase.id, "failed" if failed(mine) else "done")
    state.save(ctx.state_file, updated)


def _cmd_verify(args: argparse.Namespace, ctx: Context) -> int:
    wanted = [p.strip() for p in (args.phases or "").split(",") if p.strip()]
    phases = manifest.select(manifest.load(ctx.manifest_file), wanted)
    if args.list:
        for line in render_list(phases):
            ctx.out(line)
        return 0
    values = secrets.load_optional(ctx.env_file)
    needs_db = any(c.kind == "sql" for p in phases for c in p.checks)
    psql = pg.connect(values, ctx.runner) if needs_db and values.get(pg.DATABASE_URL_KEY) else None
    tools = Tools(
        values, state.load(ctx.state_file), psql, ctx.runner, ctx.root, ctx.env_file,
        schema=kb.chosen(values),
    )
    results = run_phases(phases, tools)
    _save_outcome(ctx, phases, results)
    if args.json:
        ctx.out(json.dumps({"ok": not failed(results), "checks": [asdict(r) for r in results]},
                           indent=2))
    else:
        for line in render(phases, results):
            ctx.out(line)
    return 1 if failed(results) else 0


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "verify",
        help="run the verify checks for each setup phase",
        description="Run the verify checks in setup/manifest.yaml and report pass "
        "or fail for each. A check that cannot be run is reported as skipped, and "
        "a skipped check counts as a failure. SQL checks use KBE_DATABASE_URL "
        "from your local env file and roll back anything they write.",
    )
    parser.add_argument("--phases", metavar="a,b,c",
                        help="only these phases (comma-separated); default is all")
    parser.add_argument("--list", action="store_true", help="list the phases; run nothing")
    parser.add_argument("--json", action="store_true", help="print the results as JSON")
    parser.set_defaults(func=_cmd_verify)
