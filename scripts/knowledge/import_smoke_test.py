"""Every module under `pullers/` and `scripts/knowledge/` imports on its own.

Run in a fresh interpreter whose import path holds only this repository
(`scripts/` and the repository root) and the installed packages, from an
empty working directory. A module that reaches for code outside the
repository, or for a package `pullers/requirements.txt` does not list, fails
here instead of on a deployed job.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PACKAGES = (("pullers", REPO / "pullers"), ("knowledge", REPO / "scripts" / "knowledge"))
# Modules allowed to fail the import (none: optional packages are imported
# inside the functions that need them, never at module level).
OPTIONAL_IMPORTS: frozenset[str] = frozenset()

_PROBE = """
import importlib, json, sys
repo, names = sys.argv[1], sys.argv[2:]
sys.path[:] = [repo + "/scripts", repo] + [
    p for p in sys.path if "site-packages" in p or "lib/python" in p or p.endswith(".zip")
]
failed = {}
for name in names:
    try:
        importlib.import_module(name)
    except BaseException as error:
        failed[name] = f"{type(error).__name__}: {error}"
outside = sorted(
    p for p in sys.path
    if p and not p.startswith(repo) and "python" not in p.lower() and "site-packages" not in p
)
print(json.dumps({"failed": failed, "outside": outside}))
"""


def module_names() -> list[str]:
    names: list[str] = []
    for package, root in PACKAGES:
        for path in sorted(root.rglob("*.py")):
            if path.name.endswith("_test.py") or path.name in ("conftest.py", "__main__.py"):
                continue
            parts = path.relative_to(root).with_suffix("").parts
            dotted = ".".join((package, *parts))
            names.append(dotted.removesuffix(".__init__"))
    return names


def _probe(tmp_path: Path) -> dict:
    result = subprocess.run(
        [sys.executable, "-c", _PROBE, str(REPO), *module_names()],
        cwd=tmp_path, capture_output=True, text=True, timeout=300,
        env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_there_are_modules_to_check() -> None:
    names = module_names()
    assert "pullers.runner" in names and "knowledge.connectors.drive" in names
    assert not [name for name in names if name.endswith("_test")]


def test_every_module_imports_with_only_this_repository_on_the_path(tmp_path) -> None:
    report = _probe(tmp_path)
    failed = {k: v for k, v in report["failed"].items() if k not in OPTIONAL_IMPORTS}
    assert failed == {}, json.dumps(failed, indent=2)
    assert report["outside"] == [], "an import added a path outside the repository"


def test_no_module_names_a_path_outside_the_repository() -> None:
    banned = ("mcp-client", ".claude/skills", '".claude"', "~/.config/", "memory.embedder")
    hits = [
        f"{path.relative_to(REPO)}: {needle}"
        for _package, root in PACKAGES
        for path in sorted(root.rglob("*.py"))
        if path.name != Path(__file__).name
        for needle in banned
        if needle in path.read_text(encoding="utf-8")
    ]
    assert hits == []
