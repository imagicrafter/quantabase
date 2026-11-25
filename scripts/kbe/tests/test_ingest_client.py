"""The kb_ingest client takes credentials and schema from one env file."""

from __future__ import annotations

import pytest

from kbe import ingest_client, schema
from kbe.errors import KbeError

VALUES = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_ANON_KEY": "fake-anon-key-0123456789",
    "SUPABASE_JWT_SECRET": "fake-jwt-secret-0123456789-0123456789",
}


class Inner:
    def __init__(self):
        self.asked = []

    def schema(self, name):
        self.asked.append(name)
        return f"scoped:{name}"


@pytest.fixture(autouse=True)
def no_process_setting(monkeypatch):
    monkeypatch.delenv(schema.SCHEMA_ENV_VAR, raising=False)


def test_missing_keys_are_named_and_nothing_is_built():
    def build(_values, _role):
        raise AssertionError("must not build")

    with pytest.raises(KbeError, match="SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET"):
        ingest_client.client({"SUPABASE_URL": "https://x.supabase.co"}, build)


def test_the_client_acts_as_kb_ingest_and_gets_only_the_api_keys():
    seen = {}

    def build(values, role):
        seen.update(values=dict(values), role=role)
        return Inner()

    ingest_client.client({**VALUES, "OTHER": "x"}, build)
    assert seen["role"] == "kb_ingest" and set(seen["values"]) == set(VALUES)


def test_schema_comes_from_the_env_file_whatever_is_asked_for():
    inner = Inner()
    pinned = ingest_client.client({**VALUES, "KB_SCHEMA": "kb_acme"}, lambda _v, _r: inner)
    assert pinned.schema("something_else") == "scoped:kb_acme"
    assert pinned.schema() == "scoped:kb_acme"
    assert inner.asked == ["kb_acme", "kb_acme"]


def test_default_schema_when_none_is_set():
    inner = Inner()
    ingest_client.client(VALUES, lambda _v, _r: inner).schema("x")
    assert inner.asked == [schema.DEFAULT_SCHEMA]


def test_a_build_failure_names_no_value():
    def build(_values, _role):
        raise RuntimeError("boom fake-jwt-secret-0123456789-0123456789")

    with pytest.raises(KbeError) as caught:
        ingest_client.client(VALUES, build)
    assert "fake-jwt" not in str(caught.value) and "RuntimeError" in str(caught.value)


def test_a_bad_schema_name_stops_before_building():
    with pytest.raises(KbeError):
        ingest_client.client({**VALUES, "KB_SCHEMA": "public"}, lambda _v, _r: Inner())


def test_the_real_builder_makes_a_client():
    pinned = ingest_client.client(VALUES)
    assert pinned.schema_name == schema.DEFAULT_SCHEMA
    assert pinned.schema("ignored") is not None
