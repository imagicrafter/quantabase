"""docs/configuration.md must list every config key and environment variable.

The doc is written by hand; the schema and the env files are the truth. These
tests fail when the two drift apart, and say which names are missing or extra.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[3]
DOC = ROOT / "docs" / "configuration.md"
SCHEMA = ROOT / "config" / "schema.json"
SERVICE_ENV = ROOT / "engine" / "src" / "env.ts"
EXAMPLE_FILES = (ROOT / ".env.example", ROOT / "engine" / ".env.example")

KEYS_START, KEYS_END = "<!-- config-keys:start -->", "<!-- config-keys:end -->"
VARS_START, VARS_END = "<!-- env-vars:start -->", "<!-- env-vars:end -->"

_FIRST_CELL = re.compile(r"^\|\s*`([^`]+)`\s*\|")
_BACKTICKED = re.compile(r"`([^`]+)`")
_ENV_OBJECT = re.compile(r"z\.object\(\{\n(.*?)\n\}\);", re.DOTALL)
_ENV_FIELD = re.compile(r"^  ([A-Z][A-Z0-9_]*):", re.MULTILINE)
_EXAMPLE_NAME = re.compile(r"^#?\s*([A-Z][A-Z0-9_]*)=", re.MULTILINE)


def _between(text: str, start: str, end: str) -> str:
    """The part of the doc between two markers. Each marker appears once."""
    assert text.count(start) == 1, f"{DOC.name} must hold {start} exactly once"
    assert text.count(end) == 1, f"{DOC.name} must hold {end} exactly once"
    return text.split(start, 1)[1].split(end, 1)[0]


def _resolve(node: Mapping[str, Any], definitions: Mapping[str, Any]) -> Mapping[str, Any]:
    """Follow a local $ref, and pick the non-null side of a nullable anyOf."""
    if "$ref" in node:
        return _resolve(definitions[node["$ref"].rsplit("/", 1)[-1]], definitions)
    options = [o for o in node.get("anyOf", ()) if o.get("type") != "null"]
    return _resolve(options[0], definitions) if options else node


def schema_keys(node: Mapping[str, Any], definitions: Mapping[str, Any], path: str = "") -> set[str]:
    """Every documented key path under `node`.

    An object with named properties is not a key itself; its properties are.
    A map (`additionalProperties` holding a schema) is one key: the names in
    it are the owner's own. A list is one key, and a list of objects also
    yields `path[].child` for each property of its items.
    """
    node = _resolve(node, definitions)
    properties = node.get("properties")
    if properties:
        found: set[str] = set()
        for name, child in properties.items():
            found |= schema_keys(child, definitions, f"{path}.{name}" if path else name)
        return found
    items = _resolve(node.get("items") or {}, definitions)
    if node.get("type") == "array" and items.get("properties"):
        return {path} | schema_keys(items, definitions, f"{path}[]")
    return {path}


def documented_keys(doc_text: str) -> set[str]:
    """The backticked first cell of every table row in Part 1."""
    lines = _between(doc_text, KEYS_START, KEYS_END).splitlines()
    return {m.group(1) for m in map(_FIRST_CELL.match, lines) if m}


def documented_variables(doc_text: str) -> set[str]:
    """Every backticked name in Part 2."""
    return set(_BACKTICKED.findall(_between(doc_text, VARS_START, VARS_END)))


def service_variables(source: str) -> set[str]:
    """The field names of the `z.object({...})` in engine/src/env.ts."""
    block = _ENV_OBJECT.search(source)
    assert block, "could not find the z.object({...}) block in engine/src/env.ts"
    return set(_ENV_FIELD.findall(block.group(1)))


def example_variables(text: str) -> set[str]:
    """Every `KEY=` name in an example env file, commented out or not."""
    return set(_EXAMPLE_NAME.findall(text))


def _listed(names: set[str]) -> str:
    return "\n".join(f"  {name}" for name in sorted(names)) or "  (none)"


def test_every_config_key_is_documented_and_no_other():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    expected = schema_keys(schema, schema.get("definitions", {}))
    documented = documented_keys(DOC.read_text(encoding="utf-8"))

    missing, extra = expected - documented, documented - expected
    assert not missing and not extra, (
        "docs/configuration.md and config/schema.json disagree.\n"
        f"In the schema but not in the doc:\n{_listed(missing)}\n"
        f"In the doc but not in the schema:\n{_listed(extra)}"
    )


def test_schema_walk_finds_the_three_kinds_of_key():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    keys = schema_keys(schema, schema.get("definitions", {}))

    assert "sources.fireflies.shared_meetings.trusted_domains" in keys  # nested object
    assert {"domains", "domains[].id"} <= keys  # list of objects
    assert "sources.fireflies.channels" in keys  # a map is one key
    assert "engine" not in keys and "engine.owner" not in keys  # objects are not keys


def test_every_environment_variable_is_documented():
    documented = documented_variables(DOC.read_text(encoding="utf-8"))
    service = service_variables(SERVICE_ENV.read_text(encoding="utf-8"))
    examples = {
        name
        for path in EXAMPLE_FILES
        for name in example_variables(path.read_text(encoding="utf-8"))
    }
    assert service, "no variable names were read from engine/src/env.ts"
    assert examples, "no variable names were read from the example env files"

    missing_service, missing_examples = service - documented, examples - documented
    assert not missing_service and not missing_examples, (
        "docs/configuration.md (Part 2) is missing environment variables.\n"
        f"Checked by engine/src/env.ts:\n{_listed(missing_service)}\n"
        f"Named in .env.example or engine/.env.example:\n{_listed(missing_examples)}"
    )
