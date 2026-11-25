"""The parts `kbe access setup` is made of: the wait, the spec, the app's answers, the token."""

from __future__ import annotations

import json

import pytest

from kbe import deploy_doctl, deploy_secrets, proc, setup_app, setup_http, token_input
from kbe.errors import KbeError, UsageError
from kbe.tests.helpers import FakeRunner

APP_ID = "123e4567-e89b-12d3-a456-426614174000"
ENCRYPTED = "EV[1:abcdefgh:ciphertext]"
TOKEN = "cfat_" + "Qw3rTy7uIo" * 4 + "deadbeef"


def _clock():
    at = [0.0]
    return setup_app.Clock(now=lambda: at[0], sleep=lambda s: at.__setitem__(0, at[0] + s))


def _doctl(apps):
    """A doctl whose `apps get` answers with each item of `apps` in turn (the last repeats)."""
    left = list(apps)

    def get(_argv, _stdin):
        item = left.pop(0) if len(left) > 1 else left[0]
        return proc.ProcResult(0, json.dumps([{"id": APP_ID, **item}]), "")

    return deploy_doctl.Doctl(FakeRunner({"doctl apps get": get}))


def _started(coming="", before=""):
    return setup_app.Started(deploy_doctl.App(id=APP_ID, coming_id=coming), before)


ACTIVE_1 = {"active_deployment": {"id": "d1", "phase": "ACTIVE"}}
BUILDING_2 = {**ACTIVE_1, "in_progress_deployment": {"id": "d2", "phase": "BUILDING"}}
QUEUED_2 = {**ACTIVE_1, "pending_deployment": {"id": "d2", "phase": "PENDING_BUILD"}}
ACTIVE_2 = {"active_deployment": {"id": "d2", "phase": "ACTIVE"}}
NO_IDS = {"active_deployment": {"phase": "ACTIVE"}}
NO_IDS_BUSY = {**NO_IDS, "in_progress_deployment": {"phase": "DEPLOYING"}}


# --- the wait -------------------------------------------------------------------------


def test_it_waits_for_the_very_deployment_it_started():
    seen = []
    doctl = _doctl([QUEUED_2, BUILDING_2, BUILDING_2, ACTIVE_2])
    setup_app.wait_until_live(doctl, APP_ID, _started("d2", "d1"), seen.append, 5, _clock())
    assert seen[-1] == "  The deployment is live."
    assert any("PENDING_BUILD" in line for line in seen)
    assert sum("BUILDING" in line for line in seen) == 1  # said once, not every look


def test_an_active_app_that_is_still_the_old_deployment_is_not_live():
    doctl = _doctl([ACTIVE_1])
    with pytest.raises(KbeError, match="did not go live"):
        setup_app.wait_until_live(doctl, APP_ID, _started("d2", "d1"), lambda _l: None, 5, _clock())


def test_without_a_target_id_a_new_active_deployment_counts():
    doctl = _doctl([BUILDING_2, ACTIVE_2])
    setup_app.wait_until_live(doctl, APP_ID, _started("", "d1"), lambda _l: None, 5, _clock())


def test_a_doctl_that_gives_no_ids_is_live_once_it_was_busy_and_no_longer_is():
    doctl = _doctl([NO_IDS, NO_IDS_BUSY, NO_IDS])
    setup_app.wait_until_live(doctl, APP_ID, _started(), lambda _l: None, 5, _clock())


def test_it_gives_up_after_the_time_allowed():
    doctl = _doctl([BUILDING_2])
    with pytest.raises(KbeError, match="not live after 2 minutes"):
        setup_app.wait_until_live(doctl, APP_ID, _started("d2", "d1"), lambda _l: None, 2, _clock())


def test_setting_the_code_needs_the_app_to_declare_it():
    runner = FakeRunner({"doctl apps spec get": proc.ProcResult(0, "name: x\nservices: []\n", "")})
    with pytest.raises(KbeError, match="does not declare the secret SETUP_CODE"):
        setup_app.set_code(deploy_doctl.Doctl(runner), APP_ID, "c" * 43)
    assert setup_app.clear_code(deploy_doctl.Doctl(runner), APP_ID) is False
    assert not any("update" in line for line in runner.lines())


# --- the spec -------------------------------------------------------------------------


def test_cleared_drops_one_value_and_changes_nothing_else():
    live = {
        "name": "acme", "envs": [{"key": "SETUP_CODE", "value": "plain, not a secret"}],
        "services": [{"name": "kb-engine", "envs": [
            {"key": "SETUP_CODE", "type": "SECRET", "scope": "RUN_TIME", "value": ENCRYPTED},
            {"key": "EMBED_TOKEN", "type": "SECRET", "value": ENCRYPTED},
        ]}],
        "jobs": [{"name": "puller-wiki", "envs": [
            {"key": "GITHUB_TOKEN", "type": "SECRET", "value": ENCRYPTED}]}],
    }
    before = json.dumps(live, sort_keys=True)
    out = deploy_secrets.cleared(live, "SETUP_CODE")
    assert out["services"][0]["envs"][0] == {
        "key": "SETUP_CODE", "type": "SECRET", "scope": "RUN_TIME"}
    assert out["services"][0]["envs"][1] == live["services"][0]["envs"][1]
    assert out["jobs"] == live["jobs"] and out["envs"] == live["envs"]
    assert json.dumps(live, sort_keys=True) == before  # the input is not changed
    assert deploy_secrets.declares(out, "SETUP_CODE")


