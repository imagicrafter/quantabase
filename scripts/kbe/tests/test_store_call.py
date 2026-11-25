"""`call`: any function in the Engine's schema, over either route."""

from __future__ import annotations

import pytest

from kbe import config_store, pg, proc
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner
from kbe.tests.test_config import FAKE_ANON, FAKE_SECRET, FakeResponse


def _db(runner, **options):
    conn = pg.connection_vars("postgresql://postgres:fake-local-pw@localhost/postgres")
    return config_store.DbStore(pg.Psql(conn=conn, runner=runner, binary="psql"), **options)


def test_api_call_sends_named_arguments():
    calls = []

    def post(url, headers, body):
        calls.append((url, body))
        return FakeResponse(200, {"setup_state": "open"})

    store = config_store.ApiStore(
        url="https://project.example.com", anon_key=FAKE_ANON, jwt_secret=FAKE_SECRET, post=post
    )
    assert store.call("engine_access_status") == {"setup_state": "open"}
    assert store.call("engine_setup_reopen", {"p_code_hash": "ab"}) == {"setup_state": "open"}
    assert calls[0] == ("https://project.example.com/rest/v1/rpc/engine_access_status", {})
    assert calls[1][1] == {"p_code_hash": "ab"}


class _Empty:
    """What the REST API sends back for a function that returns void."""

    def __init__(self, status):
        self.status_code, self.text = status, ""

    def json(self):
        raise ValueError("no body")


@pytest.mark.parametrize("status", [200, 204])
def test_api_call_of_a_void_function_is_a_success_with_no_result(status):
    store = config_store.ApiStore(
        url="https://project.example.com", anon_key=FAKE_ANON, jwt_secret=FAKE_SECRET,
        post=lambda url, headers, body: _Empty(status),
    )
    assert store.call("engine_setup_reopen", {"p_code_hash": "ab"}) is None
    assert store.get() is None and store.apply({}, "x") == {}


def test_api_call_with_a_body_that_is_not_json_is_still_an_error():
    class Garbled(_Empty):
        def __init__(self):
            self.status_code, self.text = 200, "<html>gateway</html>"

    store = config_store.ApiStore(
        url="https://project.example.com", anon_key=FAKE_ANON, jwt_secret=FAKE_SECRET,
        post=lambda url, headers, body: Garbled(),
    )
    with pytest.raises(KbeError, match="unreadable"):
        store.call("engine_access_status")


def test_db_call_builds_one_statement_with_typed_values():
    runner = FakeRunner({"psql": proc.ProcResult(0, '{"applied": true}\n', "")})
    result = _db(runner).call("some_function", {
        "p_text": "it's", "p_flag": True, "p_off": False, "p_none": None,
        "p_doc": {"host": "engine.example.com"},
    })
    assert result == {"applied": True}
    sent = runner.calls[0]["stdin"]
    assert sent.startswith("set local role kb_ingest;\nselect workspace.some_function(")
    assert "p_text => 'it''s'" in sent and "p_flag => true" in sent and "p_off => false" in sent
    assert "p_none => null" in sent
    assert 'p_doc => $kbe_' in sent and '{"host": "engine.example.com"}' in sent
    assert sent.rstrip().endswith("::jsonb);")


def test_db_call_with_no_arguments_and_no_result():
    runner = FakeRunner({"psql": proc.ProcResult(0, "\n", "")})
    assert _db(runner).call("engine_setup_reopen") is None
    assert "select workspace.engine_setup_reopen();" in runner.calls[0]["stdin"]


def test_db_call_uses_the_chosen_schema():
    runner = FakeRunner({"psql": proc.ProcResult(0, "{}\n", "")})
    _db(runner, schema="kb_acme").call("engine_access_status")
    assert "select kb_acme.engine_access_status();" in runner.calls[0]["stdin"]


def test_db_call_as_the_login_itself():
    runner = FakeRunner({"psql": proc.ProcResult(0, "[]\n", "")})
    store = _db(runner, role=None)
    assert store.call("admin_people_list", {"p_email": "owner@example.com"}) == []
    assert not runner.calls[0]["stdin"].startswith("set local role")
    assert store.describe() == "a direct database connection as its own login"


@pytest.mark.parametrize("name", ["drop table x; --", "Has-Dash", "", "a b"])
def test_names_are_checked_before_they_reach_sql(name):
    runner = FakeRunner()
    with pytest.raises(KbeError, match="Not a usable database name"):
        _db(runner).call(name)
    with pytest.raises(KbeError, match="Not a usable database name"):
        _db(runner).call("fine", {name: "x"})
    assert runner.calls == []


def test_a_value_of_an_unknown_kind_is_refused():
    with pytest.raises(KbeError, match="cannot be sent"):
        _db(FakeRunner()).call("fine", {"p_number": 1.5})


def test_db_call_reports_a_refusal():
    refused = _db(FakeRunner({"psql": proc.ProcResult(3, "", "ERROR:  not an administrator")}))
    with pytest.raises(KbeError, match="not an administrator"):
        refused.call("admin_people_list", {"p_email": "x@example.com"})
