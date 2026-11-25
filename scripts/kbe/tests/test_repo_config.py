"""The answers given to `kbe repo init` become a valid engine.yaml, or nothing."""

from __future__ import annotations

import pytest

from kbe import config_cmd, repo_config
from kbe.errors import KbeError, UsageError

ANSWERS = repo_config.Answers(
    engine_id="acme",
    engine_name="Acme's Knowledge Base Engine",
    owner_email="owner@example.com",
    owner_names=("Pat Owner",),
    topics=(
        repo_config.Topic("consulting", "Consulting"),
        repo_config.Topic("private", "Private", True),
    ),
    sources=("wiki", "drive"),
)


@pytest.mark.parametrize(
    "given",
    [
        "acme/knowledge",
        "https://github.com/acme/knowledge",
        "https://github.com/acme/knowledge.git",
        "https://github.com/acme/knowledge/",
        "git@github.com:acme/knowledge.git",
        "ssh://git@github.com/acme/knowledge.git",
    ],
)
def test_a_repo_can_be_named_by_slug_or_url(given):
    assert repo_config.parse_repo_ref(given) == "acme/knowledge"


@pytest.mark.parametrize(
    "bad",
    ["", "knowledge", "https://gitlab.com/acme/knowledge", "acme/know ledge", "a/b/c",
     "https://user:pw@github.com/acme/knowledge"],
)
def test_anything_else_is_a_usage_error(bad):
    with pytest.raises(UsageError):
        repo_config.parse_repo_ref(bad)


def test_topics_are_id_label_and_an_optional_lock():
    topics = repo_config.parse_topics(["consulting=Consulting", "private=Private Things:sensitive"])
    assert topics == (
        repo_config.Topic("consulting", "Consulting", False),
        repo_config.Topic("private", "Private Things", True),
    )


@pytest.mark.parametrize("bad", ["consulting", "=Label", "consulting=", "x=:sensitive"])
def test_a_malformed_topic_is_a_usage_error(bad):
    with pytest.raises(UsageError, match="--topic"):
        repo_config.parse_topics([bad])


def test_sources_always_include_the_wiki_in_a_fixed_order():
    assert repo_config.parse_sources(None) == ("wiki",)
    assert repo_config.parse_sources("gmail, drive") == ("wiki", "drive", "gmail")
    with pytest.raises(UsageError, match="dropbox"):
        repo_config.parse_sources("drive,dropbox")


def test_the_config_names_the_repo_the_owner_the_topics_and_the_sources():
    config = repo_config.build_config(ANSWERS, "acme/knowledge")
    assert config["engine"] == {
        "id": "acme",
        "name": "Acme's Knowledge Base Engine",
        "owner": {
            "email": "owner@example.com", "names": ["Pat Owner"], "emails": ["owner@example.com"],
        },
    }
    assert config["domains"] == [
        {"id": "consulting", "label": "Consulting"},
        {"id": "private", "label": "Private", "sensitive": True},
    ]
    sources = config["sources"]
    assert sources["wiki"] == {"enabled": True, "repo": "acme/knowledge", "default_domain": None}
    assert sources["drive"]["enabled"] is True
    assert sources["fireflies"]["enabled"] is False
    assert sources["gmail"]["enabled"] is False
    validated = repo_config.validate(config)
    assert validated.engine_id == "acme"
    assert validated.sources.wiki.repo == "acme/knowledge"


def test_building_does_not_change_the_answers():
    before = ANSWERS
    repo_config.build_config(ANSWERS, "acme/knowledge")
    assert ANSWERS == before


def test_every_problem_is_listed_before_anything_else_happens():
    bad = repo_config.Answers(
        engine_id="Not A Slug", engine_name="X", owner_email="not-an-email",
        topics=(repo_config.Topic("a", "A"), repo_config.Topic("a", "Again")),
    )
    with pytest.raises(KbeError) as raised:
        repo_config.validate(repo_config.build_config(bad, "acme/knowledge"))
    message = str(raised.value)
    assert "engine.id" in message
    assert "engine.owner.email" in message
    assert "declared twice" in message


def test_the_reserved_topic_cannot_be_declared():
    bad = repo_config.Answers(
        engine_id="acme", engine_name="X", owner_email="owner@example.com",
        topics=(repo_config.Topic("unclassified", "Nope"),),
    )
    with pytest.raises(KbeError, match="reserved"):
        repo_config.validate(repo_config.build_config(bad, "acme/knowledge"))


def test_the_written_file_passes_kbe_config_validate(tmp_path):
    config = repo_config.build_config(ANSWERS, "acme/knowledge")
    text = repo_config.render_yaml(config)
    assert text.startswith("#")
    target = tmp_path / "engine.yaml"
    target.write_text(text, encoding="utf-8")
    assert config_cmd.read_config(target) == config
