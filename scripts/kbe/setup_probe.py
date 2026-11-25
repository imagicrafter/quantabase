"""After setup: wait until the Engine's hostname asks for a sign-in.

Right after Cloudflare has the new records, the hostname answers 404
("error code: 1043") on every path for a minute or two. That is expected.
This asks again until the answer changes, with a line of progress, so the
person is not left looking at a failure that is not one.

One plain GET of `https://<hostname>/mcp`, with no sign-in and no secret.
Redirects are not followed: a redirect to the sign-in page is a good answer.
It is the same test as `kbe verify --phases access_setup`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .setup_app import Clock

ASKS_FOR_SIGN_IN = (301, 302, 401, 403)
NOT_READY = 404
POLL_SECONDS = 10
WAIT_SECONDS = 240


@dataclass(frozen=True)
class Probe:
    ok: bool
    lines: tuple[str, ...]


def _default_get(url: str, timeout: int) -> int:
    import requests

    return int(requests.get(url, timeout=timeout, allow_redirects=False).status_code)


def _ask(get: Callable[[str, int], int], url: str) -> int:
    """The HTTP status, or 0 when the hostname could not be reached at all."""
    try:
        return int(get(url, 15))
    except Exception:  # noqa: BLE001 - DNS not there yet, a reset, a timeout
        return 0


def wait_for_sign_in(
    host: str, out: Callable[[str], None], clock: Clock = Clock(),
    get: Callable[[str, int], int] = _default_get,
) -> Probe:
    """Ask until the hostname asks for a sign-in, or the wait is over."""
    url = f"https://{host}/mcp"
    begun = clock.now()
    out(f"Checking that {host} asks for a sign-in. A new hostname can answer "
        '"not found" for a minute or two; that is expected.')
    while True:
        status = _ask(get, url)
        waited = int(clock.now() - begun)
        if status in ASKS_FOR_SIGN_IN:
            return Probe(True, (f"{host} asks for a sign-in (HTTP {status}). Sign-in is working.",))
        if status not in (NOT_READY, 0):
            return Probe(False, (
                f"{host} answered HTTP {status}, not a request to sign in. Run "
                "`python -m kbe verify --phases access_setup` and look at "
                "`python -m kbe deploy status`.",))
        if waited >= WAIT_SECONDS:
            said = "is not answering yet" if status == 0 else 'still answers "not found" (404)'
            return Probe(False, (
                f"{host} {said} after {waited // 60} minutes. Setup itself is complete. "
                "Wait a few more minutes and run `python -m kbe verify --phases access_setup`.",
                "If it stays that way: in the DigitalOcean dashboard, open the app, Settings, "
                f"Domains, and check that {host} is listed there.",))
        out(f"  Not ready yet ({'no answer' if status == 0 else 'HTTP 404'}, {waited} s). "
            "Asking again.")
        clock.sleep(POLL_SECONDS)
