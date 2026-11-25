"""Product code must not name the schema. It asks `knowledge.kb_schema`.

This fails when a Python file under scripts/ or pullers/ hard-codes the
default schema name again -- as a `.schema("...")` call, as a string that is
exactly the name, or as a SQL-ish `"<name>.table"` string. Docstrings and
comments may still use the default name to explain things.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from knowledge.kb_schema import DEFAULT_SCHEMA

ROOT = Path(__file__).resolve().parents[2]
SEARCHED = (ROOT / "scripts", ROOT / "pullers")
# The only modules allowed to spell the name out.
HELPERS = frozenset({"scripts/knowledge/kb_schema.py", "scripts/kbe/schema_rewrite.py"})
_CALL = re.compile(r"schema\(\s*[\"']" + DEFAULT_SCHEMA + r"[\"']\s*\)")
_QUALIFIED = re.compile(r"(?<![A-Za-z0-9_])" + DEFAULT_SCHEMA + r"\.[a-z_{]")


def _is_test(path: Path) -> bool:
    return path.name.endswith("_test.py") or path.name == "conftest.py" or "tests" in path.parts


def product_files() -> list[Path]:
    found = [p for base in SEARCHED for p in sorted(base.rglob("*.py"))]
    return [
        p for p in found
        if not _is_test(p) and p.relative_to(ROOT).as_posix() not in HELPERS
    ]


def _docstrings(tree: ast.AST) -> set[int]:
    owners = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
    found = set()
    for node in ast.walk(tree):
        body = getattr(node, "body", None) if isinstance(node, owners) else None
        first = body[0] if body else None
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
            found.add(id(first.value))
    return found


def hard_coded(source: str) -> list[str]:
    """Every place `source` names the default schema outside a docstring."""
    problems = [f"schema call: {m.group()}" for m in _CALL.finditer(source)]
    tree = ast.parse(source)
    skip = _docstrings(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in skip:
            continue
        if node.value == DEFAULT_SCHEMA or _QUALIFIED.search(node.value):
            problems.append(f"line {node.lineno}: {node.value[:60]!r}")
    return problems


def test_the_guard_sees_each_kind_of_hard_coding():
    name = DEFAULT_SCHEMA
    assert hard_coded(f'x = sb.schema("{name}").table("t")\n')
    assert hard_coded(f"x = sb.schema('{name}')\n")
    assert hard_coded(f'q = "select * from {name}.documents"\n')
    assert hard_coded(f'q = f"select {name}.fn({{x}})"\n')
    assert hard_coded(f'h = {{"Content-Profile": "{name}"}}\n')


def test_the_guard_allows_docstrings_helpers_and_partial_words():
    name = DEFAULT_SCHEMA
    assert hard_coded(f'"""Reads {name}.documents."""\n') == []
    assert hard_coded(f'def f():\n    """Writes {name}.events."""\n    return db(sb)\n') == []
    assert hard_coded(f'x = "my{name}.thing"\ny = "{name}_root"\n# {name}.documents\n') == []


def test_there_is_product_code_to_scan():
    assert len(product_files()) > 60


def test_no_product_code_hard_codes_the_schema():
    found = {
        path.relative_to(ROOT).as_posix(): problems
        for path in product_files()
        if (problems := hard_coded(path.read_text(encoding="utf-8")))
    }
    assert found == {}, (
        "These files name the schema directly. Use knowledge.kb_schema "
        f"(db(client), qualified(name), schema_name()) instead: {found}"
    )
