"""The rendered DigitalOcean spec: what is in it, and what never is."""

from __future__ import annotations

import copy
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from kbe import deploy_render as dr
from kbe.errors import KbeError, UsageError

ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / "engine" / "deploy" / "do-app-spec.template.yaml"
EXAMPLE = yaml.safe_load((ROOT / "config" / "engine.example.yaml").read_text(encoding="utf-8"))
# Built from pieces so this file does not itself hold the words it forbids.
FORBIDDEN = (
    "jus" + "tin", "mar" + "tins.net", "kw-environ" + "mental", "kw" + "env", "fleet" + "illo",
    "bla" + "ne", "ash" + "ley", "her" + "mes", "cra" + "ft", "for" + "ge", "arc" + "hon",
)
OWNER_WORD = "imagi" + "crafter"
TEAM_DOMAIN = "https://acme.cloudflareaccess.com"


def _config(**enabled) -> dict:
    config = copy.deepcopy(EXAMPLE)
    for name, on in enabled.items():
        config["sources"][name]["enabled"] = on
    return config


def _inputs(**changes) -> dr.Inputs:
    base = dict(app_name="acme-kb-engine", region="nyc", host="engine.example.com",
                config=_config(), server_mode=True)
    return dr.Inputs(**{**base, **changes})


def _envs(component) -> dict:
    return {entry["key"]: entry for entry in component["envs"]}


def _components(spec):
    return [*spec["services"], *spec.get("jobs", [])]


def test_template_is_valid_yaml_with_no_owner_value():
    text = TEMPLATE.read_text(encoding="utf-8")
    assert isinstance(yaml.safe_load(text), dict)
    lowered = text.lower()
    for word in (*FORBIDDEN, OWNER_WORD, "cloudflareaccess.com"):
        assert word not in lowered, word
    assert not re.search(r"\b[0-9a-f]{64}\b", lowered)
    assert "repo_clone_url" not in yaml.safe_load(text)["services"][0]


def test_basic_fields_and_domain():
    spec = dr.render(_inputs())
    assert spec["name"] == "acme-kb-engine"
    assert spec["region"] == "nyc"
    assert spec["domains"] == [
        {"domain": "engine.example.com", "type": "PRIMARY", "minimum_tls_version": "1.3"}
    ]
    assert [alert["rule"] for alert in spec["alerts"]] == ["DEPLOYMENT_FAILED", "DOMAIN_FAILED"]
    assert spec["services"][0]["health_check"]["http_path"] == "/health"


def test_default_source_is_the_public_repo_on_stable():
    spec = dr.render(_inputs())
    for component in _components(spec):
        assert component["git"] == {"repo_clone_url": dr.ENGINE_CLONE_URL, "branch": "stable"}
        assert "github" not in component


def test_github_source_switches_every_component():
    spec = dr.render(_inputs(source=dr.parse_source("github:acme/engine-fork@main")))
    for component in _components(spec):
        assert component["github"] == {
            "repo": "acme/engine-fork", "branch": "main", "deploy_on_push": False,
        }
        assert "git" not in component


@pytest.mark.parametrize("bad", ["acme/engine", "github:acme@main", "github:acme/engine",
                                 "github:acme/engine@", "gitlab:a/b@c", "github:a/b@c d"])
def test_bad_source_is_refused(bad):
    with pytest.raises(UsageError):
        dr.parse_source(bad)


def test_source_text_round_trips():
    assert dr.parse_source(None) == dr.PUBLIC_SOURCE
    assert dr.parse_source(dr.source_text(dr.PUBLIC_SOURCE)) == dr.PUBLIC_SOURCE
    fork = dr.parse_source("github:acme/engine-fork@main")
    assert dr.parse_source(dr.source_text(fork)) == fork


def test_every_secret_has_no_value_and_every_plain_entry_has_one():
    spec = dr.render(_inputs(config=_config(gmail=True)))
    for component in _components(spec):
        for entry in component["envs"]:
            assert entry["scope"] == "RUN_TIME"
            if entry.get("type") == "SECRET":
                assert "value" not in entry, entry["key"]
            else:
                assert "value" in entry and isinstance(entry["value"], str), entry["key"]
                assert "type" not in entry


def test_service_envs_default_has_no_sign_in_variables():
    service = _envs(dr.render(_inputs())["services"][0])
    secrets = sorted(key for key, entry in service.items() if entry.get("type") == "SECRET")
    assert secrets == ["EMBED_TOKEN", "SETUP_CODE", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET",
                       "SUPABASE_URL"]
    for name in ("PORT", "NODE_ENV", "LOG_LEVEL", "NODE_OPTIONS", "SOURCE_COMMIT"):
        assert name in service
    for name in ("CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "OAUTH_RESOURCE_URL",
                 "EXPECTED_HOST", "CF_ACCESS_STATUS_AUD", "KB_SCHEMA", "KB_ENGINE_CONFIG"):
        assert name not in service


