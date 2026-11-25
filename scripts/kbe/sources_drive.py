"""`kbe sources drive auth` -- the one-time Google sign-in for the Drive puller.

The owner signs in once, in a browser on their own machine, for read-only
Drive access. Two values come out, each the base64 of a JSON file (base64
because an env file cannot hold the JSON's newlines):

    DRIVE_TOKEN_JSON_B64          the sign-in token
    DRIVE_TOKEN_CLIENT_JSON_B64   the OAuth client the token refreshes against

`pullers/drive.py` turns both back into files when the job starts. They are
secrets: they go to the clipboard, one at a time, or into a file the owner
names (created for the owner only, never replaced). They are never printed,
never written to the local state file and never put on a command line.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from . import proc
from .context import Context
from .errors import KbeError
from .sources_checks import DRIVE_SCOPES, DRIVE_TOKEN_KEY

DRIVE_CLIENT_KEY = "DRIVE_TOKEN_CLIENT_JSON_B64"
COMPONENT = "puller-drive"
_CLIPBOARD_TOOLS = (
    ("pbcopy",),
    ("wl-copy",),
    ("xclip", "-selection", "clipboard"),
    ("clip",),
)

# (client secret path, scopes) -> the token as a JSON string
Flow = Callable[[Path, Sequence[str]], str]


def run_flow(client_secret: Path, scopes: Sequence[str]) -> str:
    """Open the browser sign-in and return the token JSON."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), list(scopes))
    return flow.run_local_server(port=0).to_json()


def _encode(data: Any) -> str:
    compact = json.dumps(data, separators=(",", ":"))
    return base64.b64encode(compact.encode("utf-8")).decode("ascii")


def read_client(path: Path) -> Mapping[str, Any]:
    """The OAuth client file, checked to be one."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise KbeError(f"Could not read {path}: {error.strerror}.") from error
    except ValueError as error:
        raise KbeError(f"{path} is not a JSON file.") from error
    if not isinstance(data, Mapping) or not (data.get("installed") or data.get("web")):
        raise KbeError(
            f"{path} is not an OAuth client file. Download the \"Desktop app\" client "
            "JSON from the Google Cloud console (APIs & Services -> Credentials)."
        )
    return data


def sign_in(client_secret: Path, flow: Flow | None = None) -> dict[str, str]:
    """Run the sign-in. Returns the two app secrets, by name."""
    client = read_client(client_secret)
    try:
        token = json.loads((flow or run_flow)(client_secret, DRIVE_SCOPES))
    except Exception as error:  # noqa: BLE001 - never echo what Google sent back
        raise KbeError(f"The Google sign-in did not finish ({type(error).__name__}).") from error
    if not isinstance(token, Mapping) or not token.get("refresh_token"):
        raise KbeError(
            "Google returned no refresh token. Remove this app's access at "
            "myaccount.google.com/permissions and sign in again."
        )
    return {DRIVE_TOKEN_KEY: _encode(token), DRIVE_CLIENT_KEY: _encode(client)}


def _tools() -> tuple[tuple[str, ...], ...]:
    if sys.platform == "darwin":
        return _CLIPBOARD_TOOLS[:1]
    return _CLIPBOARD_TOOLS[1:]


def copy(ctx: Context, text: str) -> None:
    """Put `text` on the clipboard. It travels on standard input only."""
    for argv in _tools():
        result = ctx.runner(list(argv), stdin=text, timeout=15)
        if result.code == proc.NOT_FOUND:
            continue
        if result.ok:
            return
        raise KbeError(f"{argv[0]} could not copy to the clipboard. Use --out FILE instead.")
    raise KbeError("No clipboard tool was found on this machine. Use --out FILE instead.")


def to_clipboard(ctx: Context, values: Mapping[str, str]) -> None:
    """Each value in turn, with a pause between; the clipboard is emptied after."""
    names = list(values)
    try:
        for index, name in enumerate(names):
            copy(ctx, values[name])
            ctx.out(f"{index + 1}/{len(names)}: {name} is on the clipboard. Paste it now.")
            last = index == len(names) - 1
            question = "Pasted? Clear the clipboard" if last else "Pasted? Copy the next one"
            if not ctx.confirm(question):
                raise KbeError(
                    "Stopped. The clipboard was cleared; run the command again to start over."
                )
    finally:
        copy(ctx, "")
    ctx.out("Clipboard cleared.")


def to_file(path: Path, values: Mapping[str, str]) -> Path:
    """Write NAME=value lines to a new file only its owner can read."""
    target = path.expanduser()
    text = "".join(f"{name}={value}\n" for name, value in values.items())
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise KbeError(f"{target} already exists. It is never replaced; name a new file.") from error
    except OSError as error:
        raise KbeError(f"Could not create {target}: {error.strerror}.") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError as error:
        _discard(target)
        raise KbeError(f"Could not write {target}: {error.strerror}.") from error
    return target


def _discard(path: Path) -> None:
    """Remove a file this run made and could not finish. Never raises."""
    try:
        path.unlink()
    except OSError:
        pass


def next_steps(names: Sequence[str]) -> list[str]:
    """Where the values go. Names only."""
    return [
        f"Set these as encrypted values on the `{COMPONENT}` job in the DigitalOcean "
        "dashboard (App -> Settings -> the job -> Environment Variables):",
        *(f"  {name}" for name in names),
        "To check them from this machine, also put them in your local env file and "
        "run: python -m kbe sources drive check",
    ]
