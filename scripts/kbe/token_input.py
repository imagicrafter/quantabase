"""The one-time Cloudflare API token: from the clipboard or a file, never shown.

    clipboard (pbpaste) -> this process -> HTTPS -> the app

The token is never a command-line argument, never printed, never written
anywhere by this tool. It is refused, by name only, when it does not look like
a Cloudflare API token or when it is a value from the local env file.

What a Cloudflare API token looks like comes from Cloudflare's "Token formats":
https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/
A current token is `cfut_` (user) or `cfat_` (account) and 40 characters, then
a checksum; every token made today has that form. An older one is 40
characters with no prefix: other secrets look the same, so it is accepted only
with --legacy-format. A Global API Key (`cfk_`) is not a token and is refused.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Callable, Mapping

from . import proc
from .context import Context
from .errors import KbeError, UsageError
from .setup_app import Clock

_SHAPE = re.compile(r"cf[ua]t_[A-Za-z0-9]{40,64}")
# The old form. Many other secrets look like this, so it is taken only when asked for.
_LEGACY_SHAPE = re.compile(r"(?!cf[a-z]+_)[A-Za-z0-9_-]{40}")
_MAX_FILE_BYTES = 4096
POLL_SECONDS = 2

NOT_A_TOKEN = "does not hold a Cloudflare API token"


@dataclass(frozen=True)
class Source:
    """Where the token comes from. `read` returns its text, or "" for nothing yet."""

    name: str
    read: Callable[[], str]
    is_clipboard: bool
    legacy: bool = False


def _pbpaste(ctx: Context) -> str:
    result = ctx.runner(["pbpaste"], timeout=15)
    if result.code == proc.NOT_FOUND:
        raise KbeError(
            "pbpaste was not found, so the clipboard cannot be read on this machine. Save "
            "the token in a new file only you can read and pass --token-file PATH."
        )
    if not result.ok:
        raise KbeError("pbpaste could not read the clipboard. Use --token-file PATH instead.")
    return result.stdout.strip()


def _file(path: Path) -> str:
    try:
        if not path.is_file() or path.stat().st_size > _MAX_FILE_BYTES:
            return ""
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def source(ctx: Context, token_file: str | None, legacy: bool = False) -> Source:
    if token_file:
        path = Path(token_file).expanduser()
        return Source(f"the file {path}", lambda: _file(path), False, legacy)
    return Source("the clipboard", lambda: _pbpaste(ctx), True, legacy)


def problem(text: str, values: Mapping[str, str], code: str, legacy: bool = False) -> str | None:
    """Why `text` is not accepted as the token, or None. Names only, no value."""
    shaped = _SHAPE.fullmatch(text or "") or (legacy and _LEGACY_SHAPE.fullmatch(text or ""))
    if not shaped:
        return NOT_A_TOKEN
    if text == code:
        return "holds the setup code, not the token"
    same = sorted(name for name, value in values.items() if value == text)
    if same:
        return f"holds the value of {', '.join(same)} from your env file, not the token"
    return None


def wait_for(
    src: Source, values: Mapping[str, str], code: str,
    out: Callable[[str], None], minutes: int, clock: Clock = Clock(),
) -> str:
    """Look until the source holds a token. Says what is wrong once; shows no value."""
    deadline = clock.now() + minutes * 60
    said = None
    while True:
        text = src.read()
        why = problem(text, values, code, src.legacy)
        if why is None:
            out(f"  Found a token on {src.name}. It is not shown.")
            return text
        if why != said:
            out(f"  Waiting: {src.name} {why}. Copy the token from Cloudflare.")
            said = why
        if clock.now() >= deadline:
            raise UsageError(
                f"After {minutes} minutes {src.name} still {why}, so nothing was changed "
                "in Cloudflare. Run this command again when you have the token."
            )
        clock.sleep(POLL_SECONDS)


def clear_clipboard(ctx: Context) -> bool:
    """Empty the clipboard. True when it was done."""
    return ctx.runner(["pbcopy"], stdin="", timeout=15).ok