def test_one_job_per_enabled_source_in_order_with_staggered_crons():
    spec = dr.render(_inputs(config=_config(gmail=True)))
    assert [job["name"] for job in spec["jobs"]] == [
        "puller-wiki", "puller-drive", "puller-fireflies", "puller-gmail"]
    assert [job["schedule"]["cron"] for job in spec["jobs"]] == [
        "0 11 * * *", "20 11 * * *", "40 11 * * *", "0 12 * * *"]
    assert all(job["kind"] == "SCHEDULED" for job in spec["jobs"])


def test_disabled_sources_get_no_job_and_crons_close_up():
    spec = dr.render(_inputs(config=_config(drive=False)))
    assert [job["name"] for job in spec["jobs"]] == ["puller-wiki", "puller-fireflies"]
    assert [job["schedule"]["cron"] for job in spec["jobs"]] == ["0 11 * * *", "20 11 * * *"]


def test_no_enabled_source_means_no_jobs_key():
    spec = dr.render(_inputs(config=_config(wiki=False, drive=False, fireflies=False)))
    assert "jobs" not in spec


def test_job_start_command_keeps_the_sweep_pattern():
    jobs = {job["name"]: job for job in dr.render(_inputs(config=_config(gmail=True)))["jobs"]}
    for name, job in jobs.items():
        source = name.removeprefix("puller-")
        first, second = job["run_command"].strip().splitlines()
        assert re.fullmatch(r"env \| grep -E '\^\([A-Z0-9_|]+\)\[A-Z0-9_\]\*=' > \.env", first)
        assert second == f"python -m pullers.runner --source {source}"
        assert "SUPABASE_|KNOWLEDGE_|DO_INFERENCE_KEY" in first
        assert job["build_command"] == "pip install -r pullers/requirements.txt"
        assert _envs(job)["PYTHONPATH"]["value"] == "/workspace/scripts:/workspace"
    assert "GITHUB_TOKEN" in jobs["puller-wiki"]["run_command"]
    assert "DRIVE_TOKEN_CLIENT_JSON_B64" in jobs["puller-drive"]["run_command"]
    assert "GMAIL_" in jobs["puller-gmail"]["run_command"]


def test_every_secret_a_job_declares_is_swept_into_its_env_file():
    for job in dr.render(_inputs(config=_config(gmail=True)))["jobs"]:
        pattern = re.search(r"grep -E '(.+)' >", job["run_command"]).group(1)
        for entry in job["envs"]:
            if entry.get("type") == "SECRET":
                assert re.match(pattern, f"{entry['key']}=x"), (job["name"], entry["key"])


def test_per_source_credentials():
    jobs = {job["name"]: _envs(job)
            for job in dr.render(_inputs(config=_config(gmail=True)))["jobs"]}
    assert jobs["puller-wiki"]["GITHUB_TOKEN"]["type"] == "SECRET"
    drive = jobs["puller-drive"]
    assert drive["DRIVE_TOKEN_JSON_B64"]["type"] == "SECRET"
    assert drive["DRIVE_TOKEN_CLIENT_JSON_B64"]["type"] == "SECRET"
    assert {key for key in drive if key.startswith("DRIVE_")} == {
        "DRIVE_TOKEN_JSON_B64", "DRIVE_TOKEN_CLIENT_JSON_B64"}, "no setting nothing reads"
    assert jobs["puller-fireflies"]["FIREFLIES_API_KEY"]["type"] == "SECRET"
    assert jobs["puller-fireflies"]["GITHUB_TOKEN"]["type"] == "SECRET"
    gmail = jobs["puller-gmail"]
    assert gmail["GMAIL_TOKEN_JSON_B64"]["type"] == "SECRET"
    assert {key for key in gmail if key.startswith("GMAIL_")} == {
        "GMAIL_TOKEN_JSON_B64"}, "the label is the only scope"
    assert "value" not in gmail["GMAIL_TOKEN_JSON_B64"]
    for envs in jobs.values():
        assert envs["KNOWLEDGE_MODEL_BACKEND"]["value"] == "do"
        assert envs["KNOWLEDGE_MODEL_ID"]["value"] == "openai-gpt-oss-120b"
        assert envs["DO_INFERENCE_KEY"]["type"] == "SECRET"
        assert "KB_ENGINE_CONFIG" not in envs


