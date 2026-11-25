"""`kbe people`: preview first, a yes, then apply with the returned code."""

from __future__ import annotations

import json

import pytest

from kbe import cli, config_store, people, state
from kbe.errors import KbeError
from kbe.tests.helpers import FakeRunner, make_context

DB_LINE = "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n"
CODE = "0123456789abcdef0123456789abcdef"
PEOPLE = [
    {"handle": "owner", "display_name": "Pat Owner", "email": "owner@example.com",
     "role": "administrator", "active": True, "topics": ["consulting", "unclassified"]},
    {"handle": "sam", "display_name": "Sam Reader", "email": "sam@example.com",
     "role": "reader", "active": False, "topics": []},
]


class Store:
    def __init__(self, error=None, preview=None):
        self.calls, self.error = [], error
        self.preview = preview if preview is not None else {
            "preview": "Add Sam Reader (sam@example.com) as reader. ", "confirm_code": CODE,
            "expires_at": "2026-01-01T00:10:00+00:00"}

    def call(self, function, args=None):
        self.calls.append((function, dict(args or {})))
        if self.error:
            raise self.error
        if function == "admin_people_list":
            return PEOPLE
        if function.endswith("_preview"):
            return self.preview
        return {"applied": True, "summary": "Added Sam Reader."}


@pytest.fixture
def env(tmp_path, monkeypatch):
    def build(store, confirm=None, owner="owner@example.com"):
        ctx, seen = make_context(tmp_path, FakeRunner(), confirm)
        ctx.env_file.write_text(DB_LINE)
        if owner:
            state.save(ctx.state_file,
                       state.with_answer(state.empty(), "owner_email", owner))
        monkeypatch.setattr(people, "store", lambda _ctx: store)
        return ctx, seen
    return build


def test_add_previews_asks_then_applies_with_the_code(env):
    store, asked = Store(), []
    ctx, seen = env(store, confirm=lambda q: asked.append(q) or True)
    assert cli.main(["people", "add", "sam@example.com", "--name", "Sam Reader"], ctx) == 0
    preview_args = {"p_email": "owner@example.com", "p_new_email": "sam@example.com",
                    "p_display_name": "Sam Reader", "p_role": "reader", "p_admin_ack": False}
    assert store.calls == [
        ("admin_person_add_preview", preview_args),
        ("admin_person_add_apply", {**preview_args, "p_code": CODE}),
    ]
    assert seen[0] == "Add Sam Reader (sam@example.com) as reader."
    assert len(asked) == 1 and seen[-1] == "Done. Added Sam Reader."
    assert CODE not in "\n".join(seen), "the confirmation code is never shown"


def test_no_answer_applies_nothing(env, capsys):
    store = Store()
    ctx, _seen = env(store, confirm=lambda _q: False)
    assert cli.main(["people", "grant", "sam@example.com", "consulting"], ctx) == 1
    assert [name for name, _ in store.calls] == ["admin_grant_preview"]
    assert "Not changed" in capsys.readouterr().err


def test_dry_run_shows_the_preview_only(env):
    store = Store()
    ctx, seen = env(store, confirm=lambda _q: True)
    assert cli.main(["people", "revoke", "sam@example.com", "consulting", "--dry-run"], ctx) == 0
    assert store.calls == [("admin_revoke_preview", {
        "p_email": "owner@example.com", "p_person_email": "sam@example.com",
        "p_topic": "consulting"})]
    assert "Dry run" in seen[-1]


def test_yes_does_not_ask(env):
    store = Store()
    ctx, _seen = env(store)
    assert cli.main(["people", "deactivate", "sam@example.com", "--yes"], ctx) == 0
    assert store.calls[-1] == ("admin_person_deactivate_apply", {
        "p_email": "owner@example.com", "p_person_email": "sam@example.com", "p_code": CODE})


