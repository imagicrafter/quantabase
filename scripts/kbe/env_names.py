"""Which settings names the Python code reads. Used by the example-file test.

A static walk of the source, no imports: every upper-case name that is

  * looked up in a mapping (`values.get("NAME")`, `values["NAME"]`),
  * passed to `require(...)`, `os.getenv(...)`, `os.environ.get(...)` or a
    `..._flag(...)` helper,
  * or held in a constant whose own name says it is a setting
    (`..._KEY`, `..._VAR`, `..._KEYS`, `..._ENV`).

It is deliberately wide: a name it finds that is not a setting is listed in
`NOT_SETTINGS` with the reason, so a new reader cannot slip by unnoticed.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Iterable, Iterator

_NAME = re.compile(r"[A-Z][A-Z0-9]*(_[A-Z0-9]+)+")
_SETTING_CONSTANT = re.compile(r".*(_KEY|_KEYS|_VAR|_VARS|_ENV|_ENV_VAR|_ENV_NAME)$")
_READ_CALLS = frozenset({"get", "getenv", "require", "pop"})

# Upper-case names the walk finds that are not settings a person fills in.
NOT_SETTINGS = {
    "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGSSLROOTCERT",
    "PGCONNECT_TIMEOUT", "PGOPTIONS", "PGAPPNAME",   # made from KBE_DATABASE_URL for psql
    "GIT_TERMINAL_PROMPT",                           # set for a child `git`, never read
    "PYTHONPATH",                                    # set for a child python
    "SETUP_CODE",                                    # an app secret; never in a local file
    "SUPPORT_DATABASE_URL",                          # the name `kbe support enable --out` writes
    "DO_NOT_TRACK",
}


def _is_name(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Constant) and isinstance(node.value, str)
        and _NAME.fullmatch(node.value) is not None
    )


def _strings(node: ast.AST) -> Iterator[str]:
    if _is_name(node):
        yield node.value  # type: ignore[attr-defined]
    elif isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        for item in node.elts:
            yield from _strings(item)


def _from_call(node: ast.Call) -> Iterator[str]:
    func = node.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
    if name in _READ_CALLS or "flag" in name.lower():
        for arg in node.args:
            yield from _strings(arg)


def _from_assign(node: ast.Assign | ast.AnnAssign) -> Iterator[str]:
    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    named = [t.id for t in targets if isinstance(t, ast.Name)]
    if node.value is not None and any(_SETTING_CONSTANT.fullmatch(n) for n in named):
        yield from _strings(node.value)


def names_in(source: str) -> frozenset[str]:
    """Every settings-like name one Python source reads."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call):
            found.update(_from_call(node))
        elif isinstance(node, ast.Subscript) and _is_name(node.slice):
            found.add(node.slice.value)  # type: ignore[attr-defined]
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            found.update(_from_assign(node))
    return frozenset(found)


def _is_test(path: Path) -> bool:
    return path.name.endswith("_test.py") or path.name.startswith("test_") or "tests" in path.parts


def names_read(folders: Iterable[Path]) -> frozenset[str]:
    """Every settings-like name the non-test Python under `folders` reads."""
    found: set[str] = set()
    for folder in folders:
        for path in sorted(folder.rglob("*.py")):
            if not _is_test(path) and path.name != "conftest.py":
                found.update(names_in(path.read_text(encoding="utf-8")))
    return frozenset(found - NOT_SETTINGS)
