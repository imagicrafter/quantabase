"""The knowledge pipeline takes its topics and owner from the Engine config.

Each test changes the config and checks that behaviour follows it, and one
checks that nothing needs a config merely to be imported.
"""

from __future__ import annotations

import dataclasses
import importlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from knowledge import config, engine_config, labels, taxonomy
from knowledge.tag_resolver import resolve
from knowledge.connectors import wiki
from knowledge.contract import Document, DocumentValidationError
from knowledge.engine_config import ConfigurationError, Domain

REPO_ROOT = Path(__file__).resolve().parents[2]

MODULES = (
    "knowledge.config", "knowledge.contract", "knowledge.labels", "knowledge.taxonomy",
    "knowledge.tag_resolver", "knowledge.tag_sources.wiki", "knowledge.tag_sources.drive",
    "knowledge.tag_sources.fireflies", "knowledge.tag_sources.gmail",
    "knowledge.triage", "knowledge.distill", "knowledge.model_eval", "knowledge.search",
    "knowledge.embedder", "knowledge.ingest", "knowledge.review_cli",
    "knowledge.connectors.wiki", "knowledge.connectors.drive",
    "knowledge.connectors.gmail", "knowledge.connectors.transcripts",
    "pullers.knowledge_repo", "pullers.meeting_links", "pullers.meeting_writeback",
    "pullers.fireflies", "pullers.fireflies_shared", "pullers.wiki", "pullers.runner",
)


def _with_domains(base, *domains: Domain):
    return dataclasses.replace(base, domains=tuple(domains))


def test_nothing_loads_the_config_at_import_time(tmp_path):
    """A fresh interpreter with no config file and no database credentials
    must still import every module. Loading the config is then an error."""
    code = (
        "import importlib\n"
        "from knowledge import engine_config\n"
        f"for name in {MODULES!r}:\n"
        "    importlib.import_module(name)\n"
        "assert engine_config._cached is None, 'the config was loaded at import'\n"
        "try:\n"
        "    engine_config.get_config()\n"
        "except engine_config.ConfigurationError:\n"
        "    print('OK')\n"
    )
    env = {k: v for k, v in os.environ.items() if k != engine_config.CONFIG_ENV_VAR}
    env["PYTHONPATH"] = os.pathsep.join([str(REPO_ROOT / "scripts"), str(REPO_ROOT)])
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env, cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.strip() == "OK"


def test_domains_come_from_the_config(example_config):
    assert config.domains() == ("consulting", "properties", "private", "unclassified")
    assert config.sensitive_domains() == frozenset({"private", "unclassified"})
    # The older attribute spelling reads the same values, lazily.
    assert config.DOMAINS == config.domains()
    assert config.SENSITIVE_DOMAINS == config.sensitive_domains()

    engine_config.set_config_for_tests(
        _with_domains(example_config, Domain("farm", "Farm"), Domain("health", "Health", True))
    )
    assert config.domains() == ("farm", "health", "unclassified")
    assert config.sensitive_domains() == frozenset({"health", "unclassified"})


def test_default_domain_is_unclassified_and_needs_no_config():
    engine_config.set_config_for_tests(None)
    assert config.DEFAULT_DOMAIN == "unclassified"


def test_config_has_no_other_lazy_attributes():
    with pytest.raises(AttributeError):
        config.NOT_A_SETTING  # noqa: B018


def test_a_document_is_checked_against_the_configured_topics(example_config):
    def doc(domain: str) -> Document:
        return Document(source="wiki", external_id="a.md", title="A", body="b", domains=(domain,))

    assert doc("consulting").domains == ("consulting",)
    with pytest.raises(DocumentValidationError, match="unknown domains"):
        doc("farm")

    engine_config.set_config_for_tests(_with_domains(example_config, Domain("farm", "Farm")))
    assert doc("farm").domains == ("farm",)
    with pytest.raises(DocumentValidationError, match="unknown domains"):
        doc("consulting")


def test_the_model_cannot_widen_into_a_topic_the_config_marks_sensitive(example_config):
    assert "sensitive" in labels.arbitrate(("consulting",), "private").reason

    opened = _with_domains(
        example_config, Domain("consulting", "Consulting"), Domain("private", "Private", False)
    )
    engine_config.set_config_for_tests(opened)
    assert "sensitive" not in labels.arbitrate(("consulting",), "private").reason


def test_the_old_keyword_rules_are_gone_and_say_where_to_go():
    with pytest.raises(taxonomy.TaxonomyRemovedError, match="tag_resolver"):
        taxonomy.assign_domains(tags=["consulting"], filename="x.md", title="x", directory="notes")
    assert not [name for name in vars(taxonomy) if name.endswith("_RULES")]


def test_no_product_code_imports_the_old_rules():
    offenders = [
        str(path.relative_to(REPO_ROOT))
        for folder in ("scripts", "pullers")
        for path in (REPO_ROOT / folder).rglob("*.py")
        if not path.name.endswith("_test.py")
        and path.name != "taxonomy.py"
        and ("taxonomy import" in path.read_text(encoding="utf-8")
             or "import taxonomy" in path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_a_tag_only_counts_for_a_topic_this_engine_declares(example_config):
    assert resolve("wiki", ["retail"], (), example_config).domains == ("unclassified",)
    engine_config.set_config_for_tests(_with_domains(example_config, Domain("retail", "Retail")))
    assert resolve("wiki", ["retail"], (), engine_config.get_config()).domains == ("retail",)


def test_artifact_links_include_the_owners_github_org_from_the_config(example_config):
    urls = [
        "https://github.com/acme/knowledge/blob/main/a.md",
        "https://github.com/someone-else/repo",
        "https://docs.google.com/document/d/1",
    ]
    assert wiki._artifact_only(urls) == [urls[0], urls[2]]

    other = dataclasses.replace(
        example_config,
        sources=dataclasses.replace(
            example_config.sources,
            wiki=dataclasses.replace(example_config.sources.wiki, repo="someone-else/notes"),
        ),
    )
    engine_config.set_config_for_tests(other)
    assert wiki._artifact_only(urls) == [urls[1], urls[2]]


def test_one_setting_names_the_wiki_checkout(monkeypatch, tmp_path):
    """KNOWLEDGE_WIKI_ROOT in the workspace's dotenv file is the only override;
    there is no list of host-specific fallback paths any more."""
    assert not hasattr(config, "WIKI_ROOT_CANDIDATES")

    dotenv_file = tmp_path / (".e" + "nv")
    dotenv_file.write_text("KNOWLEDGE_WIKI_ROOT=/srv/wiki\n", encoding="utf-8")
    monkeypatch.setattr(config, "WORKSPACE_ROOT", tmp_path)
    assert config._resolve_wiki_root() == Path("/srv/wiki")

    dotenv_file.write_text("", encoding="utf-8")
    assert config._resolve_wiki_root() == config.DEFAULT_WIKI_ROOT


def test_loading_without_any_config_says_what_to_do(monkeypatch):
    from knowledge import supabase_client

    engine_config.set_config_for_tests(None)

    def no_credentials():
        raise ConfigurationError("no database credentials")

    monkeypatch.setattr(supabase_client, "get_supabase_ingest", no_credentials)
    with pytest.raises(ConfigurationError):
        config.domains()