def test_acknowledgements_and_role_are_passed_through(env):
    store = Store()
    ctx, _seen = env(store)
    cli.main(["people", "add", "lee@example.com", "--name", "Lee", "--role", "administrator",
              "--admin-ack", "--yes"], ctx)
    cli.main(["people", "grant", "lee@example.com", "private", "--sensitive-ack", "--yes"], ctx)
    assert store.calls[0][1]["p_role"] == "administrator" and store.calls[0][1]["p_admin_ack"]
    assert store.calls[2][1] == {"p_email": "owner@example.com", "p_person_email": "lee@example.com",
                                 "p_topic": "private", "p_sensitive_ack": True}
    assert store.calls[3][1]["p_sensitive_ack"] is True


def test_as_names_another_administrator(env):
    store = Store()
    ctx, _seen = env(store)
    cli.main(["people", "revoke", "sam@example.com", "consulting", "--as", "boss@example.com",
              "--yes"], ctx)
    assert all(args["p_email"] == "boss@example.com" for _name, args in store.calls)


def test_an_administrator_is_needed(env, capsys):
    ctx, _seen = env(Store(), owner=None)
    assert cli.main(["people", "list"], ctx) == 2
    assert "--as EMAIL" in capsys.readouterr().err


def test_a_refusal_from_the_database_is_shown(env, capsys):
    ctx, _seen = env(Store(error=KbeError("The database refused: not an administrator")))
    assert cli.main(["people", "grant", "sam@example.com", "consulting", "--yes"], ctx) == 1
    assert "not an administrator" in capsys.readouterr().err


def test_a_preview_without_a_code_stops(env, capsys):
    store = Store(preview={})
    ctx, _seen = env(store, confirm=lambda _q: True)
    assert cli.main(["people", "grant", "sam@example.com", "consulting"], ctx) == 1
    assert "no preview" in capsys.readouterr().err
    assert len(store.calls) == 1


def test_list_plain_and_json(env):
    ctx, seen = env(Store())
    assert cli.main(["people", "list"], ctx) == 0
    assert seen[0] == "owner@example.com  administrator  [consulting, unclassified]"
    assert seen[1] == "sam@example.com  reader (inactive)  [no topics]"
    seen.clear()
    assert cli.main(["people", "list", "--json"], ctx) == 0
    assert json.loads(seen[0]) == PEOPLE


def test_list_of_nobody(env, monkeypatch):
    store = Store()
    store.call = lambda *_a, **_k: None
    ctx, seen = env(store)
    assert cli.main(["people", "list"], ctx) == 0
    assert seen == ["No people yet."]


def test_the_store_is_the_direct_connection_as_its_own_login(tmp_path, monkeypatch):
    ctx, _seen = make_context(tmp_path)
    ctx.env_file.write_text(DB_LINE + "KB_SCHEMA=kb_acme\n")
    monkeypatch.delenv("KB_SCHEMA", raising=False)
    monkeypatch.setenv("KBE_PSQL", "psql")
    store = people.store(ctx)
    assert isinstance(store, config_store.DbStore)
    assert store.role is None and store.schema == "kb_acme"


def test_help_for_every_command(capsys):
    for command in ("list", "add", "grant", "revoke", "deactivate"):
        with pytest.raises(SystemExit) as stopped:
            cli.main(["people", command, "--help"])
        assert stopped.value.code == 0
        assert len(capsys.readouterr().out) > 120


def test_reactivate_uses_the_same_two_steps(env):
    store = Store(preview={"preview": "Reactivate Sam Reader (sam@example.com), role reader.",
                           "confirm_code": CODE})
    ctx, seen = env(store, confirm=lambda _q: True)
    assert cli.main(["people", "reactivate", "sam@example.com"], ctx) == 0
    named = {"p_email": "owner@example.com", "p_person_email": "sam@example.com"}
    assert store.calls == [
        ("admin_person_reactivate_preview", named),
        ("admin_person_reactivate_apply", {**named, "p_code": CODE}),
    ]
    assert seen[0].startswith("Reactivate Sam Reader") and CODE not in "\n".join(seen)


def test_reactivate_dry_run_and_no_change_nothing(env, capsys):
    store = Store()
    ctx, _seen = env(store)
    assert cli.main(["people", "reactivate", "sam@example.com", "--dry-run"], ctx) == 0
    assert cli.main(["people", "reactivate", "sam@example.com"], ctx) == 1
    assert [name for name, _args in store.calls] == ["admin_person_reactivate_preview"] * 2
