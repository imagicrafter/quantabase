"""The shared half of config validation: `config/schema.json` and the dashboard rules.

ONE SOURCE OF TRUTH. The shape of `engine.yaml` is written once, as the zod
schema in `engine/src/config/`. `config/schema.json` is generated from it
(`npm run gen:schema`; a test fails when the file is stale). This module
checks a parsed config against that file, so the Python side (the `kbe`
command line and the jobs) accepts exactly the keys, types and forms the
service does -- the whole `dashboard` section included -- without a second
hand-written copy of the rules.

What a JSON Schema cannot say is written here, next to its twin in
`engine/src/config/status-view.ts` (`dashboardProblems`): the four cross-field
rules of the `dashboard` section. The topic rules live in engine_config.py.

`config/fixtures/` holds configs both validators must judge the same way; the
Python and the TypeScript test suites both run every file in it.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator, Mapping

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "config" / "schema.json"
LEGACY_NAMES_PATH = ROOT / "engine" / "src" / "config" / "legacy-names.ts"

# The service's own email rule (zod), so both sides accept the same addresses.
EMAIL = re.compile(
    r"(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}",
    re.IGNORECASE,
)
_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/?#]+[^\s]*")
_TASK_SENSOR = "agent_job"
_DEFAULT_SOURCE_IDS = (("drive", "documents"), ("fireflies", "meetings"), ("gmail", "email"))
_TYPE_WORDS = {
    "object": "a mapping", "array": "a list", "string": "text", "boolean": "true or false",
    "integer": "a whole number", "number": "a number", "null": "empty",
}


def _yaml_loader() -> Any:
    """A YAML loader that reads scalars the way the service's parser does.

    The service reads YAML 1.2: only `true` and `false` are booleans, and a
    date is text. PyYAML reads YAML 1.1, where `yes`, `on` and `off` are
    booleans and `2026-01-02` is a date, so the same file could mean two
    things. This loader drops those two 1.1 rules.
    """
    import yaml

    class ConfigLoader(yaml.SafeLoader):
        pass

    skipped = ("tag:yaml.org,2002:bool", "tag:yaml.org,2002:timestamp")
    ConfigLoader.yaml_implicit_resolvers = {
        first: [(tag, pattern) for tag, pattern in resolvers if tag not in skipped]
        for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }
    ConfigLoader.add_implicit_resolver(
        "tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
        list("tTfF"),
    )
    return ConfigLoader


def load_yaml(text: str) -> Any:
    """Parse config YAML as the service does. Raises `yaml.YAMLError` on bad YAML."""
    import yaml

    return yaml.load(text, Loader=_yaml_loader())  # noqa: S506 - a SafeLoader subclass


class SchemaUnavailable(RuntimeError):
    """config/schema.json or the `jsonschema` package is missing."""


@lru_cache(maxsize=1)
def _validator() -> Any:
    try:
        import jsonschema
    except ImportError as error:
        raise SchemaUnavailable(
            "the `jsonschema` package is not installed. Run: "
            "pip install -r pullers/requirements.txt"
        ) from error
    try:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SchemaUnavailable(f"{SCHEMA_PATH} could not be read") from error
    checker = jsonschema.FormatChecker(formats=())
    checker.checks("email")(lambda v: not isinstance(v, str) or EMAIL.fullmatch(v) is not None)
    checker.checks("uri")(lambda v: not isinstance(v, str) or _URL.fullmatch(v) is not None)
    return jsonschema.Draft7Validator(schema, format_checker=checker)


def _path(parts: Any) -> str:
    return ".".join(str(part) for part in parts)


def _wanted_types(error: Any) -> str:
    wanted = error.validator_value
    kinds = wanted if isinstance(wanted, list) else [wanted]
    return " or ".join(_TYPE_WORDS.get(str(kind), str(kind)) for kind in kinds)


def _message(error: Any) -> Iterator[str]:
    """Plain messages for one schema error. Never repeats a value from the file."""
    where = _path(error.absolute_path)
    at = f"{where}." if where else ""
    kind = error.validator
    if kind == "additionalProperties":
        allowed = set(error.schema.get("properties", {}))
        for key in sorted(str(key) for key in error.instance if key not in allowed):
            yield f"{at}{key}: unknown key"
    elif kind == "required":
        present = set(error.instance) if isinstance(error.instance, Mapping) else set()
        for key in error.validator_value:
            if key not in present:
                yield f"{at}{key}: required"
    elif kind == "type":
        yield f"{where or 'config'}: must be {_wanted_types(error)}"
    elif kind == "enum":
        allowed = ", ".join(str(value) for value in error.validator_value)
        yield f"{where}: must be one of: {allowed}"
    elif kind == "const":
        yield f"{where}: must be {error.validator_value}"
    elif kind == "anyOf":
        yield f"{where}: is not in an allowed form"
    elif kind == "format":
        yield f"{where}: must be {'an email address' if error.validator_value == 'email' else 'a URL'}"
    elif kind in ("minLength", "minItems"):
        yield f"{where}: must not be empty"
    elif kind == "maxItems":
        yield f"{where}: holds more entries than are allowed ({error.validator_value})"
    else:
        yield f"{where}: is not in the allowed form"


def schema_problems(raw: Any) -> list[str]:
    """Every way `raw` differs from config/schema.json, as `path: problem` lines."""
    errors = sorted(_validator().iter_errors(raw), key=lambda e: list(map(str, e.absolute_path)))
    found: list[str] = []
    for error in errors:
        for message in _message(error):
            if message not in found:
                found.append(message)
    return found


@lru_cache(maxsize=1)
def legacy_sensor_kinds() -> Mapping[str, str]:
    """Earlier sensor kind names the service still accepts: old -> today's.

    Read from the service's one compatibility map so the names are written in
    a single place. A checkout without that file has no earlier names.
    """
    try:
        text = LEGACY_NAMES_PATH.read_text(encoding="utf-8")
    except OSError:
        return {}
    block = re.search(r"LEGACY_SENSOR_KINDS[^=]*=\s*\{(.*?)\}", text, re.DOTALL)
    if block is None:
        return {}
    return dict(re.findall(r'(\w+):\s*"(\w+)"', block.group(1)))


def sensor_kind(sensor: Any) -> str:
    """The kind of a sensor (the part before `:`), as it is named today."""
    kind = str(sensor or "").split(":", 1)[0]
    return legacy_sensor_kinds().get(kind, kind)


def _is_task_sensor(sensor: Any) -> bool:
    """`agent_job:<profile>/<name>` (or an earlier name for the same kind)."""
    return ":" in str(sensor or "") and sensor_kind(sensor) == _TASK_SENSOR


def _items(node: Any, key: str) -> list[Mapping[str, Any]]:
    value = node.get(key) if isinstance(node, Mapping) else None
    return [item for item in value if isinstance(item, Mapping)] if isinstance(value, list) else []


def _enabled(raw: Mapping[str, Any], source: str) -> bool:
    sources = raw.get("sources")
    section = sources.get(source) if isinstance(sources, Mapping) else None
    return isinstance(section, Mapping) and section.get("enabled") is True


def _known_parts(raw: Mapping[str, Any], dashboard: Mapping[str, Any]) -> set[str]:
    """`knowledge.<id>` and `tools.<id>` names a worker may say it uses."""
    knowledge = dashboard.get("knowledge")
    if isinstance(knowledge, Mapping):
        parts = {"knowledge.index"} if isinstance(knowledge.get("index"), Mapping) else set()
        parts |= {f"knowledge.{s.get('id')}" for s in _items(knowledge, "sources")}
    else:  # the gauges the service builds from `sources`
        parts = {"knowledge.index"} if _enabled(raw, "wiki") else set()
        parts |= {f"knowledge.{gauge}" for source, gauge in _DEFAULT_SOURCE_IDS
                  if _enabled(raw, source)}
    tools = dashboard.get("tools") if isinstance(dashboard.get("tools"), Mapping) else {}
    desk = tools.get("support_desk") if isinstance(tools.get("support_desk"), Mapping) else {}
    listed = [*_items(tools, "connected"), *_items(desk, "tools")]
    return parts | {f"tools.{tool.get('id')}" for tool in listed}


def _desk_tab_without_desk(dashboard: Mapping[str, Any]) -> bool:
    menus = dashboard.get("menus") if isinstance(dashboard.get("menus"), Mapping) else {}
    tabs = menus.get("tools") if isinstance(menus.get("tools"), list) else []
    tools = dashboard.get("tools") if isinstance(dashboard.get("tools"), Mapping) else {}
    desk = tools.get("support_desk") if isinstance(tools.get("support_desk"), Mapping) else {}
    return "support_desk" in tabs and desk.get("enabled") is not True


def dashboard_problems(raw: Any) -> list[str]:
    """The cross-field rules of `dashboard`. Same rules, same words as the service."""
    dashboard = raw.get("dashboard") if isinstance(raw, Mapping) else None
    if not isinstance(dashboard, Mapping):
        return []
    known = _known_parts(raw, dashboard)
    workers = _items(dashboard, "workers")
    problems = [
        f"worker {worker.get('id')} uses unknown part {use}"
        for worker in workers
        for use in (worker.get("uses") if isinstance(worker.get("uses"), list) else [])
        if use not in known
    ]
    problems.extend(
        f'task "{job.get("task")}" needs an agent_job sensor'
        for worker in workers for job in _items(worker, "jobs")
        if job.get("task") and not _is_task_sensor(job.get("sensor"))
    )
    knowledge = dashboard.get("knowledge")
    problems.extend(
        f"source {source.get('id')} is off without an off_reason"
        for source in _items(knowledge, "sources")
        if source.get("enabled") is False and not source.get("off_reason")
    )
    if _desk_tab_without_desk(dashboard):
        problems.append("support_desk tab needs tools.support_desk.enabled: true")
    return problems
