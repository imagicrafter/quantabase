"""`kbe access setup`: one command, and no secret anywhere it can be seen.

doctl, the clipboard, the database and the app are all fakes. The fake app
follows the real one's rules: it accepts only the setup code that was last
set on it through `doctl apps update`, and only signed choices on apply.
"""

from __future__ import annotations

import hashlib
import json

import pytest
import yaml

from kbe import access_setup, cli, config_store, proc, setup_app, setup_http, state
from kbe.tests.helpers import FakeRunner, make_context

APP_ID = "123e4567-e89b-12d3-a456-426614174000"
APP_HOST = "acme-kb-engine-abc12.ondigitalocean.app"
HOST = "engine.example.com"
TOKEN = "cfut_" + "Ab3dEf6hIj" * 4 + "0a1b2c3d"
OLD_TOKEN = "Zy9xWv8uTs" * 4
JWT = "fixture-jwt-secret-0123456789-abcdefghijklmnopq"
ENV = (
    "KBE_DATABASE_URL=postgresql://postgres:fake-local-pw@localhost/db\n"
    f"SUPABASE_JWT_SECRET={JWT}\n"
)
ENCRYPTED = "EV[1:abcdefgh:ciphertext-that-must-never-be-shown]"
CONFIG = {
    "engine": {"id": "acme", "owner": {"email": "Owner@Example.com"}},
    "dashboard": {"connect": {"connector_url": f"https://{HOST}/mcp"}},
}
OPEN = {"setup_state": "open", "setup_code_set": False, "access": None}
ACCESS = {"team_domain": "https://acme.cloudflareaccess.com", "aud": "a" * 64,
          "status_aud": "b" * 64, "host": HOST, "resource_url": f"https://{HOST}/mcp",
          "level": "owner"}
PLAN_STEPS = [
    {"title": "Point the hostname at the app",
     "lines": [f"CNAME {HOST} -> {APP_HOST}, proxied by Cloudflare."]},
    {"title": "Save the result and close setup", "lines": ["The setup code stops working."]},
]


class Store:
    """The database: the setup state, the applied config, and what was called."""

    def __init__(self, status=OPEN, config=CONFIG):
        self.status, self.config, self.calls = dict(status), config, []

    def describe(self):
        return "a fake database"

    def get(self):
        return self.config

    def call(self, function, args=None):
        self.calls.append((function, dict(args or {})))
        if function == "engine_setup_reopen":
            self.status = {**self.status, "setup_state": "open", "setup_code_set": True}
            return None
        return self.status

    @property
    def hashes(self):
        return [a["p_code_hash"] for name, a in self.calls if name == "engine_setup_reopen"]


