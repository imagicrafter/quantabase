"""The pullers take the knowledge repo and the owner's identity from the
Engine config. Each test changes the config and checks behaviour follows."""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import pytest

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from knowledge import engine_config  # noqa: E402
from pullers import knowledge_repo, meeting_links  # noqa: E402
from pullers.meeting_links import WikiIndex, WikiPage  # noqa: E402


def _with_owner(base, **changes):
    return dataclasses.replace(base, owner=dataclasses.replace(base.owner, **changes))


def _with_wiki(base, **changes):
    wiki = dataclasses.replace(base.sources.wiki, **changes)
    return dataclasses.replace(base, sources=dataclasses.replace(base.sources, wiki=wiki))


def _index(*pages: WikiPage) -> WikiIndex:
    return WikiIndex(pages=tuple(pages), by_title={p.title: p for p in pages})


PAT = WikiPage(title="Pat Owner", directory="people", emails=("owner@example.com",))
ROBIN = WikiPage(title="Robin Vale", directory="people", emails=("robin@example.org",))


def _related(speakers: tuple[str, ...]) -> tuple[str, ...]:
    links = meeting_links.build_links(
        title="Weekly", summary_text="", speakers=speakers, emails=(),
        index=_index(PAT, ROBIN), llm=None,
    )
    return links.related


def test_the_knowledge_repo_comes_from_the_config(example_config):
    assert knowledge_repo.wiki_repo() == "acme/knowledge"
    engine_config.set_config_for_tests(_with_wiki(example_config, repo="birch/notes"))
    assert knowledge_repo.wiki_repo() == "birch/notes"


def test_no_configured_repo_is_a_clear_error(example_config):
    engine_config.set_config_for_tests(_with_wiki(example_config, enabled=False, repo=None))
    with pytest.raises(knowledge_repo.KnowledgeRepoError, match="sources.wiki.repo"):
        knowledge_repo.wiki_repo()


def test_the_clone_url_uses_the_configured_repo(example_config, monkeypatch, tmp_path):
    engine_config.set_config_for_tests(_with_wiki(example_config, repo="birch/notes"))
    commands: list[list[str]] = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return type("Done", (), {"returncode": 0, "stderr": "", "stdout": ""})()

    monkeypatch.setattr(knowledge_repo, "github_token", lambda: "tkn")
    monkeypatch.setattr(knowledge_repo, "CHECKOUT_DIR", tmp_path / "checkout")
    monkeypatch.setattr(knowledge_repo.subprocess, "run", fake_run)
    knowledge_repo.ensure_checkout()
    assert "https://x-access-token:tkn@github.com/birch/notes.git" in commands[0]


def test_the_owner_is_left_out_of_a_meetings_people_links(example_config):
    speakers = ("Pat Owner", "Robin Vale")
    assert _related(speakers) == ("[[Robin Vale]]",)

    # A different owner in the config: now Robin is the one left out.
    engine_config.set_config_for_tests(_with_owner(example_config, names=("Robin Vale",)))
    assert _related(speakers) == ("[[Pat Owner]]",)


def test_the_owners_own_addresses_are_not_looked_up_as_attendees(example_config):
    index = _index(PAT, ROBIN)
    emails = ("owner@example.com", "robin@example.org")

    attendees = meeting_links.resolve_attendees((), emails, index)
    assert [name for name, _link in attendees] == ["Robin Vale"]

    engine_config.set_config_for_tests(
        _with_owner(example_config, email="robin@example.org", emails=())
    )
    attendees = meeting_links.resolve_attendees((), emails, index)
    assert [name for name, _link in attendees] == ["Pat Owner"]
