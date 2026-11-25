"""Shared pytest setup for `scripts/` and `pullers/`.

Every test runs against a known Engine config -- config/engine.example.yaml --
injected into the config cache, so no test reads a real config file or reaches
a database to find out what the topics are. A test that needs something else
calls `engine_config.set_config_for_tests(...)` itself; the cache is restored
afterwards either way.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
for entry in (str(ROOT / "scripts"), str(ROOT)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

from knowledge import engine_config  # noqa: E402

EXAMPLE_CONFIG = ROOT / "config" / "engine.example.yaml"


@pytest.fixture(scope="session")
def example_config() -> engine_config.EngineConfig:
    return engine_config.parse(EXAMPLE_CONFIG.read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _engine_config(example_config, monkeypatch):
    monkeypatch.delenv(engine_config.CONFIG_ENV_VAR, raising=False)
    engine_config.set_config_for_tests(example_config)
    yield
    engine_config.set_config_for_tests(None)
