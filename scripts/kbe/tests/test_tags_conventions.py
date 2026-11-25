"""`kbe tags` follows the CLI's conventions: the env file decides the database,
and an expected failure is a `KbeError`."""

from __future__ import annotations

import pytest

from kbe import ingest_client, tag_audit, tags
from kbe.errors import KbeError
from kbe.tags_test import ROWS, FakeQuery, _ctx

def test_the_database_client_comes_from_the_env_file(tmp_path, monkeypatch):
    """`--env-file` decides the project and the schema; nothing else is read."""
    ctx, lines = _ctx(tmp_path)
    ctx.env_file.write_text(
        "SUPABASE_URL=https://example.supabase.co\n"
        "SUPABASE_ANON_KEY=fake-anon-key-0123456789\n"
        "SUPABASE_JWT_SECRET=fake-jwt-secret-0123456789-0123456789\n"
        "KB_SCHEMA=kb_acme\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("KB_SCHEMA", raising=False)
    seen: dict = {}

    class Inner:
        def schema(self, name):
            seen["schema"] = name
            return FakeQuery(list(ROWS))

    def build(values, role):
        seen.update(url=values["SUPABASE_URL"], role=role)
        return Inner()

    monkeypatch.setattr(ingest_client, "_build", build)
    args = tags.build_parser().parse_args(["audit", "--source", "drive"])
    assert tags.run(args, ctx) == 0
    assert seen == {"url": "https://example.supabase.co", "role": "kb_ingest", "schema": "kb_acme"}
    assert "drive: 2 documents" in lines[0]


def test_no_env_file_is_a_clear_error(tmp_path):
    ctx, _lines = _ctx(tmp_path)
    with pytest.raises(KbeError, match="No local env file"):
        tags.run(tags.build_parser().parse_args(["audit"]), ctx)


def test_expected_failures_are_raised_as_kbe_errors(tmp_path, monkeypatch):
    ctx, _lines = _ctx(tmp_path)

    class Broken:
        def schema(self, _name):
            raise ConnectionError("x")

    monkeypatch.setattr(tags, "_database", lambda _ctx: Broken())
    with pytest.raises(KbeError, match="0031") as caught:
        tags.run(tags.build_parser().parse_args(["audit"]), ctx)
    assert isinstance(caught.value.__cause__, tag_audit.TagAuditError)


def test_authorize_reports_through_the_context(tmp_path, monkeypatch):
    from kbe import tag_clients

    ctx, lines = _ctx(tmp_path)
    monkeypatch.setattr(tag_clients, "authorize", lambda source, secret, out: out)
    argv = ["authorize", "--source", "drive", "--client-secret", "c.json", "--out", "t.json"]
    assert tags.run(tags.build_parser().parse_args(argv), ctx) == 0
    assert "Saved a drive token" in lines[0]
