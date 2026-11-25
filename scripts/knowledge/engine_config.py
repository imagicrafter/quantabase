"""The Engine config (`.kb-engine/engine.yaml` in the owner's knowledge repo).

One file, two validators that must agree: this one and
`engine/src/config/engine-config.ts` (zod). `config/schema.json` is generated
from the zod schema; `config/engine.example.yaml` must pass both.

Where the config comes from, in order:
  1. the file named by the `KB_ENGINE_CONFIG` environment variable
     (development and tests),
  2. the database: `workspace.engine_config_get()` as the `kb_ingest` role,
  3. otherwise a `ConfigurationError` that says what to do.

It is loaded once per process, on first use -- never at import time. The
`dashboard` section belongs to the status page; here it is only checked to be
a mapping and is otherwise passed through untouched.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from . import engine_config_schema
from .engine_config_gmail import Mailbox, read_mailboxes
from .kb_schema import db

UNCLASSIFIED = "unclassified"
CONFIG_ENV_VAR = "KB_ENGINE_CONFIG"

_SLUG = re.compile(r"^[a-z][a-z0-9-]*$")
_EMAIL = engine_config_schema.EMAIL  # the service's own rule, shared
_REPO = re.compile(r"^[\w.-]+/[\w.-]+$")
_HOSTNAME = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
_MIME_KINDS = ("docs", "sheets", "slides")
# `pdf` is opt-in: allowed, but not part of the default.
_MIME_ALLOWED = (*_MIME_KINDS, "pdf")
_TAG_TRUST = ("owner", "anyone")
_MISSING = object()


class ConfigurationError(RuntimeError):
    """Required configuration is missing, unreadable or invalid."""


@dataclass(frozen=True)
class Owner:
    email: str
    names: tuple[str, ...] = ()
    emails: tuple[str, ...] = ()


@dataclass(frozen=True)
class Domain:
    id: str
    label: str
    sensitive: bool = False


@dataclass(frozen=True)
class Tagging:
    prefix: str = "kx/"
    frontmatter_key: str = "domains"


@dataclass(frozen=True)
class WikiSource:
    enabled: bool = False
    repo: str | None = None
    default_domain: str | None = None


@dataclass(frozen=True)
class DriveSource:
    enabled: bool = False
    default_domain: str | None = None
    include_mime: tuple[str, ...] = _MIME_KINDS
    # Whose description tags count: `owner` = only on items the signed-in
    # Drive account owns; `anyone` = on every item it can see.
    trust_tags_from: str = "owner"


@dataclass(frozen=True)
class FirefliesSource:
    enabled: bool = False
    default_domain: str | None = None
    channels: Mapping[str, str] = field(default_factory=dict)
    write_meeting_pages: bool = True
    shared_meetings_enabled: bool = False
    # The only organizer email domains whose shared meetings are ingested.
    shared_trusted_domains: tuple[str, ...] = ()


@dataclass(frozen=True)
class GmailSource:
    enabled: bool = False
    prefix: str | None = None
    # Empty means one mailbox, the Engine owner's (engine_config_gmail.py).
    mailboxes: tuple[Mailbox, ...] = ()


@dataclass(frozen=True)
class Sources:
    wiki: WikiSource = WikiSource()
    drive: DriveSource = DriveSource()
    fireflies: FirefliesSource = FirefliesSource()
    gmail: GmailSource = GmailSource()


@dataclass(frozen=True)
class DistillModel:
    backend: str = "do"
    id: str = "openai-gpt-oss-120b"


@dataclass(frozen=True)
class EngineConfig:
    engine_id: str
    engine_name: str
    owner: Owner
    domains: tuple[Domain, ...] = ()
    tagging: Tagging = Tagging()
    sources: Sources = Sources()
    distill: DistillModel = DistillModel()
    care_plan_enabled: bool = False
    dashboard: Mapping[str, Any] | None = None
    version: int = 1

    @property
    def domain_ids(self) -> tuple[str, ...]:
        """Declared topics plus `unclassified`, which always exists."""
        return tuple(d.id for d in self.domains) + (UNCLASSIFIED,)

    @property
    def sensitive_domain_ids(self) -> frozenset[str]:
        """Topics that need a deliberate grant. `unclassified` always is one."""
        return frozenset(d.id for d in self.domains if d.sensitive) | {UNCLASSIFIED}

    @property
    def owner_emails(self) -> frozenset[str]:
        owner = self.owner
        return frozenset(e.lower() for e in (owner.email, *owner.emails))

    @property
    def owner_names(self) -> frozenset[str]:
        return frozenset(" ".join(n.lower().split()) for n in self.owner.names)

    @property
    def owner_handle(self) -> str:
        """The owner principal's handle: the part of the email before the @."""
        return self.owner.email.split("@", 1)[0].lower()