class World:
    """doctl, the clipboard and the app, sharing one idea of what the app holds."""

    def __init__(self, store, clipboard=TOKEN, deploys=True):
        self.store, self.clipboard, self.deploys = store, clipboard, deploys
        self.code_on_app = None       # what SETUP_CODE holds on the app
        self.specs = []               # every spec sent to `doctl apps update`
        self.deployment = 1           # the id of the active deployment
        self.coming = None            # (id, polls left) of one under way
        self.posts = []
        self.app_says = {}            # path -> (status, body) to answer instead
        self.fail_apply = False
        self.no_team = False
        self.checks = [
            {"id": "managed_oauth", "state": "ok", "title": "Managed OAuth", "fix": "Click A."},
            {"id": "claude_redirects", "state": "ok", "title": "Claude's redirect addresses",
             "fix": "Click B."},
            {"id": "second_factor", "state": "ok", "title": "A second factor", "fix": "Click C."},
        ]
        self.probe = [404, 404, 401]  # what the hostname answers, in turn
        self.probes = []
        self.runner = FakeRunner({
            "doctl apps spec get": self._spec,
            "doctl apps update": self._update,
            "doctl apps get": self._get,
            "pbpaste": lambda _a, _s: proc.ProcResult(0, self.clipboard, ""),
            "pbcopy": self._copy,
        })

    def _spec(self, _argv, _stdin):
        return proc.ProcResult(0, yaml.safe_dump({
            "name": "acme-kb-engine",
            "services": [{"name": "kb-engine", "envs": [
                {"key": "SUPABASE_JWT_SECRET", "type": "SECRET", "value": ENCRYPTED},
                {"key": "SETUP_CODE", "type": "SECRET", "value": ENCRYPTED},
                {"key": "LOG_LEVEL", "value": "info"},
            ]}],
        }), "")

    def _app(self):
        item = {"id": APP_ID, "spec": {"name": "acme-kb-engine"},
                "default_ingress": f"https://{APP_HOST}",
                "active_deployment": {"id": f"dep-{self.deployment}", "phase": "ACTIVE"}}
        if self.coming:
            item["in_progress_deployment"] = {"id": f"dep-{self.coming[0]}", "phase": "BUILDING"}
        return proc.ProcResult(0, json.dumps([item]), "")

    def _update(self, _argv, stdin):
        spec = yaml.safe_load(stdin)
        self.specs.append(spec)
        entry = next(e for e in spec["services"][0]["envs"] if e["key"] == "SETUP_CODE")
        self.pending_code = entry.get("value")
        self.coming = (self.deployment + 1, 2)
        return self._app()

    def _get(self, _argv, _stdin):
        if self.coming:
            number, left = self.coming
            if left == 0:
                self.coming = None
                if self.deploys:
                    self.deployment, self.code_on_app = number, self.pending_code
            else:
                self.coming = (number, left - 1)
        return self._app()

    def _copy(self, _argv, stdin):
        self.clipboard = stdin
        return proc.ProcResult(0, "", "")

    def post(self, url, data, headers, timeout):
        path = url.rsplit("/", 1)[-1]
        self.posts.append({"url": url, "data": dict(data), "headers": dict(headers)})
        if path in self.app_says:
            return Reply(*self.app_says[path])
        if not self.code_on_app or data.get("code") != self.code_on_app:
            return Reply(401, {"ok": False, "title": "Wrong setup code",
                               "message": "That is not the setup code."})
        if path == "preview":
            return Reply(200, {"ok": True, "inputs": "signed-payload", "sig": "ab" * 32,
                               "plan": {"host": data["host"], "level": data["level"],
                                        "connector_url": f"https://{data['host']}/mcp",
                                        "steps": PLAN_STEPS}})
        if data.get("inputs") != "signed-payload" or data.get("sig") != "ab" * 32:
            return Reply(400, {"ok": False, "title": "Not accepted", "message": "Start again."})
        failed = self.fail_apply or data.get("cf_token") != TOKEN
        if not failed and not self.no_team:
            self.store.status = {"setup_state": "complete", "setup_code_set": False,
                                 "access": ACCESS}
        steps = [{"id": "token", "title": "Check the Cloudflare token",
                  "status": "failed" if failed else "unchanged",
                  **({"note": "Cloudflare stopped accepting the token."} if failed else {})},
                 {"id": "dns", "title": "Point the hostname at the app",
                  "status": "not_run" if failed else "created"}]
        if self.no_team:
            steps = [{"id": "token", "title": "Check the Cloudflare token", "status": "unchanged"},
                     {"id": "organization", "title": "Turn on second-factor sign-in",
                      "status": "failed", "code": "no_team",
                      "note": "Zero Trust has never been opened on this Cloudflare account."}]
        return Reply(502 if failed or self.no_team else 200, {
            "ok": not failed and not self.no_team, "steps": steps, "warnings": [],
            "checks": [] if failed or self.no_team else self.checks,
            "connector_url": f"https://{HOST}/mcp"})

    def get(self, url, timeout):
        self.probes.append(url)
        answer = self.probe.pop(0) if len(self.probe) > 1 else self.probe[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    @property
    def codes(self):
        """Every setup code this run put on the app, in order."""
        return [e["value"] for spec in self.specs for e in spec["services"][0]["envs"]
                if e["key"] == "SETUP_CODE" and "value" in e and e["value"] != ENCRYPTED]


class Reply:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        if isinstance(self._body, str):
            raise ValueError("not JSON")
        return self._body


class FakeClock:
    def __init__(self):
        self.at = 0.0

    def clock(self):
        return setup_app.Clock(now=lambda: self.at, sleep=self._sleep)

    def _sleep(self, seconds):
        self.at += seconds


@pytest.fixture
def run(tmp_path, monkeypatch, capsys):
    """Run `kbe access setup ...` against a World. Returns (code, text, world, ctx)."""
    def go(*flags, store=None, world=None, confirm=None, terminal=False, env=ENV):
        store = store or Store()
        world = world or World(store)
        ctx, seen = make_context(tmp_path, world.runner, confirm)
        ctx.env_file.write_text(env)
        if not ctx.state_file.exists():
            state.save(ctx.state_file, state.with_answer(state.empty(), "do_app_id", APP_ID))
        monkeypatch.setattr(config_store, "choose", lambda *_a, **_k: store)
        monkeypatch.setattr(access_setup, "_post", lambda: world.post)
        monkeypatch.setattr(access_setup, "_get", lambda: world.get)
        monkeypatch.setattr(access_setup, "_clock", FakeClock().clock)
        monkeypatch.setattr(access_setup, "_at_a_terminal", lambda: terminal)
        code = cli.main(["access", "setup", *flags], ctx)
        text = "\n".join(seen) + "\n" + capsys.readouterr().err
        return code, text, world, ctx
    return go


def _everything_visible(text, world):
    """All a person, a log or `ps` could see: output, argv and state."""
    argv = "\n".join(" ".join(call["argv"]) for call in world.runner.calls)
    return text + "\n" + argv


def _assert_no_secret(text, world, ctx, *extra):
    seen = _everything_visible(text, world) + ctx.state_file.read_text()
    for secret in (TOKEN, JWT, ENCRYPTED, *world.codes, *extra):
        assert secret not in seen


# --- the whole run ----------------------------------------------------------------


def test_one_command_sets_up_sign_in(run):
    code, text, world, ctx = run("--yes")
    assert code == 0, text
    assert "Setup is complete." in text
    assert f"Connector address for Claude: https://{HOST}/mcp" in text
    assert "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" in text
    # The app's plan lines are shown exactly as it sent them.
    for step in PLAN_STEPS:
        assert step["title"] in text
        assert all(line in text for line in step["lines"])
    assert "setup:            complete" in text
    assert "python -m kbe verify --phases access_setup" in text
    saved = state.load(ctx.state_file)
    assert state.phase_done(saved, "access_setup")
    assert state.answer(saved, "engine_host") == HOST
    assert state.answer(saved, "access_level") == "owner"


def test_the_choices_come_from_the_config_and_nothing_is_retyped(run):
    _code, text, world, _ctx = run("--yes")
    sent = world.posts[0]["data"]
    assert sent["host"] == HOST
    assert sent["owner_email"] == "owner@example.com"
    assert sent["level"] == "owner"
    assert sent["replace"] == ""
    assert f"Hostname:        {HOST}  (the applied config)" in text


def test_the_code_is_made_here_stored_as_a_hash_and_set_on_the_app(run):
    _code, text, world, ctx = run("--yes")
    assert len(world.codes) == 1
    made = world.codes[0]
    assert world.store.hashes == [hashlib.sha256(made.encode()).hexdigest()]
    # It went to the app on standard input, and to the app's own address.
    updates = [c for c in world.runner.calls if c["argv"][:3] == ["doctl", "apps", "update"]]
    assert updates and all(c["argv"][3:6] == [APP_ID, "--spec", "-"] for c in updates)
    assert made in updates[0]["stdin"]
    assert all(post["data"]["code"] == made for post in world.posts)
    _assert_no_secret(text, world, ctx)


def test_nothing_else_in_the_spec_is_touched(run):
    _code, _text, world, _ctx = run("--yes")
    first = world.specs[0]["services"][0]["envs"]
    assert first[0] == {"key": "SUPABASE_JWT_SECRET", "type": "SECRET", "value": ENCRYPTED}
    assert first[2] == {"key": "LOG_LEVEL", "value": "info"}


def test_the_setup_code_is_taken_off_the_app_afterwards(run):
    _code, text, world, _ctx = run("--yes")
    last = world.specs[-1]["services"][0]["envs"]
    assert {"key": "SETUP_CODE", "type": "SECRET"} in last
    assert last[0]["value"] == ENCRYPTED
    assert "SETUP_CODE was taken off the app" in text


def test_the_token_goes_only_to_the_apply_step_of_the_app_and_is_then_cleared(run):
    _code, text, world, ctx = run("--yes")
    preview, apply = world.posts
    assert preview["url"] == f"https://{APP_HOST}/setup/preview"
    assert apply["url"] == f"https://{APP_HOST}/setup/apply"
    assert "cf_token" not in preview["data"]
    assert apply["data"]["cf_token"] == TOKEN
    assert all(post["headers"] == {"Accept": "application/json"} for post in world.posts)
    assert world.clipboard == ""
    assert "The clipboard was cleared." in text
    assert "Delete it in Cloudflare" in text
    _assert_no_secret(text, world, ctx)


def test_it_waits_for_the_deployment_before_it_calls_the_app(run):
    _code, text, world, _ctx = run("--yes")
    assert "Waiting for the deployment: BUILDING" in text
    assert text.index("The deployment is live.") < text.index("exactly what will be done")
    # Never a wrong code sent to the app: that would count towards the lockout.
    assert [post["data"]["code"] for post in world.posts] == [world.codes[0]] * 2


# --- preview by default --------------------------------------------------------------


def test_a_dry_run_changes_nothing(run):
    code, text, world, _ctx = run("--dry-run", "--yes")
    assert code == 0
    assert "Dry run: nothing was changed." in text
    assert world.store.hashes == [] and world.specs == [] and world.posts == []
    assert world.clipboard == TOKEN


def test_without_yes_and_nobody_to_ask_it_changes_nothing(run):
    code, text, world, _ctx = run()
    assert code == 2
    assert "Nothing was changed" in text and "--yes" in text
    assert world.store.hashes == [] and world.specs == [] and world.posts == []


def test_a_person_is_asked_once_after_the_app_s_preview(run):
    asked = []
    code, text, world, _ctx = run(confirm=lambda q: asked.append(q) or True, terminal=True)
    assert code == 0, text
    assert asked == ["Make these changes in Cloudflare?"]
    assert [p["url"].rsplit("/", 1)[-1] for p in world.posts] == ["preview", "apply"]


def test_a_no_to_the_preview_applies_nothing_and_cleans_up(run):
    code, text, world, ctx = run(confirm=lambda _q: False, terminal=True)
    assert code == 1
    assert "Nothing was changed in Cloudflare." in text
    assert [p["url"].rsplit("/", 1)[-1] for p in world.posts] == ["preview"]
    assert {"key": "SETUP_CODE", "type": "SECRET"} in world.specs[-1]["services"][0]["envs"]
    assert world.clipboard == TOKEN  # theirs to keep or clear; nothing was applied
    _assert_no_secret(text, world, ctx)


# --- already set up -------------------------------------------------------------------


def test_setup_already_complete_changes_nothing(run):
    store = Store({"setup_state": "complete", "setup_code_set": False, "access": ACCESS})
    code, text, world, _ctx = run("--yes", store=store)
    assert code == 0
    assert "Sign-in is already set up for this Engine. Nothing was changed." in text
    assert store.hashes == [] and world.runner.calls == [] and world.posts == []


def test_replace_cannot_redo_a_finished_setup_from_here(run):
    store = Store({"setup_state": "complete", "setup_code_set": False, "access": ACCESS})
    code, text, world, _ctx = run("--yes", "--replace", store=store)
    assert code == 0
    assert "kbe access reopen" in text and f"https://{HOST}/setup" in text
    assert "second factor" in text
    assert store.hashes == [] and world.runner.calls == [] and world.posts == []


def test_a_reopened_engine_is_sent_to_the_page(run):
    store = Store({"setup_state": "open", "setup_code_set": True, "access": ACCESS})
    code, text, world, _ctx = run("--yes", store=store)
    assert code == 0
    assert "setup has been reopened" in text and "kbe access reopen" in text
    assert store.hashes == [] and world.posts == []


# --- interrupted, failed, run again --------------------------------------------------


def test_an_interrupted_run_is_finished_by_running_it_again_with_a_new_code(run):
    store = Store()
    world = World(store, deploys=False)       # the first deployment never goes live
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "The deployment did not go live." in text
    assert world.posts == []
    first = world.codes[0]

    world.deploys = True
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 0, text
    assert "A setup code from an earlier run is replaced" in text
    assert world.codes[-1] != first
    assert world.posts[-1]["data"]["code"] == world.codes[-1]
    _assert_no_secret(text, world, ctx, first)


def test_a_step_that_fails_says_so_keeps_the_token_and_a_second_run_finishes(run):
    store = Store()
    world = World(store)
    world.fail_apply = True
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "Failed" in text and "Cloudflare stopped accepting the token." in text
    assert "Not run" in text
    assert "run this command again" in text
    assert world.clipboard == TOKEN
    assert {"key": "SETUP_CODE", "type": "SECRET"} in world.specs[-1]["services"][0]["envs"]
    assert not state.phase_done(state.load(ctx.state_file), "access_setup")
    _assert_no_secret(text, world, ctx)

    world.fail_apply = False
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 0, text
    assert world.clipboard == ""


def test_a_deployment_that_takes_too_long_stops_the_run(run):
    store = Store()
    world = World(store)
    world.runner.answers["doctl apps get"] = lambda _a, _s: proc.ProcResult(0, json.dumps([{
        "id": APP_ID, "default_ingress": APP_HOST,
        "active_deployment": {"id": "dep-1", "phase": "ACTIVE"},
        "in_progress_deployment": {"id": "dep-2", "phase": "BUILDING"}}]), "")
    code, text, world, _ctx = run("--yes", "--wait-minutes", "1", store=store, world=world)
    assert code == 1
    assert "was not live after 1 minutes" in text
    assert world.posts == []
    assert "SETUP_CODE was taken off the app" in text


def test_a_failed_cleanup_does_not_hide_what_happened(run):
    store = Store()
    world = World(store)
    updates = []

    def update(argv, stdin):
        updates.append(stdin)
        if len(updates) > 1:
            return proc.ProcResult(1, "", f"Error: spec rejected {world.codes[0]}")
        return world._update(argv, stdin)

    world.runner.answers["doctl apps update"] = update
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 0, text
    assert "Setup is complete." in text
    assert "SETUP_CODE could not be taken off the app" in text
    _assert_no_secret(text, world, ctx)


# --- the token ------------------------------------------------------------------------


@pytest.mark.parametrize("clip", [
    "", "hello", "123e4567-e89b-12d3-a456-426614174000", "cfk_" + "a" * 48,
    "https://example.com/a/long/address/that-is-no-token", "a" * 43, OLD_TOKEN,
])
def test_a_clipboard_that_is_not_a_token_is_never_sent(run, clip):
    world = World(Store(), clipboard=clip)
    code, text, world, _ctx = run("--yes", "--wait-minutes", "1", world=world, store=world.store)
    assert code == 2
    assert "does not hold a Cloudflare API token" in text
    assert world.posts == []
    assert clip == "" or clip not in text


def test_a_clipboard_that_holds_a_local_secret_is_refused_by_name_only(run):
    world = World(Store(), clipboard=JWT[:40])
    code, text, _world, _ctx = run(
        "--yes", "--legacy-format", "--wait-minutes", "1", world=world, store=world.store,
        env=ENV + f"OTHER_SECRET={JWT[:40]}\n")
    assert code == 2
    assert "holds the value of OTHER_SECRET from your env file" in text
    assert JWT[:40] not in text
    assert world.posts == []


def test_it_picks_the_token_up_when_it_appears(run):
    store = Store()
    world = World(store, clipboard="not yet")
    reads = []

    def paste(_argv, _stdin):
        reads.append(1)
        return proc.ProcResult(0, TOKEN if len(reads) > 4 else "not yet", "")

    world.runner.answers["pbpaste"] = paste
    code, text, world, _ctx = run("--yes", store=store, world=world)
    assert code == 0, text
    assert text.count("Waiting: the clipboard does not hold a Cloudflare API token") == 1
    assert "Found a token on the clipboard. It is not shown." in text


def test_an_older_token_without_a_prefix_is_accepted_as_a_token(run):
    world = World(Store(), clipboard=OLD_TOKEN)
    code, text, world, _ctx = run("--yes", "--legacy-format", world=world, store=world.store)
    # The fake app only knows TOKEN, so it reports the token step as failed.
    assert code == 1
    assert world.posts[-1]["data"]["cf_token"] == OLD_TOKEN
    assert OLD_TOKEN not in text


def test_no_clipboard_tool_is_said_before_anything_is_changed(run):
    store = Store()
    world = World(store)
    world.runner.answers["pbpaste"] = proc.ProcResult(proc.NOT_FOUND, "", "pbpaste: not found")
    code, text, world, _ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "--token-file" in text
    assert store.hashes == [] and world.specs == []


def test_the_token_can_come_from_a_file(run, tmp_path):
    token_file = tmp_path / "cf-token"
    token_file.write_text(TOKEN + "\n")
    store = Store()
    world = World(store, clipboard="something else")
    code, text, world, ctx = run("--yes", "--token-file", str(token_file), store=store, world=world)
    assert code == 0, text
    assert world.posts[-1]["data"]["cf_token"] == TOKEN
    assert world.clipboard == "something else"  # not touched
    assert f"Delete the file {token_file} now" in text
    assert not any(c["argv"][0] == "pbpaste" for c in world.runner.calls)
    _assert_no_secret(text, world, ctx)


# --- what the app says back -----------------------------------------------------------


def test_text_from_the_app_never_shows_a_secret_even_if_the_app_echoes_one(run):
    store = Store()
    world = World(store)

    def echo(url, data, headers, timeout):
        return Reply(400, {"ok": False, "title": "Check your choices",
                           "message": f"bad code {data['code']} \x1b[2J",
                           "errors": [f"token {TOKEN} and {JWT}"]})

    world.post = echo
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "Check your choices." in text and "********" in text
    assert "\x1b" not in text
    _assert_no_secret(text, world, ctx)


def test_a_network_error_that_carries_the_request_is_not_shown(run):
    store = Store()
    world = World(store)

    def broken(url, data, headers, timeout):
        raise ConnectionError(f"failed sending {data} to {url}")

    world.post = broken
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert f"Could not reach the app at {APP_HOST} (ConnectionError)" in text
    _assert_no_secret(text, world, ctx)


def test_a_lockout_is_reported_in_the_app_s_words(run):
    store = Store()
    world = World(store)
    world.app_says["preview"] = (429, {
        "ok": False, "title": "Setup is locked",
        "message": "Too many wrong setup codes. Nothing is accepted for about 58 more minutes."})
    code, text, world, _ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "Setup is locked. Too many wrong setup codes." in text
    assert len(world.posts) == 1  # no second try: every wrong code counts


def test_an_app_from_before_this_command_is_named_as_such(run):
    store = Store()
    world = World(store)
    world.app_says["preview"] = (200, "<!doctype html><html>the setup page</html>")
    code, text, world, _ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "did not answer with data" in text and "kbe deploy redeploy" in text


@pytest.mark.parametrize("ADDRESS", ["https://evil.example.net", ""])
def test_secrets_are_sent_only_to_the_app_s_own_address(run, ADDRESS, tmp_path):
    # Not even an address remembered in the local state is used in its place.
    saved = state.with_answer(state.empty(), "do_app_id", APP_ID)
    state.save(tmp_path / ".kb-engine-local" / "state.json",
               state.with_answer(saved, "do_default_hostname", "old-app-1.ondigitalocean.app"))
    store = Store()
    world = World(store)
    world.runner.answers["doctl apps get"] = proc.ProcResult(0, json.dumps([{
        "id": APP_ID, "default_ingress": ADDRESS,
        "active_deployment": {"id": "dep-1", "phase": "ACTIVE"}}]), "")
    code, text, world, _ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "not an ondigitalocean.app address" in text
    assert store.hashes == [] and world.specs == [] and world.posts == []


# --- the choices ----------------------------------------------------------------------


def test_flags_override_and_are_remembered_for_the_next_run(run):
    store = Store()
    world = World(store)
    code, text, world, ctx = run(
        "--dry-run", "--host", "kb.example.org", "--level", "people",
        "--emails", "Amy@Example.com, bob@example.com", store=store, world=world)
    assert code == 0, text
    assert "kb.example.org  (--host)" in text
    assert "People:          amy@example.com, bob@example.com" in text

    code, text, world, ctx = run(
        "--yes", "--level", "people", "--emails", "amy@example.com", "--replace",
        store=store, world=world)
    assert code == 0, text
    sent = world.posts[0]["data"]
    assert (sent["level"], sent["emails"], sent["replace"]) == ("people", "amy@example.com", "yes")
    saved = state.load(ctx.state_file)
    assert state.answer(saved, "access_emails") == ["amy@example.com"]


@pytest.mark.parametrize("flags, said", [
    (("--level", "people"), "needs at least one other person"),
    (("--level", "domain"), "needs at least one email domain"),
    (("--emails", "amy@example.com"), "--emails is only used with --level people"),
    (("--host", "not a host"), "The hostname is not valid"),
    (("--level", "people", "--emails", "amy"), "1 of the email addresses are not valid"),
])
def test_a_mistake_is_caught_before_a_deployment_is_spent(run, flags, said):
    code, text, world, _ctx = run("--yes", *flags)
    assert code == 2
    assert said in text
    assert world.store.hashes == [] and world.specs == []


def test_it_needs_an_applied_config_and_an_app(run, tmp_path):
    code, text, _world, _ctx = run("--yes", store=Store(config=None))
    assert code == 1 and "kbe config apply" in text
    state.save(tmp_path / ".kb-engine-local" / "state.json", state.empty())
    code, text, _world, _ctx = run("--yes")
    assert code == 1 and "No app yet" in text


def test_the_hostname_falls_back_to_the_local_state(run, tmp_path):
    saved = state.with_answer(state.empty(), "do_app_id", APP_ID)
    state.save(tmp_path / ".kb-engine-local" / "state.json",
               state.with_answer(saved, "engine_host", "from-state.example.com"))
    store = Store(config={"engine": {"owner": {"email": "owner@example.com"}}})
    code, text, _world, _ctx = run("--dry-run", store=store)
    assert code == 0, text
    assert "from-state.example.com  (the local state)" in text


# --- Zero Trust, the read-back and the wait for the hostname ---------------------------


def test_zero_trust_is_named_up_front_with_where_to_go(run):
    _code, text, _world, _ctx = run("--yes")
    assert text.index("First time with Zero Trust") < text.index("Open this link")
    assert "https://one.dash.cloudflare.com" in text


def test_an_account_with_no_team_name_gets_the_exact_thing_to_do(run):
    store = Store()
    world = World(store)
    world.no_team = True
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 1
    assert "has never opened Zero Trust" in text
    assert "Nothing was created in Cloudflare." in text
    assert "https://one.dash.cloudflare.com" in text and "pick a team name" in text
    assert "Then run this command again." in text
    assert "The token is still on the clipboard" in text
    assert world.clipboard == TOKEN and world.probes == []
    _assert_no_secret(text, world, ctx)


def test_it_waits_for_the_new_hostname_instead_of_reporting_a_404(run):
    code, text, world, _ctx = run("--yes")
    assert code == 0, text
    assert world.probes == [f"https://{HOST}/mcp"] * 3
    assert text.count("Not ready yet (HTTP 404") == 2
    assert f"{HOST} asks for a sign-in (HTTP 401). Sign-in is working." in text
    assert text.index("Sign-in is working.") < text.index("Connector address for Claude")


def test_a_hostname_that_stays_not_found_is_explained_and_setup_still_counts(run):
    store = Store()
    world = World(store)
    world.probe = [ConnectionError("no such host"), 404]
    code, text, world, ctx = run("--yes", store=store, world=world)
    assert code == 0, text
    assert "Not ready yet (no answer" in text
    assert 'still answers "not found" (404) after 4 minutes' in text
    assert "Setup itself is complete." in text
    assert f"check that {HOST} is listed there" in text
    assert state.phase_done(state.load(ctx.state_file), "access_setup")


def test_another_answer_from_the_hostname_is_not_waited_on(run):
    store = Store()
    world = World(store)
    world.probe = [503]
    code, text, world, _ctx = run("--yes", store=store, world=world)
    assert code == 0
    assert len(world.probes) == 1
    assert f"{HOST} answered HTTP 503, not a request to sign in" in text


def test_everything_in_place_is_said_in_one_line(run):
    _code, text, _world, _ctx = run("--yes")
    assert "Checked in Cloudflare: Managed OAuth is on" in text
    assert "Needs a click" not in text


def test_each_setting_not_in_place_gets_one_line_with_where_to_click(run):
    store = Store()
    world = World(store)
    world.checks[0]["state"] = "missing"
    world.checks[2]["state"] = "unknown"
    code, text, world, _ctx = run("--yes", store=store, world=world)
    assert code == 0, text
    assert "Needs a click in Cloudflare: Managed OAuth is not in place. Click A." in text
    assert "Could not be checked: A second factor." in text
    assert "Click B." not in text and "Click C." not in text
    assert "Checked in Cloudflare" not in text
