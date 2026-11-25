"""The Python validator for the Engine config, and how the config is loaded.

Mirrors engine/tests/config/engine-config.test.ts: the two validators must
agree, and both must accept config/engine.example.yaml.
"""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
import yaml

from knowledge import engine_config
from knowledge.engine_config import ConfigurationError, UNCLASSIFIED, parse, validate

EXAMPLE_PATH = Path(__file__).resolve().parents[2] / "config" / "engine.example.yaml"
EXAMPLE = yaml.safe_load(EXAMPLE_PATH.read_text(encoding="utf-8"))


def example(change=lambda raw: None) -> dict:
    """The example as a plain dict, with one change applied to a copy."""
    raw = copy.deepcopy(EXAMPLE)
    change(raw)
    return raw


def test_accepts_the_example_file():
    config = parse(EXAMPLE_PATH.read_text(encoding="utf-8"))
    assert config.engine_id == "acme"
    assert config.owner.email == "owner@example.com"
    assert [d.id for d in config.domains] == ["consulting", "properties", "private"]
    assert config.sources.wiki.repo == "acme/knowledge"
    assert config.sources.fireflies.shared_meetings_enabled is False
    assert config.dashboard["connect"]["login"] == "email-code"


def test_applies_defaults_to_a_minimal_file():
    config = validate(
        {"version": 1, "engine": {"id": "t", "name": "T", "owner": {"email": "o@example.com"}}}
    )
    assert config.tagging.prefix == "kx/"
    assert config.tagging.frontmatter_key == "domains"
    assert config.sources.wiki.enabled is False
    assert config.care_plan_enabled is False
    assert config.dashboard is None
    assert config.domain_ids == (UNCLASSIFIED,)


def test_requires_owner_email():
    with pytest.raises(ConfigurationError, match=r"engine\.owner\.email"):
        validate(example(lambda r: r["engine"]["owner"].pop("email")))


def test_rejects_duplicate_topic_ids():
    bad = example(lambda r: r["domains"].append({"id": "consulting", "label": "Again"}))
    with pytest.raises(ConfigurationError, match="declared twice"):
        validate(bad)


def test_unclassified_is_reserved_and_always_present():
    bad = example(lambda r: r["domains"].append({"id": UNCLASSIFIED, "label": "Mine"}))
    with pytest.raises(ConfigurationError, match="reserved"):
        validate(bad)

    config = validate(example())
    assert config.domain_ids[-1] == UNCLASSIFIED
    assert config.sensitive_domain_ids == frozenset({"private", UNCLASSIFIED})


@pytest.mark.parametrize("source", ["wiki", "drive", "fireflies"])
def test_rejects_an_undeclared_default_domain(source):
    def change(raw):
        raw["sources"][source]["default_domain"] = "nope"

    with pytest.raises(ConfigurationError, match=rf'sources\.{source}\.default_domain: "nope"'):
        validate(example(change))


def test_rejects_a_channel_mapped_to_an_undeclared_topic():
    def bad(raw):
        raw["sources"]["fireflies"]["channels"] = {"Sales": "nope"}

    def good(raw):
        raw["sources"]["fireflies"]["channels"] = {"Sales": "consulting"}

    with pytest.raises(ConfigurationError, match=r'channels\.Sales: "nope"'):
        validate(example(bad))
    assert validate(example(good)).sources.fireflies.channels == {"Sales": "consulting"}


@pytest.mark.parametrize("prefix", ["", "kx", "kx1"])
def test_rejects_a_prefix_without_a_separator(prefix):
    def change(raw):
        raw["tagging"]["prefix"] = prefix

    with pytest.raises(ConfigurationError, match="prefix"):
        validate(example(change))


@pytest.mark.parametrize("prefix", ["kx/", "topic-", "t:"])
def test_accepts_a_prefix_that_ends_in_a_separator(prefix):
    def change(raw):
        raw["tagging"]["prefix"] = prefix
        raw["sources"]["gmail"]["prefix"] = prefix

    config = validate(example(change))
    assert config.tagging.prefix == prefix
    assert config.sources.gmail.prefix == prefix


