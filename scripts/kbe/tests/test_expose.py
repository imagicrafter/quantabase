"""`kbe db expose-schema`: add the schema to the REST API, never remove one."""

from __future__ import annotations

import pytest

from kbe import cli, config_store, expose, schema
from kbe.errors import KbeError
from kbe.tests.helpers import make_context

REF = "abcdefghijklmnopqrst"
TOKEN = "fake-management-token-0123456789"
TOKEN_LINE = f"SUPABASE_ACCESS_TOKEN={TOKEN}\n"
REF_LINE = f"SUPABASE_PROJECT_REF={REF}\n"
ACME_LINE = "KB_SCHEMA=kb_acme\n"
API_LINES = (
    "SUPABASE_URL=https://project.example.com\n"
    "SUPABASE_ANON_KEY=fake-anon-key-0123456789\n"
    "SUPABASE_JWT_SECRET=fake-jwt-secret-0123456789-0123456789\n"
)


class Response:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeApi:
    """The Management API's REST settings for one project."""

    def __init__(self, exposed="public, graphql_public", status=200, keep=True):
        self.settings = {"db_schema": exposed, "max_rows": 1000}
        self.status = status
        self.keep = keep
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        if self.status >= 400:
            return Response(self.status, {"message": "no"})
        if method == "PATCH" and self.keep:
            self.settings = {**self.settings, **body}
        return Response(200, dict(self.settings))


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.delenv(schema.SCHEMA_ENV_VAR, raising=False)

    def refuse(*_args):
        raise AssertionError("a test tried to call the real API")

    monkeypatch.setattr(expose, "request", refuse)


def _ctx(tmp_path, monkeypatch, api=None, lines=""):
    ctx, seen = make_context(tmp_path)
    ctx.env_file.write_text(lines)
    if api is not None:
        monkeypatch.setattr(expose, "request", api)
    return ctx, seen


def test_with_schema_adds_once_and_keeps_the_rest():
    assert expose.with_schema("public, graphql_public", "kb_acme") == "public,graphql_public,kb_acme"
    assert expose.with_schema("public,kb_acme", "kb_acme") is None
    assert expose.with_schema("", "kb_acme") == "kb_acme"
    assert expose.with_schema("public,kb_acme_2", "kb_acme") == "public,kb_acme_2,kb_acme"


def test_adds_the_schema_and_keeps_every_existing_one(tmp_path, monkeypatch):
    api = FakeApi("public, graphql_public, other_app")
    ctx, seen = _ctx(tmp_path, monkeypatch, api, TOKEN_LINE + REF_LINE + ACME_LINE)
    assert cli.main(["db", "expose-schema"], ctx) == 0
    assert [call[0] for call in api.calls] == ["GET", "PATCH"]
    _method, url, headers, body = api.calls[1]
    assert url == f"https://api.supabase.com/v1/projects/{REF}/postgrest"
    assert headers["Authorization"] == f"Bearer {TOKEN}"
    assert body == {"db_schema": "public,graphql_public,other_app,kb_acme"}
    assert seen == ["Exposed schemas are now [public,graphql_public,other_app,kb_acme]."]
    assert TOKEN not in "\n".join(seen)


def test_default_schema_is_exposed_the_same_way(tmp_path, monkeypatch):
    api = FakeApi()
    ctx, _ = _ctx(tmp_path, monkeypatch, api, TOKEN_LINE + REF_LINE)
    assert cli.main(["db", "expose-schema"], ctx) == 0
    assert api.calls[1][3] == {"db_schema": "public,graphql_public,workspace"}


def test_already_exposed_writes_nothing(tmp_path, monkeypatch):
    api = FakeApi("public,kb_acme")
    ctx, seen = _ctx(tmp_path, monkeypatch, api, TOKEN_LINE + REF_LINE + ACME_LINE)
    assert cli.main(["db", "expose-schema"], ctx) == 0
    assert [call[0] for call in api.calls] == ["GET"]
    assert "already exposed" in seen[0]


def test_dry_run_reads_but_never_writes(tmp_path, monkeypatch):
    api = FakeApi()
    ctx, seen = _ctx(tmp_path, monkeypatch, api, TOKEN_LINE + ACME_LINE)
    assert cli.main(["db", "expose-schema", "--project-ref", REF, "--dry-run"], ctx) == 0
    assert [call[0] for call in api.calls] == ["GET"]
    assert seen == [
        "would change the exposed schemas from [public, graphql_public] to "
        "[public,graphql_public,kb_acme]"
    ]