def test_gmail_is_not_deployed_unless_the_config_turns_it_on():
    off = dr.render(_inputs(config=_config()))
    assert "puller-gmail" not in [job["name"] for job in off["jobs"]]
    assert "GMAIL" not in dr.dump(off)
    on = dr.render(_inputs(config=_config(gmail=True)))
    assert "puller-gmail" in [job["name"] for job in on["jobs"]]
    assert ("puller-gmail", "GMAIL_TOKEN_JSON_B64") in dr.secret_names(on)
    assert "gmail auth" in dr.secret_source("GMAIL_TOKEN_JSON_B64")


def test_every_drive_and_gmail_job_setting_is_read_by_the_code():
    """A setting on a job that no program reads is a setting to remove."""
    from pathlib import Path

    from knowledge.connectors import drive_client
    from pullers import gmail

    jobs = {job["name"]: _envs(job)
            for job in dr.render(_inputs(config=_config(gmail=True)))["jobs"]}
    drive_keys = {key for key in jobs["puller-drive"] if key.startswith("DRIVE_")}
    assert drive_keys == {drive_client.TOKEN_KEY, drive_client.CLIENT_KEY}
    gmail_keys = {key for key in jobs["puller-gmail"] if key.startswith("GMAIL_")}
    assert gmail_keys == {gmail.TOKEN_KEY}
    assert "TOKEN_FILE" not in Path(dr.__file__).read_text(encoding="utf-8")


def test_fireflies_without_meeting_pages_needs_no_repo_token():
    config = _config()
    config["sources"]["fireflies"]["write_meeting_pages"] = False
    jobs = {job["name"]: _envs(job) for job in dr.render(_inputs(config=config))["jobs"]}
    assert "GITHUB_TOKEN" not in jobs["puller-fireflies"]


def test_anthropic_backend_uses_its_own_key():
    config = _config()
    config["models"] = {"distill": {"backend": "anthropic", "id": "some-model"}}
    for job in dr.render(_inputs(config=config))["jobs"]:
        envs = _envs(job)
        assert envs["ANTHROPIC_API_KEY"]["type"] == "SECRET"
        assert "DO_INFERENCE_KEY" not in envs
        assert "ANTHROPIC_API_KEY" in job["run_command"]
        assert envs["KNOWLEDGE_MODEL_ID"]["value"] == "some-model"


def test_a_backend_a_job_cannot_run_is_refused():
    config = _config()
    config["models"] = {"distill": {"backend": "agent_sdk", "id": "x"}}
    with pytest.raises(KbeError, match="agent_sdk"):
        dr.render(_inputs(config=config))


def test_schema_variable_only_when_not_the_default():
    for component in _components(dr.render(_inputs())):
        assert "KB_SCHEMA" not in _envs(component)
    for component in _components(dr.render(_inputs(schema="kb_acme"))):
        assert _envs(component)["KB_SCHEMA"] == {
            "key": "KB_SCHEMA", "value": "kb_acme", "scope": "RUN_TIME"}
    for component in _components(dr.render(_inputs(schema=dr.DEFAULT_SCHEMA))):
        assert "KB_SCHEMA" not in _envs(component)


def test_env_configured_mode_adds_plain_sign_in_values():
    access = dr.AccessEnv(team_domain=TEAM_DOMAIN, aud="aud-one", status_aud="aud-two")
    spec = dr.render(_inputs(access_env=access))
    service = _envs(spec["services"][0])
    assert service["CF_ACCESS_TEAM_DOMAIN"]["value"] == TEAM_DOMAIN
    assert service["CF_ACCESS_AUD"]["value"] == "aud-one"
    assert service["CF_ACCESS_STATUS_AUD"]["value"] == "aud-two"
    assert service["OAUTH_RESOURCE_URL"]["value"] == "https://engine.example.com/mcp"
    assert service["EXPECTED_HOST"]["value"] == "engine.example.com"
    for job in spec["jobs"]:
        envs = _envs(job)
        assert envs["CF_ACCESS_TEAM_DOMAIN"]["value"] == TEAM_DOMAIN
        assert envs["CF_ACCESS_AUD"]["value"] == "aud-one"
        assert "CF_ACCESS_STATUS_AUD" not in envs and "EXPECTED_HOST" not in envs
        assert "CF_ACCESS_" in job["run_command"]


def test_access_env_is_all_or_nothing_and_checked():
    assert dr.access_env(None, None, None) is None
    with pytest.raises(UsageError, match="together"):
        dr.access_env(TEAM_DOMAIN, None, None)
    with pytest.raises(UsageError, match="together"):
        dr.access_env(None, None, "aud-two")
    with pytest.raises(UsageError, match="team domain"):
        dr.access_env("http://acme.example.com", "aud-one", None)
    with pytest.raises(UsageError, match="differ"):
        dr.access_env(TEAM_DOMAIN, "aud-one", "aud-one")
    assert dr.access_env(TEAM_DOMAIN + "/", "aud-one", None).team_domain == TEAM_DOMAIN


