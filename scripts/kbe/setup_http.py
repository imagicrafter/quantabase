"""The app's own setup routes, called the way its setup page calls them.

    POST https://<the app's own address>/setup/preview
    POST https://<the app's own address>/setup/apply

The same form fields a browser sends, with `Accept: application/json` so the
answer comes back as data. Everything is decided by the app: the setup code
check and its lockout, the validation, the plan, the signature that ties the
apply step to the preview. Nothing here talks to Cloudflare.

SECRETS. The setup code and the Cloudflare token go out in the request body,
over HTTPS, to the app's `ondigitalocean.app` address and nowhere else.
Redirects are not followed. Neither is ever put in an error: a failed request
is reported by the kind of failure, and text the app sends back is cleaned
(`issues.printable`) and has both secrets removed before it is kept.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from . import issues, secrets
from .errors import KbeError

_APP_HOST = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.ondigitalocean\.app")
_SIGNATURE = re.compile(r"[0-9a-f]{64}")
_MAX_TEXT = 2000
_MAX_ITEMS = 60
# The apply step may spend 75 seconds talking to Cloudflare.
PREVIEW_TIMEOUT, APPLY_TIMEOUT = 30, 120
STATUSES = ("created", "updated", "unchanged", "failed", "not_run")
CHECK_STATES = ("ok", "missing", "unknown")
_WORD = re.compile(r"[a-z][a-z0-9_]{0,40}")

_OLD_VERSION = (
    "The app did not answer with data. It may run a version from before "
    "`kbe access setup`. Deploy the current version (`python -m kbe deploy redeploy "
    "--yes`), or use the setup page in a browser instead."
)
_NO_DATA = (
    "The app answered HTTP {status} without data. Wait a minute and run this command "
    "again. If it keeps happening, look at `python -m kbe deploy status`; the app may "
    "also run a version from before `kbe access setup` (`python -m kbe deploy redeploy "
    "--yes`)."
)


class Refused(KbeError):
    """The app said no. Holds its words, cleaned, and never a secret."""

    def __init__(self, status: int, title: str, message: str, errors: Sequence[str] = ()):
        super().__init__(" ".join(part for part in (f"{title}.", message, *errors) if part))
        self.status, self.title, self.errors = status, title, tuple(errors)


@dataclass(frozen=True)
class Step:
    title: str
    lines: tuple[str, ...] = ()
    status: str = ""
    note: str = ""
    id: str = ""
    code: str = ""


@dataclass(frozen=True)
class Check:
    """One thing the app read back after setup: in place, missing or unknown."""

    id: str
    state: str
    title: str
    fix: str


@dataclass(frozen=True)
class Preview:
    host: str
    level: str
    connector_url: str
    steps: tuple[Step, ...]
    inputs: str = field(repr=False)
    sig: str = field(repr=False)


@dataclass(frozen=True)
class Result:
    ok: bool
    steps: tuple[Step, ...]
    warnings: tuple[str, ...]
    connector_url: str
    checks: tuple[Check, ...] = ()

    def failed_with(self, code: str) -> bool:
        return any(step.status == "failed" and step.code == code for step in self.steps)


def _default_post(url: str, data: Mapping[str, str], headers: Mapping[str, str], timeout: int):
    import requests

    return requests.post(
        url, data=dict(data), headers=dict(headers), timeout=timeout, allow_redirects=False)


def check_host(host: str) -> str:
    """The app's own address, or a refusal. Secrets are sent nowhere else."""
    name = (host or "").strip().lower()
    if not _APP_HOST.fullmatch(name):
        raise KbeError(
            "The app's own address is not known, or is not an ondigitalocean.app address. "
            "Run `python -m kbe deploy status`, then this command again."
        )
    return name


