"""From the answers given to `kbe repo init` to an engine.yaml. No I/O here.

The mapping is built, then checked with the same validator the pullers use
(`knowledge.engine_config.validate`), before anything is created or pushed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from .errors import KbeError, UsageError

SOURCES = ("wiki", "drive", "fireflies", "gmail")
CONFIG_DIR = ".kb-engine"
CONFIG_FILE = f"{CONFIG_DIR}/engine.yaml"
SENSITIVE_SUFFIX = ":sensitive"

_PART = r"[A-Za-z0-9_.-]+"
_SLUG = re.compile(rf"({_PART})/({_PART})")
_URL_FORMS = (
    re.compile(rf"https://github\.com/({_PART})/({_PART}?)(?:\.git)?/?"),
    re.compile(rf"(?:ssh://)?git@github\.com[:/]({_PART})/({_PART}?)(?:\.git)?/?"),
)
_HEADER = """\
# .kb-engine/engine.yaml -- the one config file for this Engine.
#
# Written by `kbe repo init` from the answers given at setup. Edit it here,
# commit and push; the Engine applies a valid file on its next daily run, or
# at once with `python -m kbe config apply <this file>`.
#
# `domains` are the topics that decide who can see what. `unclassified`
# always exists, is locked to the owner, and may not be declared here.

"""


@dataclass(frozen=True)
class Topic:
    id: str
    label: str
    sensitive: bool = False


@dataclass(frozen=True)
class Answers:
    engine_id: str
    engine_name: str
    owner_email: str
    owner_names: tuple[str, ...] = ()
    topics: tuple[Topic, ...] = ()
    sources: tuple[str, ...] = ("wiki",)


def parse_repo_ref(text: str) -> str:
    """`owner/name` from a slug or a GitHub URL. Other hosts are refused."""
    given = (text or "").strip()
    for pattern in (_SLUG, *_URL_FORMS):
        match = pattern.fullmatch(given)
        if match:
            name = match.group(2).removesuffix(".git")
            if name:
                return f"{match.group(1)}/{name}"
    raise UsageError(
        "Name the repository as owner/name or as its GitHub address "
        "(https://github.com/owner/name). The Engine reads the knowledge repo from GitHub."
    )


def _parse_topic(text: str) -> Topic:
    topic_id, separator, rest = text.partition("=")
    sensitive = rest.endswith(SENSITIVE_SUFFIX)
    label = rest[: -len(SENSITIVE_SUFFIX)] if sensitive else rest
    if not separator or not topic_id.strip() or not label.strip():
        raise UsageError(
            f'--topic "{text}" is not id=Label. Example: --topic consulting=Consulting, '
            f"or --topic private=Private{SENSITIVE_SUFFIX} for a locked topic."
        )
    return Topic(topic_id.strip(), label.strip(), sensitive)


def parse_topics(given: Iterable[str] | None) -> tuple[Topic, ...]:
    """`id=Label` or `id=Label:sensitive`, one per --topic."""
    return tuple(_parse_topic(text) for text in given or ())


def parse_sources(given: str | None) -> tuple[str, ...]:
    """The sources to turn on. The wiki is always one of them."""
    asked = {name.strip() for name in (given or "").split(",") if name.strip()}
    unknown = sorted(asked - set(SOURCES))
    if unknown:
        raise UsageError(
            f"--sources does not know: {', '.join(unknown)}. Choose from {', '.join(SOURCES)}."
        )
    return tuple(name for name in SOURCES if name == "wiki" or name in asked)


def _topic_entry(topic: Topic) -> dict[str, Any]:
    entry: dict[str, Any] = {"id": topic.id, "label": topic.label}
    return {**entry, "sensitive": True} if topic.sensitive else entry


def build_config(answers: Answers, repo: str) -> dict[str, Any]:
    """The engine.yaml mapping for these answers. Not yet validated."""
    on = set(answers.sources)
    return {
        "version": 1,
        "engine": {
            "id": answers.engine_id,
            "name": answers.engine_name,
            "owner": {
                "email": answers.owner_email,
                "names": list(answers.owner_names),
                "emails": [answers.owner_email],
            },
        },
        "domains": [_topic_entry(topic) for topic in answers.topics],
        "tagging": {"prefix": "kx/", "frontmatter_key": "domains"},
        "sources": {
            "wiki": {"enabled": True, "repo": repo, "default_domain": None},
            "drive": {
                "enabled": "drive" in on,
                "default_domain": None,
                "include_mime": ["docs", "sheets", "slides"],
            },
            "fireflies": {
                "enabled": "fireflies" in on,
                "default_domain": None,
                "channels": {},
                "write_meeting_pages": True,
                "shared_meetings": {"enabled": False, "trusted_domains": []},
            },
            "gmail": {"enabled": "gmail" in on, "prefix": None},
        },
        "support": {"care_plan": {"enabled": False}},
    }


def validate(config: Mapping[str, Any]) -> Any:
    """The validated config, or a KbeError that lists every problem."""
    from knowledge import engine_config

    try:
        return engine_config.validate(config)
    except engine_config.ConfigurationError as error:
        raise KbeError(f"These answers do not make a valid Engine config.\n{error}") from error


def render_yaml(config: Mapping[str, Any]) -> str:
    """The file's text: a short header, then the config."""
    try:
        import yaml
    except ImportError as error:
        raise KbeError(
            "PyYAML is not installed. Run: pip install -r pullers/requirements.txt"
        ) from error
    body = yaml.safe_dump(dict(config), sort_keys=False, allow_unicode=True, default_flow_style=False)
    return f"{_HEADER}{body}"
