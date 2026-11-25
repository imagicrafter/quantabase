"""Updating a live app: secrets are carried over and never shown."""

from __future__ import annotations

import copy

from kbe import deploy_merge as dm

ENCRYPTED = "EV[1:abcdefgh:ciphertext-that-must-never-be-shown]"


def _spec(**changes):
    base = {
        "name": "acme-kb-engine",
        "region": "nyc",
        "envs": [{"key": "APP_WIDE", "type": "SECRET", "scope": "RUN_TIME"}],
        "services": [{
            "name": "kb-engine",
            "envs": [
                {"key": "SUPABASE_URL", "type": "SECRET", "scope": "RUN_TIME"},
                {"key": "SETUP_CODE", "type": "SECRET", "scope": "RUN_TIME"},
                {"key": "LOG_LEVEL", "value": "info", "scope": "RUN_TIME"},
            ],
        }],
        "jobs": [{
            "name": "puller-gmail",
            "envs": [
                {"key": "SUPABASE_URL", "type": "SECRET", "scope": "RUN_TIME"},
                {"key": "KNOWLEDGE_NOTE", "value": "", "scope": "RUN_TIME"},
            ],
        }],
    }
    return {**base, **changes}


def _live():
    live = copy.deepcopy(_spec())
    live["envs"][0]["value"] = ENCRYPTED + "-app"
    live["services"][0]["envs"][0]["value"] = ENCRYPTED + "-svc"
    live["services"][0]["envs"][2]["value"] = "debug"
    live["jobs"][0]["envs"][0]["value"] = ENCRYPTED + "-job"
    live["jobs"][0]["envs"][1]["value"] = "example.com"
    return live


def _env(spec, kind, key):
    return next(e for e in spec[kind][0]["envs"] if e["key"] == key)


def test_secret_values_are_carried_over_per_component():
    rendered = _spec()
    merged = dm.carry_over(rendered, _live())
    assert _env(merged, "services", "SUPABASE_URL")["value"] == ENCRYPTED + "-svc"
    assert _env(merged, "jobs", "SUPABASE_URL")["value"] == ENCRYPTED + "-job"
    assert merged["envs"][0]["value"] == ENCRYPTED + "-app"
    assert "value" not in _env(merged, "services", "SETUP_CODE")
    assert "value" not in _env(rendered, "services", "SUPABASE_URL"), "input was changed"


def test_plain_values_come_from_the_new_spec_except_blank_ones():
    merged = dm.carry_over(_spec(), _live())
    assert _env(merged, "services", "LOG_LEVEL")["value"] == "info"
    assert _env(merged, "jobs", "KNOWLEDGE_NOTE")["value"] == "example.com"


def test_a_secret_typed_in_plain_is_kept_as_a_secret_and_never_shown():
    live = _live()
    live["services"][0]["envs"][1] = {"key": "SETUP_CODE", "value": "typed-in-plain"}
    merged = dm.carry_over(_spec(), live)
    assert _env(merged, "services", "SETUP_CODE") == {
        "key": "SETUP_CODE", "type": "SECRET", "scope": "RUN_TIME", "value": "typed-in-plain"}
    shown = "\n".join(dm.diff(live, merged))
    assert "typed-in-plain" not in shown, "a plain live value of a secret must be masked"
    assert "typed-in-plain" not in str(dm.masked(live, dm.secret_keys(live, merged)))


def test_what_the_template_does_not_describe_is_kept():
    live = {**_live(), "ingress": {"rules": [{"match": {"path": {"prefix": "/"}}}]},
            "egress": {"type": "AUTOASSIGN"}}
    rendered = {k: v for k, v in _spec().items() if k != "envs"}
    merged = dm.carry_over(rendered, live)
    assert merged["ingress"] == live["ingress"] and merged["egress"] == live["egress"]
    assert merged["envs"] == live["envs"], "app-wide variables stay, values and all"
    assert merged["region"] == "nyc"
    assert "workers" not in dm.carry_over(rendered, {**live, "workers": [{"name": "w"}]}), \
        "a component is never kept silently; removed_components reports it"


def test_a_component_new_to_the_app_keeps_no_values():
    live = _live()
    live["jobs"] = []
    merged = dm.carry_over(_spec(), live)
    assert "value" not in _env(merged, "jobs", "SUPABASE_URL")


def test_same_name_in_another_kind_is_not_a_match():
    live = _live()
    live["workers"] = [{"name": "puller-gmail", "envs": live["jobs"][0]["envs"]}]
    live["jobs"] = []
    merged = dm.carry_over(_spec(), live)
    assert "value" not in _env(merged, "jobs", "SUPABASE_URL")


def test_removed_components_are_named():
    live = _live()
    live["jobs"].append({"name": "puller-drive", "envs": []})
    live["workers"] = [{"name": "old-worker"}]
    assert dm.removed_components(_spec(), live) == ["job puller-drive", "worker old-worker"]
    assert dm.removed_components(_spec(), _live()) == []


def test_diff_shows_plain_changes_and_never_a_secret_value():
    live = _live()
    merged = dm.carry_over(_spec(region="fra"), live)
    lines = dm.diff(live, merged)
    text = "\n".join(lines)
    assert "-region: nyc" in text and "+region: fra" in text
    assert "debug" in text and "info" in text
    assert "EV[" not in text and "ciphertext" not in text
    assert "(no value in the spec)" not in text  # unchanged lines are context at most


def test_no_changes_is_an_empty_diff():
    live = _live()
    live["services"][0]["envs"][2]["value"] = "info"
    assert dm.diff(live, dm.carry_over(_spec(), live)) == []


def test_masked_marks_set_and_unset_secrets():
    shown = dm.masked(dm.carry_over(_spec(), _live()))
    assert _env(shown, "services", "SUPABASE_URL")["value"] == "(hidden)"
    assert _env(shown, "services", "SETUP_CODE")["value"] == "(no value in the spec)"
    assert _env(shown, "services", "LOG_LEVEL")["value"] == "info"


def test_odd_shapes_do_not_crash():
    live = {"name": "x", "services": [{"name": "kb-engine"}, "junk"], "jobs": None}
    merged = dm.carry_over(_spec(), live)
    assert "value" not in _env(merged, "services", "SUPABASE_URL")
    assert dm.diff(live, merged)