def test_without_a_token_it_prints_the_dashboard_steps(tmp_path, monkeypatch):
    ctx, seen = _ctx(tmp_path, monkeypatch, None, REF_LINE + ACME_LINE)
    assert cli.main(["db", "expose-schema"], ctx) == 0
    text = "\n".join(seen)
    assert f"https://supabase.com/dashboard/project/{REF}/settings/api" in text
    assert "add kb_acme" in text and "Exposed schemas" in text
    nowhere, seen_two = _ctx(tmp_path, monkeypatch, None, "")
    assert cli.main(["db", "expose-schema", "--dry-run"], nowhere) == 0
    assert "your project in the Supabase dashboard" in "\n".join(seen_two)


def test_api_refusal_is_clear_and_hides_the_token(tmp_path, monkeypatch, capsys):
    api = FakeApi(status=401)
    ctx, _ = _ctx(tmp_path, monkeypatch, api, TOKEN_LINE + REF_LINE)
    assert cli.main(["db", "expose-schema"], ctx) == 1
    err = capsys.readouterr().err
    assert "HTTP 401" in err and TOKEN not in err


def test_a_change_that_did_not_stick_is_an_error(tmp_path, monkeypatch, capsys):
    api = FakeApi(keep=False)
    ctx, _ = _ctx(tmp_path, monkeypatch, api, TOKEN_LINE + REF_LINE)
    assert cli.main(["db", "expose-schema"], ctx) == 1
    assert "did not keep the change" in capsys.readouterr().err


def test_unreadable_answers_and_transport_failures(monkeypatch):
    def quiet(_line):
        return None

    monkeypatch.setattr(expose, "request", lambda *a: Response(200, ValueError("x")))
    with pytest.raises(KbeError, match="unreadable"):
        expose.expose("kb_acme", REF, TOKEN, quiet, False)
    monkeypatch.setattr(expose, "request", lambda *a: Response(200, {"other": 1}))
    with pytest.raises(KbeError, match="no db_schema"):
        expose.expose("kb_acme", REF, TOKEN, quiet, False)

    def down(*_args):
        raise OSError("offline")

    monkeypatch.setattr(expose, "request", down)
    with pytest.raises(KbeError, match="Could not reach"):
        expose.expose("kb_acme", REF, TOKEN, quiet, False)


def test_bad_schema_is_refused_before_any_call(tmp_path, monkeypatch):
    api = FakeApi()
    ctx, _ = _ctx(tmp_path, monkeypatch, api, TOKEN_LINE + REF_LINE + "KB_SCHEMA=public\n")
    assert cli.main(["db", "expose-schema"], ctx) == 2
    assert api.calls == []


def test_check_passes_when_the_rest_api_answers(tmp_path, monkeypatch):
    seen_headers = []

    def post(url, headers, body):
        seen_headers.append(headers)
        return Response(200, {"owner_email": "o"})

    monkeypatch.setattr(config_store, "_default_post", post)
    ctx, seen = _ctx(tmp_path, monkeypatch, None, API_LINES + ACME_LINE)
    assert cli.main(["db", "expose-schema", "--check"], ctx) == 0
    assert seen == ['The schema "kb_acme" is served by the REST API.']
    assert seen_headers[0]["Content-Profile"] == "kb_acme"


def test_check_fails_when_the_schema_is_not_exposed(tmp_path, monkeypatch, capsys):
    def post(url, headers, body):
        return Response(406, {"message": "The schema must be one of the following: public"})

    monkeypatch.setattr(config_store, "_default_post", post)
    ctx, _ = _ctx(tmp_path, monkeypatch, None, API_LINES + ACME_LINE)
    assert cli.main(["db", "expose-schema", "--check"], ctx) == 1
    err = capsys.readouterr().err
    assert "kbe db expose-schema" in err and "must be one of" in err


def test_check_needs_the_api_keys(tmp_path, monkeypatch, capsys):
    ctx, _ = _ctx(tmp_path, monkeypatch, None, "")
    assert cli.main(["db", "expose-schema", "--check"], ctx) == 1
    assert "SUPABASE_URL" in capsys.readouterr().err
