"""Both validators judge every file in config/fixtures the same way (Python half).

The TypeScript half is engine/tests/config/fixtures.test.ts. Adding a file to
config/fixtures/valid or /invalid adds a case to both.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from knowledge import engine_config, engine_config_schema
from knowledge.engine_config import ConfigurationError

FIXTURES = Path(__file__).resolve().parents[2] / "config" / "fixtures"
VALID = sorted((FIXTURES / "valid").glob("*.yaml"))
INVALID = sorted((FIXTURES / "invalid").glob("*.yaml"))
EXAMPLE = FIXTURES.parent / "engine.example.yaml"


def test_the_corpus_is_there():
    assert len(VALID) >= 6 and len(INVALID) >= 30
    names = {path.stem for path in INVALID}
    assert {"null-section-tagging", "dashboard-unknown-key", "dashboard-bad-menu-tab"} <= names


@pytest.mark.parametrize("path", [*VALID, EXAMPLE], ids=lambda p: p.stem)
def test_valid_fixtures_are_accepted(path):
    engine_config.parse(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.stem)
def test_invalid_fixtures_are_refused(path):
    with pytest.raises(ConfigurationError):
        engine_config.parse(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.stem)
def test_every_invalid_fixture_says_why_on_its_first_line(path):
    first = path.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("# ") and len(first) > 12


def test_a_problem_never_repeats_a_value_from_the_file():
    raw = engine_config_schema.load_yaml(
        "version: 1\nengine:\n  id: acme\n  name: Acme\n  owner: { email: secret-value-here }\n"
        "dashboard:\n  connect: { connector_url: another-secret-value }\n"
    )
    listed = "\n".join(engine_config_schema.schema_problems(raw))
    assert "engine.owner.email" in listed and "dashboard.connect.connector_url" in listed
    assert "secret-value-here" not in listed and "another-secret-value" not in listed


def test_yaml_is_read_as_the_service_reads_it():
    loaded = engine_config_schema.load_yaml("a: yes\nb: on\nc: 2026-01-02\nd: true\ne: ~\nf: 3\n")
    assert loaded == {"a": "yes", "b": "on", "c": "2026-01-02", "d": True, "e": None, "f": 3}


def test_earlier_sensor_names_are_read_from_the_one_compatibility_map():
    earlier = engine_config_schema.legacy_sensor_kinds()
    assert earlier, "engine/src/config/legacy-names.ts was not read"
    task_kinds = [old for old, new in earlier.items() if new == "agent_job"]
    assert task_kinds, "no earlier name for the task sensor was found"
    raw = {"dashboard": {"workers": [{"id": "w", "label": "W", "jobs": [
        {"sensor": f"{task_kinds[0]}:profile/name", "task": "Daily"}]}]}}
    assert engine_config_schema.dashboard_problems(raw) == []
    raw["dashboard"]["workers"][0]["jobs"][0]["sensor"] = "static"
    assert engine_config_schema.dashboard_problems(raw) == ['task "Daily" needs an agent_job sensor']