# --- the app's answers ----------------------------------------------------------------


class Reply:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


def _api(status, body, hidden=None):
    return setup_http.SetupApi(
        "app-abc12.ondigitalocean.app", hidden or {}, lambda *_a: Reply(status, body))


@pytest.mark.parametrize("host", [
    "", "engine.example.com", "evil.ondigitalocean.app.example.com",
    "a.b.ondigitalocean.app", "app-1.ondigitalocean.app/x", "user@app-1.ondigitalocean.app",
])
def test_only_a_plain_ondigitalocean_app_address_is_called(host):
    with pytest.raises(KbeError, match="ondigitalocean.app"):
        setup_http.check_host(host)
    assert setup_http.check_host(" App-1.OnDigitalOcean.app ") == "app-1.ondigitalocean.app"


def test_redirects_are_not_followed(monkeypatch):
    import requests

    seen = {}
    monkeypatch.setattr(requests, "post", lambda url, **kw: seen.update(kw, url=url) or "sent")
    assert setup_http._default_post("https://x", {"a": "b"}, {"Accept": "j"}, 30) == "sent"
    assert seen["allow_redirects"] is False and seen["timeout"] == 30
    assert seen["data"] == {"a": "b"}


def test_a_preview_without_signed_choices_is_not_a_preview():
    for body in ({"ok": True, "plan": {"steps": []}},
                 {"ok": True, "plan": {}, "inputs": "x", "sig": "not-hex"}):
        with pytest.raises(KbeError, match="did not answer with data"):
            _api(200, body).preview("code", {})


def test_a_refusal_keeps_the_app_s_words_and_no_more():
    body = {"ok": False, "title": "Setup is closed", "message": "Reopen setup first.",
            "errors": ["one", 2, "three"], "extra": "ignored"}
    with pytest.raises(setup_http.Refused) as caught:
        _api(409, body).preview("code", {})
    assert str(caught.value) == "Setup is closed. Reopen setup first. one three"
    assert caught.value.status == 409


def test_text_from_the_app_is_cleaned_cut_and_redacted():
    secret = "s3cret-value-123456"
    steps = [{"title": "T\x1b[31m" + secret, "lines": ["x" * 5000], "status": "weird"}] * 100
    body = {"ok": True, "inputs": "p", "sig": "0" * 64,
            "plan": {"host": "h", "level": "owner", "connector_url": "u", "steps": steps}}
    preview = _api(200, body, {"S": secret}).preview("code", {})
    assert len(preview.steps) == 60
    first = preview.steps[0]
    assert "\x1b" not in first.title and secret not in first.title
    assert len(first.lines[0]) == 2000 and first.status == ""
    assert "inputs" not in repr(preview) and "sig=" not in repr(preview)


def test_an_apply_answer_without_steps_is_a_refusal():
    with pytest.raises(setup_http.Refused, match="Setup is locked"):
        _api(429, {"ok": False, "title": "Setup is locked", "message": "Wait."}).apply(
            "code", TOKEN, setup_http.Preview("h", "owner", "u", (), "p", "0" * 64))


# --- the token ------------------------------------------------------------------------


@pytest.mark.parametrize("text, ok", [
    (TOKEN, True), ("cfut_" + "a" * 48, True), ("A1b2C3d4E5" * 4, False),
    ("cfk_" + "a" * 48, False), ("cfut_" + "a" * 10, False), ("a" * 39, False),
    ("a" * 41, False), ("", False), (TOKEN + " x", False),
])
def test_what_counts_as_a_cloudflare_api_token(text, ok):
    assert (token_input.problem(text, {}, "the-setup-code") is None) is ok


def test_the_old_form_is_taken_only_when_asked_for():
    old = "A1b2C3d4E5" * 4
    assert token_input.problem(old, {}, "code") == token_input.NOT_A_TOKEN
    assert token_input.problem(old, {}, "code", legacy=True) is None
    assert token_input.problem("cfk_" + "a" * 36, {}, "code", legacy=True) is not None  # a key


def test_the_setup_code_and_local_values_are_never_taken_for_the_token():
    code = "c" * 40
    assert "setup code" in token_input.problem(code, {}, code, legacy=True)
    why = token_input.problem(TOKEN, {"B_KEY": TOKEN, "A_KEY": TOKEN, "C": "other"}, code)
    assert why == "holds the value of A_KEY, B_KEY from your env file, not the token"


def test_a_token_file_that_never_holds_a_token_is_refused(tmp_path):
    path = tmp_path / "token"
    src = token_input.source(None, str(path))
    with pytest.raises(UsageError, match="does not hold a Cloudflare API token"):
        token_input.wait_for(src, {}, "code", lambda _l: None, 1, _clock())
    path.write_text("x" * 10_000)
    assert src.read() == ""  # far too big to be a token: not read


def test_an_answer_that_is_not_data_is_said_plainly():
    class Page:
        def __init__(self, status):
            self.status_code = status

        def json(self):
            raise ValueError("a page, not JSON")

    for status, said in ((200, "did not answer with data"), (429, "answered HTTP 429 without data")):
        api = setup_http.SetupApi("app-abc12.ondigitalocean.app", {}, lambda *_a, s=status: Page(s))
        with pytest.raises(KbeError, match=said):
            api.preview("code", {})