# --- validation -------------------------------------------------------------


class _Reader:
    """Reads one mapping, recording every problem instead of stopping at one."""

    def __init__(self, node: Any, path: str, problems: list[str]):
        self.path = path
        self.problems = problems
        self.node: Mapping[str, Any] = node if isinstance(node, Mapping) else {}
        if node is not None and not isinstance(node, Mapping):
            problems.append(f"{path or 'config'}: must be a mapping")

    def _at(self, key: str) -> str:
        return f"{self.path}.{key}" if self.path else key

    def only(self, *allowed: str) -> None:
        for key in self.node:
            if key not in allowed:
                self.problems.append(f"{self._at(str(key))}: unknown key")

    def child(self, key: str) -> "_Reader":
        return _Reader(self.node.get(key), self._at(key), self.problems)

    def get(self, key: str, kind: type, default: Any = _MISSING) -> Any:
        value = self.node.get(key, _MISSING)
        if value is _MISSING or (value is None and default is None):
            if default is _MISSING:
                self.problems.append(f"{self._at(key)}: required")
                return kind()
            return default
        # bool is an int in Python; never accept one for the other.
        ok = isinstance(value, kind) and (kind is bool or not isinstance(value, bool))
        if not ok:
            self.problems.append(f"{self._at(key)}: must be a {kind.__name__}")
            return kind() if default is _MISSING else default
        return value

    def text(self, key: str, default: Any = _MISSING, pattern=None, hint="") -> Any:
        value = self.get(key, str, default)
        if isinstance(value, str) and value is not default:
            if not value:
                self.problems.append(f"{self._at(key)}: must not be empty")
            elif pattern is not None and not pattern.fullmatch(value):
                self.problems.append(f"{self._at(key)}: {hint}")
        return value

    def texts(self, key: str, default: tuple, pattern=None, hint="") -> tuple[str, ...]:
        value = self.get(key, list, list(default))
        items = tuple(value)
        for index, item in enumerate(items):
            if not isinstance(item, str) or not item:
                self.problems.append(f"{self._at(key)}.{index}: must be text")
            elif pattern is not None and not pattern.fullmatch(item):
                self.problems.append(f"{self._at(key)}.{index}: {hint}")
        return items


def _prefix_problem(prefix: str | None) -> str | None:
    if prefix is None:
        return None
    if not prefix:
        return "prefix must not be empty"
    if prefix[-1].isascii() and prefix[-1].isalnum():
        return 'prefix must end in a separator such as "/" or "-"'
    return None


def _read_owner(r: _Reader) -> Owner:
    r.only("email", "names", "emails")
    return Owner(
        email=r.text("email", pattern=_EMAIL, hint="must be an email address"),
        names=r.texts("names", ()),
        emails=r.texts("emails", (), _EMAIL, "must be an email address"),
    )


