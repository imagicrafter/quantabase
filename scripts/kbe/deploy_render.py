"""Build a DigitalOcean App Platform spec from the template. No I/O but the template read.

`render(inputs)` returns the spec as a plain mapping:

  * the service, with its secrets declared and never given a value;
  * in SERVER MODE only, one scheduled job per source that is enabled in the
    Engine config (the Python pullers). Server mode is off unless asked for
    (`kbe deploy render --server-mode`); without it the spec has the service
    alone, as the "Deploy to DigitalOcean" button does (.do/deploy.template.yaml);
  * the Engine's hostname under `domains`.

The template is `engine/deploy/do-app-spec.template.yaml`. Its single job is a
pattern; this module copies it per source and adds that source's credentials.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from knowledge.kb_schema import DEFAULT_SCHEMA, SCHEMA_ENV_VAR

from .errors import KbeError, UsageError

# The public repository every Engine deploys from. The one place it is named.
ENGINE_CLONE_URL = "https://github.com/imagicrafter/quantabase.git"
STABLE_BRANCH = "stable"
TEMPLATE_PATH = Path(__file__).resolve().parents[2] / "engine" / "deploy" / (
    "do-app-spec.template.yaml"
)
SOURCE_ORDER = ("wiki", "drive", "fireflies", "gmail")
FIRST_RUN_MINUTE = 11 * 60  # 11:00 UTC
STAGGER_MINUTES = 20
MODEL_KEYS = {"do": "DO_INFERENCE_KEY", "anthropic": "ANTHROPIC_API_KEY"}
BASE_SWEEP = ("SUPABASE_", "KNOWLEDGE_")

_APP_NAME = re.compile(r"[a-z][a-z0-9-]{0,30}[a-z0-9]")
_REGION = re.compile(r"[a-z]{3}[0-9]?")
_HOST = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")
_GITHUB_SOURCE = re.compile(r"github:([\w.-]+/[\w.-]+)@([\w./-]+)")
_TEAM_DOMAIN = re.compile(r"https://[a-z0-9-]+\.cloudflareaccess\.com")
_AUD = re.compile(r"[A-Za-z0-9_-]{1,128}")

_SECRET_SOURCES = {
    "SUPABASE_URL": "Supabase dashboard -> Project Settings -> API -> Project URL",
    "SUPABASE_ANON_KEY": "Supabase dashboard -> Project Settings -> API -> anon key",
    "SUPABASE_JWT_SECRET": "Supabase dashboard -> Project Settings -> API -> JWT secret",
    "EMBED_TOKEN": "`python -m kbe tokens mint --embed --clipboard` "
                   "(the service's own principal)",
    "SETUP_CODE": "`python -m kbe access setup` sets it by itself (for the setup page "
                  "instead: `python -m kbe access init --clipboard`)",
    "KNOWLEDGE_EMBED_URL": "https://<project-ref>.supabase.co/functions/v1/embed "
                           "(after `python -m kbe db deploy-functions`)",
    "KNOWLEDGE_EMBED_TOKEN": "the same value as EMBED_TOKEN (`python -m kbe tokens mint "
                             "--embed --write-env` also puts it in your local env file)",
    "DO_INFERENCE_KEY": "DigitalOcean -> serverless inference -> model access key",
    "ANTHROPIC_API_KEY": "Anthropic console -> API keys",
    "GITHUB_TOKEN": "GitHub -> fine-grained token for the knowledge repo only "
                    "(contents: read and write)",
    "DRIVE_TOKEN_JSON_B64": "`python -m kbe sources drive auth` (the Drive token)",
    "DRIVE_TOKEN_CLIENT_JSON_B64": "`python -m kbe sources drive auth` (the OAuth client)",
    "FIREFLIES_API_KEY": "Fireflies -> Settings -> Developer settings -> API key",
    "GMAIL_TOKEN_JSON_B64": "`python -m kbe sources gmail auth` (the Gmail sign-in, read-only)",
}


@dataclass(frozen=True)
class Source:
    """Where every component builds from."""

    kind: str  # "git" (a public clone URL) or "github" (an authorised repo)
    repo: str
    branch: str


PUBLIC_SOURCE = Source("git", ENGINE_CLONE_URL, STABLE_BRANCH)


@dataclass(frozen=True)
class AccessEnv:
    """Sign-in settings kept in the app's environment instead of the database."""

    team_domain: str
    aud: str
    status_aud: str | None = None


@dataclass(frozen=True)
class Inputs:
    app_name: str
    region: str
    host: str
    config: Mapping[str, Any]
    source: Source = PUBLIC_SOURCE
    schema: str | None = None
    access_env: AccessEnv | None = None
    # The Python pullers as scheduled jobs. Off by default: sources come in
    # through each person's Claude and the curator runs inside the service.
    server_mode: bool = False