@dataclass(frozen=True)
class SetupApi:
    host: str
    hidden: Mapping[str, str] = field(default_factory=dict, repr=False)
    post: Callable[..., Any] = _default_post

    def _text(self, value: Any) -> str:
        cleaned = issues.printable(value if isinstance(value, str) else "")[:_MAX_TEXT]
        return secrets.redact(cleaned, self.hidden)

    def _texts(self, value: Any) -> tuple[str, ...]:
        items = value if isinstance(value, list) else []
        return tuple(self._text(item) for item in items[:_MAX_ITEMS])

    def _send(self, path: str, form: Mapping[str, str], timeout: int) -> tuple[int, Mapping]:
        url = f"https://{check_host(self.host)}/setup/{path}"
        try:
            response = self.post(url, form, {"Accept": "application/json"}, timeout)
        except Exception as error:  # noqa: BLE001 - its text may hold the request
            raise KbeError(
                f"Could not reach the app at {self.host} ({type(error).__name__}). "
                "Check your connection and `python -m kbe deploy status`, then run this again."
            ) from None
        try:
            body = response.json()
        except ValueError:
            body = None
        status = int(response.status_code)
        if not isinstance(body, Mapping):
            raise KbeError(_OLD_VERSION if status == 200 else _NO_DATA.format(status=status))
        return status, body

    def _refused(self, status: int, body: Mapping) -> Refused:
        title = self._text(body.get("title")) or f"The app answered HTTP {status}"
        return Refused(status, title, self._text(body.get("message")),
                       self._texts(body.get("errors")))

    @staticmethod
    def _word(value: Any) -> str:
        """A fixed word from the app (a step id, a code), or "" for anything else."""
        return value if isinstance(value, str) and _WORD.fullmatch(value) else ""

    def _checks(self, value: Any) -> tuple[Check, ...]:
        items = value if isinstance(value, list) else []
        return tuple(
            Check(
                id=self._word(item.get("id")),
                state=item.get("state") if item.get("state") in CHECK_STATES else "unknown",
                title=self._text(item.get("title")), fix=self._text(item.get("fix")),
            )
            for item in items[:_MAX_ITEMS] if isinstance(item, Mapping)
        )

    def _steps(self, value: Any) -> tuple[Step, ...]:
        items = value if isinstance(value, list) else []
        return tuple(
            Step(
                title=self._text(item.get("title")),
                lines=self._texts(item.get("lines")),
                status=item.get("status") if item.get("status") in STATUSES else "",
                note=self._text(item.get("note")),
                id=self._word(item.get("id")), code=self._word(item.get("code")),
            )
            for item in items[:_MAX_ITEMS] if isinstance(item, Mapping)
        )

    def preview(self, code: str, choices: Mapping[str, str]) -> Preview:
        """Ask the app for its plan. Changes nothing, calls Cloudflare for nothing."""
        status, body = self._send("preview", {**choices, "code": code}, PREVIEW_TIMEOUT)
        plan = body.get("plan")
        inputs, sig = body.get("inputs"), body.get("sig")
        if status != 200 or body.get("ok") is not True:
            raise self._refused(status, body)
        if (not isinstance(plan, Mapping) or not isinstance(inputs, str) or not inputs
                or not isinstance(sig, str) or not _SIGNATURE.fullmatch(sig)):
            raise KbeError(_OLD_VERSION)
        return Preview(
            host=self._text(plan.get("host")), level=self._text(plan.get("level")),
            connector_url=self._text(plan.get("connector_url")),
            steps=self._steps(plan.get("steps")), inputs=inputs, sig=sig,
        )

    def apply(self, code: str, token: str, preview: Preview) -> Result:
        """Carry out the previewed plan. The token is used for this one request."""
        form = {"inputs": preview.inputs, "sig": preview.sig, "code": code, "cf_token": token}
        status, body = self._send("apply", form, APPLY_TIMEOUT)
        if status not in (200, 422, 502) or not isinstance(body.get("steps"), list):
            raise self._refused(status, body)
        return Result(
            ok=status == 200 and body.get("ok") is True,
            steps=self._steps(body.get("steps")),
            warnings=self._texts(body.get("warnings")),
            connector_url=self._text(body.get("connector_url")),
            checks=self._checks(body.get("checks")),
        )
