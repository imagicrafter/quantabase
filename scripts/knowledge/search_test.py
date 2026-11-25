#!/usr/bin/env python3
"""Offline unit tests for knowledge.search. No network, no .env read.

Run:

    python3 -m pytest knowledge/search_test.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge import search
from knowledge.supabase_client import ConfigurationError


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, "owner"),          # unset -> the owner's handle from the config
        ("helper", "helper"),
        ("kb-engine", "kb-engine"),
        ("HELPER", "helper"),     # case-insensitive
        ("", "owner"),
        ("../x", "owner"),        # not a plain handle -> ignored
        ("a b", "owner"),
    ],
)
def test_default_handle(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("KNOWLEDGE_HANDLE", raising=False)
    else:
        monkeypatch.setenv("KNOWLEDGE_HANDLE", value)
    assert search.default_handle() == expected


def test_default_handle_follows_the_owner_in_the_config(monkeypatch, example_config):
    import dataclasses

    from knowledge import engine_config

    monkeypatch.delenv("KNOWLEDGE_HANDLE", raising=False)
    other = dataclasses.replace(
        example_config,
        owner=dataclasses.replace(example_config.owner, email="Robin@example.org"),
    )
    engine_config.set_config_for_tests(other)
    assert search.default_handle() == "robin"


def test_search_reads_the_token_for_the_env_handle(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_HANDLE", "helper")
    seen = {}
    monkeypatch.setattr(search, "_read_token", lambda handle: seen.setdefault("handle", handle) or "t")
    monkeypatch.setattr(search, "_search_via_function", lambda *a, **k: [])
    assert search.search("q") == []
    assert seen["handle"] == "helper"


def test_direct_fallback_without_a_service_role_key_raises_searcherror(monkeypatch):
    monkeypatch.setattr(search, "_read_token", lambda handle: "t")

    def function_down(*args, **kwargs):
        raise search.SearchError("down")

    def no_service_role():
        raise ConfigurationError("Missing required keys")

    monkeypatch.setattr(search, "_search_via_function", function_down)
    monkeypatch.setattr(search, "_embed_query", lambda text: [0.0])
    monkeypatch.setattr(search, "get_supabase", no_service_role)

    # The function is down and there is no service-role key, so the direct
    # fallback cannot run. The caller must see a SearchError, not a raw
    # ConfigurationError traceback.
    with pytest.raises(search.SearchError):
        search.search("q", handle="helper")