def parse_source(text: str | None) -> Source:
    """`None` or `public@<branch>` is the public repo; else `github:<owner/repo>@<branch>`."""
    if not text:
        return PUBLIC_SOURCE
    if text.startswith("public@") and re.fullmatch(r"[\w./-]+", text[7:]):
        return Source("git", ENGINE_CLONE_URL, text[7:])
    match = _GITHUB_SOURCE.fullmatch(text)
    if not match:
        raise UsageError(
            "--source must look like github:<owner>/<repo>@<branch> "
            "(leave it out to deploy the public repository)."
        )
    return Source("github", match.group(1), match.group(2))


def source_text(source: Source) -> str:
    """The form `parse_source` reads back; safe to keep in local state."""
    if source.kind == "git":
        return f"public@{source.branch}"
    return f"github:{source.repo}@{source.branch}"


def access_env(team_domain: str | None, aud: str | None, status_aud: str | None):
    """The optional environment sign-in settings, checked. None when not asked for."""
    if not team_domain and not aud:
        if status_aud:
            raise UsageError("--cf-status-aud needs --cf-team-domain and --cf-aud together.")
        return None
    if not team_domain or not aud:
        raise UsageError("--cf-team-domain and --cf-aud must be given together.")
    domain = team_domain.strip().rstrip("/")
    if not _TEAM_DOMAIN.fullmatch(domain):
        raise UsageError("The team domain must be https://<team>.cloudflareaccess.com")
    for name, value in (("--cf-aud", aud), ("--cf-status-aud", status_aud)):
        if value is not None and not _AUD.fullmatch(value):
            raise UsageError(f"{name} is not an AUD tag.")
    if status_aud and status_aud == aud:
        raise UsageError("--cf-status-aud must differ from --cf-aud.")
    return AccessEnv(domain, aud, status_aud or None)


def _check(inputs: Inputs) -> None:
    if not _APP_NAME.fullmatch(inputs.app_name or ""):
        raise UsageError(
            "The app name must be 2-32 characters: lower-case letters, digits and "
            "dashes, starting with a letter."
        )
    if not _REGION.fullmatch(inputs.region or ""):
        raise UsageError("The region must be a DigitalOcean region slug such as nyc or fra.")
    if not _HOST.fullmatch(inputs.host or ""):
        raise UsageError(
            "The hostname must be a bare lower-case name such as engine.example.com "
            "(no https://, no path)."
        )


def _load_template(path: Path) -> Mapping[str, Any]:
    try:
        import yaml

        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise KbeError(
            f"The spec template could not be read: {path} ({error.strerror})."
        ) from error
    except yaml.YAMLError as error:
        raise KbeError(f"The spec template {path} is not valid YAML.") from error
    usable = (
        isinstance(loaded, Mapping)
        and len(loaded.get("services") or []) == 1
        and len(loaded.get("jobs") or []) == 1
        and loaded.get("domains")
    )
    if not usable:
        raise KbeError(
            f"The spec template {path} is not usable: it needs one service, one job "
            "pattern and a domains entry."
        )
    return loaded


def _plain(key: str, value: str) -> dict[str, str]:
    return {"key": key, "value": value, "scope": "RUN_TIME"}


def _secret(key: str) -> dict[str, str]:
    return {"key": key, "type": "SECRET", "scope": "RUN_TIME"}


def _source_block(source: Source) -> dict[str, Any]:
    if source.kind == "git":
        return {"git": {"repo_clone_url": source.repo, "branch": source.branch}}
    return {"github": {"repo": source.repo, "branch": source.branch, "deploy_on_push": False}}


def _schema_envs(schema: str | None) -> list[dict[str, str]]:
    return [_plain(SCHEMA_ENV_VAR, schema)] if schema and schema != DEFAULT_SCHEMA else []


def _enabled_sources(config: Mapping[str, Any]) -> list[str]:
    sources = config.get("sources") or {}
    return [
        name for name in SOURCE_ORDER
        if isinstance(sources.get(name), Mapping) and sources[name].get("enabled") is True
    ]


def _model(config: Mapping[str, Any]) -> tuple[str, str, str]:
    """(backend, model id, name of the key the backend needs)."""
    distill = ((config.get("models") or {}).get("distill")) or {}
    backend = str(distill.get("backend") or "do")
    model_id = str(distill.get("id") or "openai-gpt-oss-120b")
    if backend not in MODEL_KEYS:
        raise KbeError(
            f'models.distill.backend is "{backend}", which a deployed job cannot run. '
            f"Use one of: {', '.join(sorted(MODEL_KEYS))}."
        )
    return backend, model_id, MODEL_KEYS[backend]