@pytest.mark.parametrize("field,bad", [
    ("app_name", "Bad Name"), ("app_name", "x"), ("app_name", "a" * 40),
    ("region", "new york"), ("host", "https://engine.example.com"), ("host", "localhost"),
    ("host", "engine.example.com/mcp"), ("host", "Engine.Example.com"),
])
def test_bad_inputs_are_refused(field, bad):
    with pytest.raises(UsageError):
        dr.render(_inputs(**{field: bad}))


def test_render_does_not_change_its_inputs_or_share_state():
    inputs = _inputs()
    before = copy.deepcopy(inputs.config)
    first = dr.render(inputs)
    first["services"][0]["envs"].append({"key": "X"})
    second = dr.render(inputs)
    assert inputs.config == before
    assert "X" not in _envs(second["services"][0])


def test_secret_names_lists_every_secret_by_component():
    spec = dr.render(_inputs())
    names = dr.secret_names(spec)
    assert ("kb-engine", "SETUP_CODE") in names
    assert ("puller-wiki", "GITHUB_TOKEN") in names
    assert ("puller-drive", "DRIVE_TOKEN_JSON_B64") in names
    assert all(isinstance(pair, tuple) and len(pair) == 2 for pair in names)
    assert ("kb-engine", "PORT") not in names
    for _component, key in names:
        assert dr.secret_source(key), key
    assert dr.secret_source("SOMETHING_ELSE")


def test_dump_is_yaml_that_loads_back_and_holds_no_owner_word():
    spec = dr.render(_inputs(config=_config(gmail=True)))
    text = dr.dump(spec)
    assert yaml.safe_load(text) == spec
    assert OWNER_WORD in text.lower()  # only as the public clone URL:
    lowered = text.lower().replace(dr.ENGINE_CLONE_URL.lower(), "")
    for word in (*FORBIDDEN, OWNER_WORD):
        assert word not in lowered, word
    assert list(yaml.safe_load(text))[:2] == ["name", "region"]


def test_clone_url_is_written_in_one_place_only():
    hits = [
        path.name for path in (ROOT / "scripts" / "kbe").glob("deploy*.py")
        if OWNER_WORD in path.read_text(encoding="utf-8").lower()
    ]
    assert hits == ["deploy_render.py"]
    text = (ROOT / "scripts" / "kbe" / "deploy_render.py").read_text(encoding="utf-8")
    assert text.lower().count(OWNER_WORD) == 1


def test_missing_template_is_a_clear_error(tmp_path):
    with pytest.raises(KbeError, match="template"):
        dr.render(_inputs(), template=tmp_path / "none.yaml")
    broken = tmp_path / "broken.yaml"
    broken.write_text("name: x\n", encoding="utf-8")
    with pytest.raises(KbeError, match="template"):
        dr.render(_inputs(), template=broken)


def test_doctl_accepts_the_rendered_spec(tmp_path):
    """Schema check only: `--schema-only` makes no API call."""
    doctl = shutil.which("doctl")
    if not doctl:
        pytest.skip("doctl is not installed")
    access = dr.AccessEnv(team_domain=TEAM_DOMAIN, aud="aud-one", status_aud=None)
    for index, inputs in enumerate((
        _inputs(config=_config(gmail=True), schema="kb_acme"),
        _inputs(source=dr.parse_source("github:acme/engine-fork@main"), access_env=access),
    )):
        path = tmp_path / f"spec-{index}.yaml"
        path.write_text(dr.dump(dr.render(inputs)), encoding="utf-8")
        done = subprocess.run(
            [doctl, "apps", "spec", "validate", "--schema-only", str(path)],
            capture_output=True, text=True, timeout=60, check=False,
        )
        if done.returncode != 0 and "unknown flag" in done.stderr:
            pytest.skip("this doctl has no offline schema check")
        assert done.returncode == 0, done.stderr


def test_server_mode_is_off_by_default_and_then_there_are_no_jobs():
    inputs = dr.Inputs(app_name="acme-kb-engine", region="nyc", host="engine.example.com",
                       config=_config(wiki=True, drive=False, fireflies=True))
    spec = dr.render(inputs)
    assert "jobs" not in spec
    assert [s["name"] for s in spec["services"]] == ["kb-engine"]
    assert dr.skipped_sources(inputs) == ["wiki", "fireflies"]
    assert dr.skipped_sources(_inputs(config=_config(wiki=True))) == []
