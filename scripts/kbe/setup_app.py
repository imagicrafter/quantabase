"""The setup code on the deployed app: set it, wait until it is live, take it off.

The code goes to the app the way `kbe deploy secrets push` sends every secret:
inside the live spec, on `doctl`'s standard input. It is never on a command
line, never written to a file and never printed. Nothing else in the spec is
changed: only the `value` of the secret named SETUP_CODE.

TAKING IT OFF. The spec keeps the SETUP_CODE declaration and loses its value.
The platform blanks a declared secret that is sent with no value, and the
service treats an empty SETUP_CODE as not set. The declaration stays so a
later setup can give it a value again.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from . import deploy_doctl, deploy_render, deploy_secrets
from .errors import KbeError

SETUP_CODE = "SETUP_CODE"
ACTIVE = "ACTIVE"
POLL_SECONDS = 10
SETTLE_SECONDS = 20
# How many looks in a row may show "no deployment under way, and not the one
# we started" before the wait gives up. doctl can lag for a moment.
_STRIKES = 3
_REPORT_EVERY = 6


@dataclass(frozen=True)
class Clock:
    """Time, so a test can run the wait without waiting."""

    now: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep


@dataclass(frozen=True)
class Started:
    """What the wait needs to know about the deployment it follows."""

    app: deploy_doctl.App
    before_id: str

    @property
    def target_id(self) -> str:
        return self.app.coming_id


def set_code(doctl: deploy_doctl.Doctl, app_id: str, code: str) -> Started:
    """Set SETUP_CODE on the app. Starts a deployment. Shows nothing."""
    live = doctl.live_spec(app_id)
    if not deploy_secrets.declares(live, SETUP_CODE):
        raise KbeError(
            f"The live app does not declare the secret {SETUP_CODE}, so the setup code has "
            "nowhere to go. Run `python -m kbe deploy apply` to bring the app up to date."
        )
    before = doctl.get(app_id)
    spec = deploy_render.dump(deploy_secrets.updated(live, {SETUP_CODE: code}))
    return Started(doctl.update(app_id, spec), before.active_id)


def clear_code(doctl: deploy_doctl.Doctl, app_id: str) -> bool:
    """Take SETUP_CODE's value off the app. False when it declares none."""
    live = doctl.live_spec(app_id)
    if not deploy_secrets.declares(live, SETUP_CODE):
        return False
    doctl.update(app_id, deploy_render.dump(deploy_secrets.cleared(live, SETUP_CODE)))
    return True


def _live(app: deploy_doctl.App, started: Started, seen_busy: bool) -> bool:
    """True when the deployment we started is the one serving."""
    if app.in_progress or app.coming_id or app.phase != ACTIVE:
        return False
    if started.target_id:
        return app.active_id == started.target_id
    if app.active_id and started.before_id:
        return app.active_id != started.before_id
    return seen_busy  # a doctl that gives no ids: it was busy, now it is not


def wait_until_live(
    doctl: deploy_doctl.Doctl, app_id: str, started: Started,
    out: Callable[[str], None], minutes: int, clock: Clock = Clock(),
) -> None:
    """Follow the deployment until it serves. Raises when it does not."""
    deadline = clock.now() + minutes * 60
    begun = clock.now()
    seen_busy, strikes, last, looks = False, 0, "", 0
    while True:
        app = doctl.get(app_id)
        busy = bool(app.in_progress or app.coming_id)
        if _live(app, started, seen_busy):
            out("  The deployment is live.")
            return
        seen_busy = seen_busy or busy
        strikes = 0 if busy else strikes + 1
        if strikes >= _STRIKES and (seen_busy or started.target_id):
            raise KbeError(
                "The deployment did not go live. See `python -m kbe deploy status` and the "
                "app's logs, fix what they show, then run this command again."
            )
        phase = app.in_progress or app.phase
        looks += 1
        if phase != last or looks % _REPORT_EVERY == 0:
            out(f"  Waiting for the deployment: {phase} ({int(clock.now() - begun)} s)")
            last = phase
        if clock.now() >= deadline:
            raise KbeError(
                f"The deployment was not live after {minutes} minutes. Follow it with "
                "`python -m kbe deploy status`. When it is ACTIVE, run this command again."
            )
        clock.sleep(POLL_SECONDS)
