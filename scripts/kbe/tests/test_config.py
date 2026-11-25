"""Config diff rendering, the two database routes, and the config commands."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from kbe import cli, config_cmd, config_diff, config_store, pg, proc
from kbe.errors import KbeError, UsageError
from kbe.tests.helpers import FakeRunner, make_context

EXAMPLE = Path(__file__).resolve().parents[3] / "config" / "engine.example.yaml"
FAKE_SECRET = "fake-jwt-signing-value-0123456789abcdef"
FAKE_ANON = "fake-anon-value-0123456789"


@pytest.fixture
def base():
    return dict(config_cmd.read_config(EXAMPLE))


def _changed(base, edit):
    new = copy.deepcopy(base)
    edit(new)
    return new


def test_first_apply_lists_owner_topics_and_sources(base):
    change = config_diff.diff(None, base)
    text = config_diff.render(change)
    assert change.first_apply and not change.is_empty
    assert "No config has been applied yet" in text
    assert '+ owner: "owner@example.com" becomes the first administrator' in text
    assert '+ topic private: "Private" (sensitive)' in text
    assert "+ topic unclassified (always there; owner only)" in text
    assert "+ source gmail: off" in text and "+ source wiki: on" in text


def test_same_config_is_no_change(base):
    change = config_diff.diff(copy.deepcopy(base), base)
    assert change.is_empty
    assert config_diff.render(change).startswith("No changes")


def test_topics_added_removed_and_changed(base):
    def edit(new):
        new["domains"] = [
            {"id": "consulting", "label": "Advisory"},
            {"id": "private", "label": "Private"},
            {"id": "sales", "label": "Sales", "sensitive": True},
        ]

    change = config_diff.diff(base, _changed(base, edit))
    assert change.lines == (
        '+ topic sales: "Sales" (sensitive)',
        '- topic properties: "Rental Properties"',
        '~ topic consulting: label "Consulting" -> "Advisory"',
        "~ topic private: no longer sensitive",
    )
    warnings = "\n".join(change.warnings)
    assert "refuses to remove a topic" in warnings
    assert "refuses to unlock a sensitive topic" in warnings
    assert "Heads up:" in config_diff.render(change)


def test_topic_becoming_sensitive_is_shown_without_a_warning(base):
    def edit(new):
        new["domains"][0]["sensitive"] = True

    change = config_diff.diff(base, _changed(base, edit))
    assert change.lines == ("~ topic consulting: becomes sensitive",)
    assert change.warnings == ()


def test_sources_toggled_and_settings_changed(base):
    def edit(new):
        new["sources"]["gmail"]["enabled"] = True
        new["sources"]["drive"]["enabled"] = False
        new["sources"]["wiki"]["repo"] = "acme/other"
        new["tagging"]["prefix"] = "tag-"
        del new["support"]

    change = config_diff.diff(base, _changed(base, edit))
    assert set(change.lines) == {
        "~ source drive: turned off",
        "~ source gmail: turned on",
        '~ source wiki: repo "acme/knowledge" -> "acme/other"',
        '~ tagging.prefix: "kx/" -> "tag-"',
        "~ support.care_plan.enabled: false -> (not set)",
    }


def test_owner_change_is_called_out(base):
    def edit(new):
        new["engine"]["owner"]["email"] = "new@example.com"

    change = config_diff.diff(base, _changed(base, edit))
    assert '~ owner: "owner@example.com" -> "new@example.com"' in change.lines
    assert any("already an active administrator" in w for w in change.warnings)


def test_hash_ignores_key_order_and_changes_with_content(base):
    reordered = dict(reversed(list(base.items())))
    assert config_diff.config_hash(base) == config_diff.config_hash(reordered)
    assert len(config_diff.config_hash(base)) == 64
    other = _changed(base, lambda new: new["engine"].update(name="Other"))
    assert config_diff.config_hash(base) != config_diff.config_hash(other)
    with pytest.raises(KbeError, match="cannot be stored"):
        config_diff.config_hash({"when": object()})


# --- reading a file -----------------------------------------------------------


def test_read_config_lists_every_problem(tmp_path):
    path = tmp_path / "engine.yaml"
    path.write_text(
        "version: 2\nengine: {id: Bad Id, name: X, owner: {email: nope}}\n"
        "domains: [{id: a, label: A}, {id: a, label: B}]\n"
    )
    with pytest.raises(KbeError) as caught:
        config_cmd.read_config(path)
    message = str(caught.value)
    for part in ("version: must be 1", "engine.id", "engine.owner.email", "declared twice"):
        assert part in message


def test_read_config_bad_yaml_and_missing_file(tmp_path):
    path = tmp_path / "engine.yaml"
    path.write_text("a: [unclosed")
    with pytest.raises(KbeError, match="not valid YAML"):
        config_cmd.read_config(path)
    with pytest.raises(KbeError, match="Could not read"):
        config_cmd.read_config(tmp_path / "absent.yaml")


# --- stores -------------------------------------------------------------------


class FakeStore:
    def __init__(self, current=None):
        self.current = current
        self.applied = []

    def describe(self):
        return "a fake store"

    def get(self):
        return self.current

    def apply(self, config, digest):
        self.applied.append((config, digest))
        self.current = config
        return {"config_hash": digest, "owner_email": config["engine"]["owner"]["email"]}


def test_apply_dry_run_shows_diff_and_changes_nothing(base, tmp_path):
    ctx, seen = make_context(tmp_path)
    store = FakeStore()
    assert config_cmd.apply_config(store, base, ctx, dry_run=True) is False
    assert store.applied == []
    assert seen[-1] == "Dry run: nothing was changed."


def test_apply_needs_a_yes(base, tmp_path):
    ctx, _ = make_context(tmp_path, confirm=lambda _q: False)
    store = FakeStore()
    with pytest.raises(KbeError, match="Not applied"):
        config_cmd.apply_config(store, base, ctx)
    assert store.applied == []

    asked = []
    ctx, seen = make_context(tmp_path, confirm=lambda q: asked.append(q) or True)
    assert config_cmd.apply_config(store, base, ctx) is True
    assert asked == ["Apply this config to the database?"]
    assert store.applied[0][1] == config_diff.config_hash(base)
    assert seen[-1] == "Applied. Owner: owner@example.com."


def test_apply_with_yes_does_not_ask_and_no_change_does_not_apply(base, tmp_path):
    def never(_question):
        raise AssertionError("must not ask")

    ctx, seen = make_context(tmp_path, confirm=never)
    store = FakeStore()
    assert config_cmd.apply_config(store, base, ctx, yes=True) is True
    assert config_cmd.apply_config(store, base, ctx, yes=True) is False
    assert len(store.applied) == 1
    assert seen[-1].startswith("No changes")


class FakeResponse:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def _api(post):
    return config_store.ApiStore(
        url="https://project.example.com/", anon_key=FAKE_ANON, jwt_secret=FAKE_SECRET, post=post
    )


def test_api_store_calls_as_kb_ingest(base):
    import jwt as pyjwt

    calls = []

    def post(url, headers, body):
        calls.append((url, headers, body))
        return FakeResponse(200, None if url.endswith("engine_config_get") else {"owner_email": "o"})

    store = _api(post)
    assert store.get() is None
    assert store.apply(base, "abc") == {"owner_email": "o"}
    url, headers, body = calls[1]
    assert url == "https://project.example.com/rest/v1/rpc/engine_config_apply"
    assert body == {"p_config": base, "p_hash": "abc"}
    assert headers["apikey"] == FAKE_ANON
    assert headers["Content-Profile"] == "workspace"
    token = headers["Authorization"].removeprefix("Bearer ")
    claims = pyjwt.decode(token, FAKE_SECRET, algorithms=["HS256"])
    assert claims["role"] == "kb_ingest"
    assert claims["exp"] - claims["iat"] == 300
    assert "kb_ingest" in store.describe()
    assert FAKE_SECRET not in repr(store) and FAKE_ANON not in repr(store)


def test_api_store_errors_are_clear_and_redacted():
    refused = _api(lambda *a: FakeResponse(403, {"message": f"denied for {FAKE_ANON}"}))
    with pytest.raises(KbeError) as caught:
        refused.get()
    assert "refused workspace.engine_config_get" in str(caught.value)
    assert FAKE_ANON not in str(caught.value)

    def down(*_args):
        raise ConnectionError(f"cannot reach with {FAKE_SECRET}")

    with pytest.raises(KbeError) as caught:
        _api(down).get()
    assert "Could not reach" in str(caught.value) and FAKE_SECRET not in str(caught.value)

    with pytest.raises(KbeError, match="HTTP 500"):
        _api(lambda *a: FakeResponse(500, ValueError("not json"))).get()
    with pytest.raises(KbeError, match="unreadable"):
        _api(lambda *a: FakeResponse(200, ValueError("not json"))).get()


def _db(runner):
    conn = pg.connection_vars("postgresql://postgres:fake-local-pw@localhost/postgres")
    return config_store.DbStore(pg.Psql(conn=conn, runner=runner, binary="psql"))


def test_db_store_acts_as_kb_ingest(base):
    def answer(argv, stdin):
        if "engine_config_get" in stdin:
            return proc.ProcResult(0, json.dumps(base) + "\n", "")
        return proc.ProcResult(0, '{"owner_email": "owner@example.com"}\n', "")

    runner = FakeRunner({"psql": answer})
    store = _db(runner)
    assert store.get() == base
    assert store.apply(base, "abc")["owner_email"] == "owner@example.com"
    sent = runner.calls[1]["stdin"]
    assert sent.startswith("set local role kb_ingest;")
    assert "workspace.engine_config_apply($kbe_" in sent and "::jsonb, 'abc')" in sent
    assert "Acme's Knowledge Base Engine" in sent
    assert "fake-local-pw" not in " ".join(runner.calls[1]["argv"])


def test_db_store_falls_back_when_the_login_cannot_take_the_role():
    def answer(argv, stdin):
        if stdin.startswith("set local role"):
            return proc.ProcResult(3, "", 'ERROR:  permission denied to set role "kb_ingest"')
        return proc.ProcResult(0, "\n", "")

    runner = FakeRunner({"psql": answer})
    store = _db(runner)
    assert store.get() is None
    assert len(runner.calls) == 2
    assert not runner.calls[1]["stdin"].startswith("set local role")
    assert "its own login" in store.describe()


def test_db_store_reports_refusals_and_describes_itself():
    refused = _db(FakeRunner({"psql": proc.ProcResult(3, "", "ERROR: topic x still has documents")}))
    with pytest.raises(KbeError, match="still has documents"):
        refused.apply({"version": 1}, "abc")
    with pytest.raises(KbeError, match="Could not reach"):
        refused.describe()
    assert _db(FakeRunner()).describe() == "a direct database connection as kb_ingest"
    garbled = _db(FakeRunner({"psql": proc.ProcResult(0, "not json\n", "")}))
    with pytest.raises(KbeError, match="unreadable"):
        garbled.get()


def test_choose_picks_the_route(monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    api = {"SUPABASE_URL": "https://p.example.com", "SUPABASE_ANON_KEY": FAKE_ANON,
           "SUPABASE_JWT_SECRET": FAKE_SECRET}
    db_only = {"KBE_DATABASE_URL": "postgresql://postgres:fake-local-pw@localhost/postgres"}
    assert isinstance(config_store.choose(api, "auto"), config_store.ApiStore)
    assert isinstance(config_store.choose({**api, **db_only}, "db"), config_store.DbStore)
    assert isinstance(config_store.choose(db_only, "auto"), config_store.DbStore)
    with pytest.raises(KbeError, match="SUPABASE_ANON_KEY"):
        config_store.choose(db_only, "api")
    with pytest.raises(KbeError, match="No way to reach"):
        config_store.choose({}, "auto")
    with pytest.raises(UsageError):
        config_store.choose(api, "carrier-pigeon")


# --- commands -----------------------------------------------------------------


def test_validate_command(tmp_path, capsys):
    ctx, seen = make_context(tmp_path)
    assert cli.main(["config", "validate", str(EXAMPLE)], ctx) == 0
    assert seen[0].startswith("OK:")
    assert "3 topic(s): consulting, properties, private" in seen[1]

    bad = tmp_path / "bad.yaml"
    bad.write_text("version: 1\n")
    assert cli.main(["config", "validate", str(bad)], ctx) == 1
    assert "engine.id: required" in capsys.readouterr().err


def test_apply_command_end_to_end_with_a_fake_database(tmp_path, monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    stored = {}

    def answer(argv, stdin):
        if "engine_config_apply" in stdin:
            stored["sql"] = stdin
            return proc.ProcResult(0, '{"owner_email": "owner@example.com"}\n', "")
        return proc.ProcResult(0, "\n", "")

    ctx, seen = make_context(tmp_path, runner=FakeRunner({"psql": answer}))
    ctx.env_file.write_text("KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n")
    assert cli.main(["config", "apply", str(EXAMPLE), "--yes"], ctx) == 0
    assert "sql" in stored
    assert seen[0] == "Using a direct database connection as kb_ingest."
    saved = json.loads(ctx.state_file.read_text())
    assert saved["phases"]["config"]["status"] == "done"
    assert saved["answers"] == {
        "engine_id": "acme", "owner_email": "owner@example.com", "wiki_repo": "acme/knowledge",
    }
    assert "fake-local-pw" not in ctx.state_file.read_text()


def test_apply_command_dry_run_saves_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv(pg.PSQL_OVERRIDE_VAR, "psql")
    ctx, seen = make_context(tmp_path, runner=FakeRunner({"psql": proc.ProcResult(0, "\n", "")}))
    ctx.env_file.write_text("KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n")
    assert cli.main(["config", "apply", str(EXAMPLE), "--dry-run"], ctx) == 0
    assert seen[-1] == "Dry run: nothing was changed."
    assert not ctx.state_file.exists()