def test_rejects_a_mail_prefix_without_a_separator():
    def change(raw):
        raw["sources"]["gmail"]["prefix"] = "mail"

    with pytest.raises(ConfigurationError, match=r"sources\.gmail\.prefix"):
        validate(example(change))


def test_gmail_is_off_and_has_no_mailbox_by_default():
    config = validate(example())
    assert config.sources.gmail.enabled is False
    assert config.sources.gmail.mailboxes == ()


def test_gmail_mailbox_defaults_to_the_engine_owner():
    from knowledge.engine_config_gmail import Mailbox, effective_mailboxes

    config = validate(example())
    assert effective_mailboxes(config) == (
        Mailbox(email="owner@example.com", owner_email="owner@example.com"),
    )


def test_gmail_mailbox_names_its_own_owner():
    from knowledge.engine_config_gmail import Mailbox, effective_mailboxes

    def change(raw):
        raw["sources"]["gmail"]["mailboxes"] = [
            {"email": "Shared@Example.com", "owner_email": "Pat@Example.com"}
        ]

    config = validate(example(change))
    assert config.sources.gmail.mailboxes == (
        Mailbox(email="shared@example.com", owner_email="pat@example.com"),
    )
    assert effective_mailboxes(config) == config.sources.gmail.mailboxes


def test_gmail_mailbox_owner_defaults_to_the_engine_owner():
    from knowledge.engine_config_gmail import effective_mailboxes

    def change(raw):
        raw["sources"]["gmail"]["mailboxes"] = [{"email": "shared@example.com"}]

    (mailbox,) = effective_mailboxes(validate(example(change)))
    assert (mailbox.email, mailbox.owner_email) == ("shared@example.com", "owner@example.com")


@pytest.mark.parametrize(
    "mailboxes, problem",
    [
        ([{"email": "not-an-address"}], r"mailboxes\.0\.email"),
        ([{"email": "a@example.com", "owner_email": "nope"}], r"mailboxes\.0\.owner_email"),
        ([{"owner_email": "a@example.com"}], r"mailboxes\.0\.email: required"),
        ([{"email": "a@example.com", "token": "x"}], r"mailboxes\.0\.token: unknown key"),
        ("a@example.com", r"sources\.gmail\.mailboxes: must be a list"),
        (["a@example.com"], r"mailboxes\.0: must be a mapping"),
        (
            [{"email": "a@example.com"}, {"email": "b@example.com"}],
            r"sources\.gmail\.mailboxes: one mailbox is supported",
        ),
    ],
)
def test_rejects_a_bad_gmail_mailbox_list(mailboxes, problem):
    def change(raw):
        raw["sources"]["gmail"]["mailboxes"] = mailboxes

    with pytest.raises(ConfigurationError, match=problem):
        validate(example(change))


def test_requires_a_repo_when_the_wiki_is_on():
    def change(raw):
        raw["sources"]["wiki"]["repo"] = None

    with pytest.raises(ConfigurationError, match=r"sources\.wiki\.repo"):
        validate(example(change))


def test_drive_tag_trust_defaults_to_owner_and_takes_two_values():
    assert validate(example()).sources.drive.trust_tags_from == "owner"
    minimal = validate({"version": 1, "engine": example()["engine"]})
    assert minimal.sources.drive.trust_tags_from == "owner"
    anyone = validate(example(lambda r: r["sources"]["drive"].update(trust_tags_from="anyone")))
    assert anyone.sources.drive.trust_tags_from == "anyone"
    for bad in ("everyone", "Owner", "", 1, None):
        with pytest.raises(ConfigurationError, match=r"sources\.drive\.trust_tags_from"):
            validate(example(lambda r, bad=bad: r["sources"]["drive"].update(trust_tags_from=bad)))


def test_drive_file_kinds_allow_pdf_but_do_not_default_to_it():
    assert validate(example()).sources.drive.include_mime == ("docs", "sheets", "slides")
    with_pdf = validate(example(lambda r: r["sources"]["drive"].update(include_mime=["docs", "pdf"])))
    assert with_pdf.sources.drive.include_mime == ("docs", "pdf")
    with pytest.raises(ConfigurationError, match="include_mime: unknown kind 'video'"):
        validate(example(lambda r: r["sources"]["drive"].update(include_mime=["video"])))