def _source_extras(name: str, config: Mapping[str, Any]) -> tuple[list[dict], tuple[str, ...]]:
    """One source's own envs and the names its start command must keep."""
    settings = (config.get("sources") or {}).get(name) or {}
    if name == "wiki":
        return [_secret("GITHUB_TOKEN")], ("GITHUB_TOKEN",)
    if name == "drive":
        keys = ("DRIVE_TOKEN_JSON_B64", "DRIVE_TOKEN_CLIENT_JSON_B64")
        return [*map(_secret, keys)], keys
    if name == "fireflies":
        # Meeting pages are pushed to the knowledge repo, which needs its token.
        pages = settings.get("write_meeting_pages", True) is not False
        repo = [_secret("GITHUB_TOKEN")] if pages else []
        return [_secret("FIREFLIES_API_KEY"), *repo], (
            "FIREFLIES_", *(("GITHUB_TOKEN",) if pages else ()))
    # Gmail: one secret, the read-only sign-in. Which threads are read is
    # decided by labels in the mailbox, not by any setting here.
    return [_secret("GMAIL_TOKEN_JSON_B64")], ("GMAIL_",)


def _cron(position: int) -> str:
    minute = FIRST_RUN_MINUTE + position * STAGGER_MINUTES
    return f"{minute % 60} {(minute // 60) % 24} * * *"


def _job(pattern: Mapping[str, Any], name: str, position: int, inputs: Inputs) -> dict[str, Any]:
    backend, model_id, model_key = _model(inputs.config)
    extras, extra_sweep = _source_extras(name, inputs.config)
    access = inputs.access_env
    signal = (
        [_plain("CF_ACCESS_TEAM_DOMAIN", access.team_domain), _plain("CF_ACCESS_AUD", access.aud)]
        if access else []
    )
    sweep = "|".join((*BASE_SWEEP, model_key, *extra_sweep, *(("CF_ACCESS_",) if access else ())))
    job = copy.deepcopy(dict(pattern))
    envs = [
        *job.get("envs", []),
        _secret(model_key),
        _plain("KNOWLEDGE_MODEL_BACKEND", backend),
        _plain("KNOWLEDGE_MODEL_ID", model_id),
        *extras, *signal, *_schema_envs(inputs.schema),
    ]
    return {
        **job,
        "name": f"puller-{name}",
        "schedule": {"cron": _cron(position)},
        **_source_block(inputs.source),
        "run_command": str(job["run_command"]).format(sweep=sweep, source=name),
        "envs": envs,
    }


def _service(pattern: Mapping[str, Any], inputs: Inputs) -> dict[str, Any]:
    access = inputs.access_env
    sign_in = []
    if access:
        sign_in = [
            _plain("CF_ACCESS_TEAM_DOMAIN", access.team_domain),
            _plain("CF_ACCESS_AUD", access.aud),
            _plain("OAUTH_RESOURCE_URL", f"https://{inputs.host}/mcp"),
            _plain("EXPECTED_HOST", inputs.host),
            *([_plain("CF_ACCESS_STATUS_AUD", access.status_aud)] if access.status_aud else []),
        ]
    service = copy.deepcopy(dict(pattern))
    return {
        **service,
        **_source_block(inputs.source),
        "envs": [*service.get("envs", []), *sign_in, *_schema_envs(inputs.schema)],
    }


def render(inputs: Inputs, template: Path | None = None) -> dict[str, Any]:
    """The spec for one deployment. Raises for inputs that cannot be deployed."""
    _check(inputs)
    loaded = _load_template(template or TEMPLATE_PATH)
    jobs = [
        _job(loaded["jobs"][0], name, position, inputs)
        for position, name in enumerate(_enabled_sources(inputs.config))
    ] if inputs.server_mode else []
    domain = {**copy.deepcopy(dict(loaded["domains"][0])), "domain": inputs.host}
    rest = {k: v for k, v in loaded.items() if k not in ("services", "jobs", "domains")}
    spec = {
        **copy.deepcopy(rest),
        "name": inputs.app_name,
        "region": inputs.region,
        "services": [_service(loaded["services"][0], inputs)],
        **({"jobs": jobs} if jobs else {}),
        "domains": [domain],
    }
    return spec


def skipped_sources(inputs: Inputs) -> list[str]:
    """Sources enabled in the config that get no job because server mode is off."""
    return [] if inputs.server_mode else _enabled_sources(inputs.config)


def components(spec: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    """(kind, component) for every service and job in a spec."""
    return [
        (kind, component)
        for kind in ("services", "jobs")
        for component in spec.get(kind) or []
        if isinstance(component, Mapping)
    ]


def secret_names(spec: Mapping[str, Any]) -> list[tuple[str, str]]:
    """(component name, variable name) for every secret the spec declares."""
    return [
        (str(component.get("name")), str(entry.get("key")))
        for _kind, component in components(spec)
        for entry in component.get("envs") or []
        if isinstance(entry, Mapping) and entry.get("type") == "SECRET"
    ]


def secret_source(key: str) -> str:
    """Where a person finds the value for one secret."""
    return _SECRET_SOURCES.get(key, "set by you; see .env.example for what it is")


def dump(spec: Mapping[str, Any]) -> str:
    """The spec as YAML, keys in the order they were built."""
    import yaml

    return yaml.safe_dump(dict(spec), sort_keys=False, default_flow_style=False, width=100)