def _read_domains(raw: Any, problems: list[str]) -> tuple[Domain, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        problems.append("domains: must be a list")
        return ()
    domains = []
    for index, item in enumerate(raw):
        r = _Reader(item, f"domains.{index}", problems)
        r.only("id", "label", "sensitive")
        hint = "use lower-case letters, digits and dashes"
        domains.append(
            Domain(
                id=r.text("id", pattern=_SLUG, hint=hint),
                label=r.text("label"),
                sensitive=r.get("sensitive", bool, False),
            )
        )
    return tuple(domains)


def _read_sources(r: _Reader) -> Sources:
    r.only("wiki", "drive", "fireflies", "gmail")
    wiki, drive, ff, gmail = (r.child(k) for k in ("wiki", "drive", "fireflies", "gmail"))
    wiki.only("enabled", "repo", "default_domain")
    drive.only("enabled", "default_domain", "include_mime", "trust_tags_from")
    ff.only("enabled", "default_domain", "channels", "write_meeting_pages", "shared_meetings")
    gmail.only("enabled", "prefix", "mailboxes")
    shared = ff.child("shared_meetings")
    shared.only("enabled", "trusted_domains")

    mime = drive.texts("include_mime", _MIME_KINDS)
    for kind in mime:
        if isinstance(kind, str) and kind not in _MIME_ALLOWED:
            r.problems.append(f"sources.drive.include_mime: unknown kind {kind!r}")
    trust = drive.get("trust_tags_from", str, "owner")
    if trust not in _TAG_TRUST:
        r.problems.append("sources.drive.trust_tags_from: must be owner or anyone")
        trust = "owner"
    channels = ff.get("channels", dict, {})
    mail_prefix = gmail.get("prefix", str, None)
    if (problem := _prefix_problem(mail_prefix)) is not None:
        r.problems.append(f"sources.gmail.prefix: {problem}")

    return Sources(
        wiki=WikiSource(
            enabled=wiki.get("enabled", bool, False),
            repo=wiki.text("repo", None, _REPO, "use owner/name"),
            default_domain=wiki.get("default_domain", str, None),
        ),
        drive=DriveSource(
            enabled=drive.get("enabled", bool, False),
            default_domain=drive.get("default_domain", str, None),
            include_mime=mime,
            trust_tags_from=trust,
        ),
        fireflies=FirefliesSource(
            enabled=ff.get("enabled", bool, False),
            default_domain=ff.get("default_domain", str, None),
            channels=dict(channels),
            write_meeting_pages=ff.get("write_meeting_pages", bool, True),
            shared_meetings_enabled=shared.get("enabled", bool, False),
            shared_trusted_domains=shared.texts(
                "trusted_domains", (), _HOSTNAME, "must be a domain such as example.com"
            ),
        ),
        gmail=GmailSource(
            enabled=gmail.get("enabled", bool, False),
            prefix=mail_prefix,
            mailboxes=read_mailboxes(
                gmail.node.get("mailboxes"), "sources.gmail.mailboxes", r.problems
            ),
        ),
    )


def _cross_field_problems(config: EngineConfig) -> list[str]:
    ids = [d.id for d in config.domains]
    declared = set(ids)
    src = config.sources
    refs = [
        ("sources.wiki.default_domain", src.wiki.default_domain),
        ("sources.drive.default_domain", src.drive.default_domain),
        ("sources.fireflies.default_domain", src.fireflies.default_domain),
        *(
            (f"sources.fireflies.channels.{name}", topic)
            for name, topic in src.fireflies.channels.items()
        ),
    ]
    problems = [
        f'domains: topic "{i}" is declared twice'
        for i in sorted({i for i in ids if ids.count(i) > 1})
    ]
    if UNCLASSIFIED in declared:
        problems.append(f'domains: "{UNCLASSIFIED}" is reserved and always exists')
    problems.extend(
        f'{path}: "{topic}" is not a declared topic'
        for path, topic in refs
        if topic is not None and topic not in declared
    )
    if src.wiki.enabled and not src.wiki.repo:
        problems.append("sources.wiki.repo: needed when the wiki source is enabled")
    return problems


def _with_schema_problems(raw: Any, problems: list[str]) -> list[str]:
    """Add what config/schema.json finds, and the dashboard's cross-field rules.

    The schema is generated from the service's own validator, so this is where
    the two agree on every key (the `dashboard` section included) and on a
    section written as `null`. A path this module already reported is not
    reported a second time in other words.
    """
    try:
        found = engine_config_schema.schema_problems(raw)
    except engine_config_schema.SchemaUnavailable as error:
        raise ConfigurationError(f"The config cannot be checked: {error}.") from error
    already = {line.split(":", 1)[0] for line in problems}
    added = [line for line in found if line.split(":", 1)[0] not in already]
    dashboard_ok = not any(line.startswith("dashboard") for line in found)
    extra = engine_config_schema.dashboard_problems(raw) if dashboard_ok else []
    return [*problems, *added, *extra]


def validate(raw: Any) -> EngineConfig:
    """Validate a parsed config. Raises ConfigurationError listing every problem."""
    problems: list[str] = []
    top = _Reader(raw, "", problems)
    top.only(
        "version", "engine", "domains", "tagging", "sources", "models",
        "dashboard", "support",
    )
    if top.node.get("version") != 1 or isinstance(top.node.get("version"), bool):
        problems.append("version: must be 1")

    engine = top.child("engine")
    engine.only("id", "name", "owner")
    tagging = top.child("tagging")
    tagging.only("prefix", "frontmatter_key")
    models = top.child("models")
    models.only("distill")
    distill = models.child("distill")
    distill.only("backend", "id")
    support = top.child("support")
    support.only("care_plan")
    care = support.child("care_plan")
    care.only("enabled")
    dashboard = top.node.get("dashboard")
    if dashboard is not None and not isinstance(dashboard, Mapping):
        problems.append("dashboard: must be a mapping")

    prefix = tagging.get("prefix", str, "kx/")
    if (problem := _prefix_problem(prefix)) is not None:
        problems.append(f"tagging.prefix: {problem}")

    config = EngineConfig(
        engine_id=engine.text("id", pattern=_SLUG, hint="use lower-case letters, digits and dashes"),
        engine_name=engine.text("name"),
        owner=_read_owner(engine.child("owner")),
        domains=_read_domains(top.node.get("domains"), problems),
        tagging=Tagging(prefix=prefix, frontmatter_key=tagging.text("frontmatter_key", "domains")),
        sources=_read_sources(top.child("sources")),
        distill=DistillModel(
            backend=distill.text("backend", "do"),
            id=distill.text("id", "openai-gpt-oss-120b"),
        ),
        care_plan_enabled=care.get("enabled", bool, False),
        dashboard=dashboard if isinstance(dashboard, Mapping) else None,
    )
    problems.extend(_cross_field_problems(config))
    problems = _with_schema_problems(raw, problems)
    if problems:
        listed = "\n".join(f"  {p}" for p in problems)
        raise ConfigurationError(f"engine config is invalid:\n{listed}")
    return config


def parse(text: str) -> EngineConfig:
    """Parse and validate YAML text."""
    import yaml

    try:
        raw = engine_config_schema.load_yaml(text)
    except yaml.YAMLError as error:
        raise ConfigurationError(f"engine config is not valid YAML: {error}") from error
    return validate(raw)


# --- loading ----------------------------------------------------------------

_cached: EngineConfig | None = None


def _load_from_file(path: str) -> EngineConfig:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigurationError(
            f"{CONFIG_ENV_VAR} names {path}, which could not be read: {error}"
        ) from error
    return parse(text)


def _load_from_database() -> EngineConfig:
    from .supabase_client import get_supabase_ingest

    try:
        resp = db(get_supabase_ingest()).rpc("engine_config_get").execute()
    except ConfigurationError:
        raise
    except Exception as error:  # noqa: BLE001 - any transport/driver failure
        raise ConfigurationError(
            "Could not read the Engine config from the database "
            f"(engine_config_get): {type(error).__name__}. "
            f"Set {CONFIG_ENV_VAR} to a config file to work without one."
        ) from error
    if not resp.data:
        raise ConfigurationError(
            "No Engine config has been applied to this database yet. Apply "
            f".kb-engine/engine.yaml, or set {CONFIG_ENV_VAR} to a config file."
        )
    return validate(resp.data)


def get_config() -> EngineConfig:
    """The Engine config, loaded on first use and cached for the process."""
    global _cached
    if _cached is None:
        path = os.environ.get(CONFIG_ENV_VAR)
        _cached = _load_from_file(path) if path else _load_from_database()
    return _cached


def use_config(config: EngineConfig) -> None:
    """Make `config` the one this process uses from now on.

    For the wiki puller, right after it applied a newer config to the
    database: the rest of the run must work under the config now in force.
    """
    global _cached
    _cached = config


def set_config_for_tests(config: EngineConfig | None) -> None:
    """Test helper: inject a config, or pass None to clear the cache."""
    global _cached
    _cached = config
