"""`kbe doctor` -- are the tools a setup needs installed and logged in?

    kbe doctor [--json]

Only pass or fail is reported. Output from the login checks (which can name
an account) is never shown.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from typing import Sequence

from . import pg, proc
from .context import Context
from .errors import KbeError

MIN_NODE = 22
MIN_PYTHON = (3, 10)
_VERSION = re.compile(r"(\d+)\.(\d+)(?:\.(\d+))?")


@dataclass(frozen=True)
class Finding:
    name: str
    ok: bool
    required: bool
    detail: str
    fix: str = ""


def _version(text: str) -> tuple[int, ...] | None:
    match = _VERSION.search(text)
    return tuple(int(part) for part in match.groups() if part is not None) if match else None


def _first_line(result: proc.ProcResult) -> str:
    lines = (result.stdout or result.stderr).strip().splitlines()
    return lines[0].strip() if lines else ""


def _installed(runner: proc.Runner, name: str, argv: Sequence[str], fix: str) -> Finding:
    result = runner(list(argv), timeout=30)
    if not result.ok:
        return Finding(name, False, True, "not installed", fix)
    return Finding(name, True, True, _first_line(result))


def _logged_in(runner: proc.Runner, name: str, argv: Sequence[str], fix: str) -> Finding:
    result = runner(list(argv), timeout=60)
    if result.code == proc.NOT_FOUND:
        return Finding(name, False, True, "not installed", fix)
    if not result.ok:
        return Finding(name, False, True, "not logged in", fix)
    return Finding(name, True, True, "logged in")


def _node(runner: proc.Runner) -> Finding:
    fix = f"Install Node.js {MIN_NODE} or newer: https://nodejs.org"
    result = runner(["node", "--version"], timeout=30)
    found = _version(result.stdout) if result.ok else None
    if found is None:
        return Finding("node", False, True, "not installed", fix)
    if found[0] < MIN_NODE:
        return Finding("node", False, True, f"{result.stdout.strip()} is too old", fix)
    return Finding("node", True, True, result.stdout.strip())


def _python() -> Finding:
    found = sys.version_info[:3]
    text = ".".join(str(part) for part in found)
    wanted = ".".join(str(part) for part in MIN_PYTHON)
    if found < MIN_PYTHON:
        return Finding("python", False, True, f"{text} is too old", f"Use Python {wanted}+.")
    return Finding("python", True, True, text)


def _database_clients(runner: proc.Runner) -> tuple[Finding, Finding]:
    """`psql` and the `supabase` CLI: a full setup needs both, for different steps."""
    try:
        # The same search the database commands use (KBE_PSQL, PATH, install folders).
        psql = runner([pg.find_psql(), "--version"], timeout=30).ok
    except KbeError:
        psql = False
    supabase = runner(["supabase", "--version"], timeout=30).ok
    return (
        Finding(
            "psql", psql, True,
            "found" if psql else "not installed (needed by `kbe db migrate`, `kbe verify`, "
            "`kbe tokens mint` and `kbe support`)",
            "" if psql else "Install the Postgres client (macOS: brew install libpq; "
            "Debian/Ubuntu: apt install postgresql-client).",
        ),
        Finding(
            "supabase", supabase, True,
            "found" if supabase else "not installed (needed by `kbe db deploy-functions`, "
            "which deploys the embed function)",
            "" if supabase else "Install the Supabase CLI: https://supabase.com/docs/guides/cli",
        ),
    )


def _docker(runner: proc.Runner) -> Finding:
    ok = runner(["docker", "--version"], timeout=30).ok
    detail = "found" if ok else "not installed (only needed for local database tests)"
    return Finding("docker", ok, False, detail)


def examine(runner: proc.Runner) -> tuple[Finding, ...]:
    """Run every check."""
    return (
        _installed(runner, "git", ["git", "--version"], "Install git: https://git-scm.com"),
        _installed(runner, "gh", ["gh", "--version"],
                   "Install the GitHub CLI: https://cli.github.com"),
        _logged_in(runner, "gh login", ["gh", "auth", "status"], "Run: gh auth login"),
        _installed(runner, "doctl", ["doctl", "version"],
                   "Install doctl: https://docs.digitalocean.com/reference/doctl/"),
        _logged_in(runner, "doctl login", ["doctl", "account", "get"], "Run: doctl auth init"),
        _node(runner),
        _python(),
        *_database_clients(runner),
        _docker(runner),
    )


def healthy(findings: Sequence[Finding]) -> bool:
    return all(f.ok for f in findings if f.required)


def render(findings: Sequence[Finding]) -> list[str]:
    width = max(len(f.name) for f in findings)
    lines = []
    for item in findings:
        mark = "PASS" if item.ok else ("FAIL" if item.required else "SKIP")
        lines.append(f"{mark}  {item.name:<{width}}  {item.detail}")
        if not item.ok and item.fix:
            lines.append(f"      {'':<{width}}  -> {item.fix}")
    lines.append(
        "All required tools are ready."
        if healthy(findings)
        else "Some required tools are missing or not logged in. Fix the FAIL lines above."
    )
    return lines


def _cmd_doctor(args: argparse.Namespace, ctx: Context) -> int:
    findings = examine(ctx.runner)
    if args.json:
        payload = {"ok": healthy(findings), "checks": [asdict(f) for f in findings]}
        ctx.out(json.dumps(payload, indent=2))
    else:
        for line in render(findings):
            ctx.out(line)
    return 0 if healthy(findings) else 1


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "doctor",
        help="check that the tools a setup needs are installed and logged in",
        description="Checks git, gh (and its login), doctl (and its login), "
        f"node {MIN_NODE}+, python, psql (for `kbe db migrate` and the database checks) "
        "and supabase (for `kbe db deploy-functions`). Exits non-zero if a required one "
        "fails. Docker is optional.",
    )
    parser.add_argument("--json", action="store_true", help="print the results as JSON")
    parser.set_defaults(func=_cmd_doctor)
