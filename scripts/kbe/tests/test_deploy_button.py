"""The "Deploy to DigitalOcean" button: .do/deploy.template.yaml, the Dockerfile and the README.

`doctl apps spec validate` needs the DigitalOcean API, so these checks hold the
template to the parts of the app spec schema it uses, offline.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from kbe import deploy_render as dr

ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / ".do" / "deploy.template.yaml"
DOCKERFILE = ROOT / "Dockerfile"
DOCKERIGNORE = ROOT / ".dockerignore"

# The app spec keys this template may use (DigitalOcean App Platform spec).
SPEC_KEYS = {"name", "region", "alerts", "services"}
SERVICE_KEYS = {
    "name", "git", "github", "dockerfile_path", "source_dir", "http_port", "instance_count",
    "instance_size_slug", "health_check", "envs", "run_command", "build_command",
}
ENV_KEYS = {"key", "value", "scope", "type"}
REGIONS = {"nyc", "ams", "sfo", "sgp", "lon", "fra", "tor", "blr", "syd"}


def _spec() -> dict:
    loaded = yaml.safe_load(TEMPLATE.read_text(encoding="utf-8"))
    assert set(loaded) == {"spec"}, "the button reads a template wrapped in `spec:`"
    return loaded["spec"]


def _envs(service: dict) -> dict:
    return {e["key"]: e for e in service["envs"]}


def test_one_service_and_nothing_else():
    spec = _spec()
    assert set(spec) <= SPEC_KEYS
    assert spec["region"] in REGIONS
    assert re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]", spec["name"])
    assert len(spec["services"]) == 1
    for kind in ("jobs", "workers", "static_sites", "functions", "databases"):
        assert kind not in spec, f"the button deploys one service only, not {kind}"


def test_the_service_builds_the_root_dockerfile_from_the_public_repo():
    service = _spec()["services"][0]
    assert set(service) <= SERVICE_KEYS
    assert service["git"] == {"repo_clone_url": dr.ENGINE_CLONE_URL, "branch": dr.STABLE_BRANCH}
    assert service["dockerfile_path"] == "Dockerfile" and DOCKERFILE.is_file()
    assert service["source_dir"] == "/"
    assert service["http_port"] == 8080 and service["instance_count"] == 1
    assert service["health_check"]["http_path"] == "/health"


def test_asks_only_for_what_boot_needs_and_holds_no_secret_value():
    envs = _envs(_spec()["services"][0])
    for env in envs.values():
        assert set(env) <= ENV_KEYS and env["scope"] == "RUN_TIME"
    assert "value" not in envs["SUPABASE_URL"]
    for key in ("SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET"):
        assert envs[key]["type"] == "SECRET" and "value" not in envs[key]
    # The app makes its own one-time code; the embed token lives in Vault.
    for key in ("SETUP_CODE", "EMBED_TOKEN", "KB_SCHEMA", "DO_INFERENCE_KEY", "GITHUB_TOKEN"):
        assert key not in envs
    asked = {k for k, e in envs.items() if "value" not in e}
    assert asked == {"SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET"}
    assert envs["PORT"]["value"] == "8080"


def test_every_variable_the_service_requires_is_there():
    env_ts = (ROOT / "engine" / "src" / "env.ts").read_text(encoding="utf-8")
    required = {"SUPABASE_URL", "SUPABASE_JWT_SECRET", "SUPABASE_ANON_KEY"}
    for key in required:
        assert re.search(rf"^\s*{key}: z\.string\(\)", env_ts, re.M), key
    assert required <= set(_envs(_spec()["services"][0]))


def test_the_image_carries_what_the_database_screen_needs():
    text = DOCKERFILE.read_text(encoding="utf-8")
    for path in ("supabase/migrations", "supabase/functions/embed", "engine/templates",
                 "engine/public", "engine/package.json"):
        assert re.search(rf"^COPY .*\b{re.escape(path)} ", text, re.M), path
    assert re.search(r"^WORKDIR /app$", text, re.M)
    assert 'CMD ["node", "engine/dist/index.js"]' in text
    assert re.search(r"^USER node$", text, re.M)
    # db-setup.ts findRepoDir looks three folders above engine/dist/app/.
    db_setup = (ROOT / "engine" / "src" / "app" / "db-setup.ts").read_text(encoding="utf-8")
    assert 'new URL("../../../", import.meta.url)' in db_setup


def test_secrets_and_local_state_stay_out_of_the_build():
    ignored = DOCKERIGNORE.read_text(encoding="utf-8").split()
    for entry in (".env", ".env.*", ".git", ".venv", ".kb-engine-local"):
        assert entry in ignored


def test_readme_has_the_button_and_says_updates_need_a_redeploy():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    url = f"https://cloud.digitalocean.com/apps/new?repo=https://github.com/imagicrafter/quantabase/tree/{dr.STABLE_BRANCH}"
    assert url in readme
    assert "deploytodo.com/do-btn-blue.svg" in readme
    ops = (ROOT / "docs" / "operations.md").read_text(encoding="utf-8")
    assert "Force Rebuild and Deploy" in ops