def test_rejects_unknown_keys_and_wrong_types():
    with pytest.raises(ConfigurationError, match="sorces: unknown key"):
        validate(example(lambda r: r.update(sorces={})))
    with pytest.raises(ConfigurationError, match="must be a bool"):
        validate(example(lambda r: r["sources"]["wiki"].update(enabled="yes")))
    with pytest.raises(ConfigurationError, match="version: must be 1"):
        validate(example(lambda r: r.update(version=2)))


def test_a_value_with_a_trailing_newline_does_not_slip_through():
    """`$` in a Python regex also matches before a final newline."""
    with pytest.raises(ConfigurationError, match=r"sources\.wiki\.repo"):
        validate(example(lambda r: r["sources"]["wiki"].update(repo="acme/knowledge\n")))
    with pytest.raises(ConfigurationError, match=r"domains\.0\.id"):
        validate(example(lambda r: r["domains"][0].update(id="consulting\n")))


def test_reports_every_problem_at_once():
    def change(raw):
        raw["tagging"]["prefix"] = "kx"
        raw["sources"]["drive"]["default_domain"] = "nope"

    with pytest.raises(ConfigurationError) as caught:
        validate(example(change))
    assert "tagging.prefix" in str(caught.value)
    assert "sources.drive.default_domain" in str(caught.value)


def test_owner_names_and_emails_are_normalised():
    def change(raw):
        raw["engine"]["owner"]["names"] = ["Pat  Owner", "PAT"]
        raw["engine"]["owner"]["emails"] = ["Me@Example.org"]

    config = validate(example(change))
    assert config.owner_names == frozenset({"pat owner", "pat"})
    assert config.owner_emails == frozenset({"owner@example.com", "me@example.org"})
    assert config.owner_handle == "owner"


# --- loading ----------------------------------------------------------------


@pytest.fixture
def no_cached_config():
    """Start with nothing cached; the shared conftest fixture clears it after."""
    engine_config.set_config_for_tests(None)


def test_loads_from_the_file_named_in_the_environment(no_cached_config, monkeypatch):
    monkeypatch.setenv(engine_config.CONFIG_ENV_VAR, str(EXAMPLE_PATH))
    assert engine_config.get_config().engine_id == "acme"


def test_an_unreadable_file_is_a_clear_error(no_cached_config, monkeypatch, tmp_path):
    monkeypatch.setenv(engine_config.CONFIG_ENV_VAR, str(tmp_path / "missing.yaml"))
    with pytest.raises(ConfigurationError, match="could not be read"):
        engine_config.get_config()


def test_falls_back_to_the_database(no_cached_config, monkeypatch):
    monkeypatch.delenv(engine_config.CONFIG_ENV_VAR, raising=False)
    calls = []

    class FakeClient:
        def schema(self, name):
            calls.append(name)
            return self

        def rpc(self, name, *args):
            calls.append(name)
            return self

        def execute(self):
            return type("Resp", (), {"data": example()})()

    from knowledge import supabase_client

    monkeypatch.setattr(supabase_client, "get_supabase_ingest", lambda: FakeClient())
    assert engine_config.get_config().engine_name == "Acme's Knowledge Base Engine"
    assert calls == ["workspace", "engine_config_get"]
    # Cached: a second call does not go back to the database.
    engine_config.get_config()
    assert calls == ["workspace", "engine_config_get"]


def test_no_config_anywhere_is_a_clear_error(no_cached_config, monkeypatch):
    monkeypatch.delenv(engine_config.CONFIG_ENV_VAR, raising=False)

    class Empty:
        def schema(self, name):
            return self

        def rpc(self, name, *args):
            return self

        def execute(self):
            return type("Resp", (), {"data": None})()

    from knowledge import supabase_client

    monkeypatch.setattr(supabase_client, "get_supabase_ingest", lambda: Empty())
    with pytest.raises(ConfigurationError, match="No Engine config has been applied"):
        engine_config.get_config()


def test_set_config_for_tests_injects_a_config(no_cached_config):
    injected = validate(example(lambda r: r["engine"].update(id="injected")))
    engine_config.set_config_for_tests(injected)
    assert engine_config.get_config() is injected
