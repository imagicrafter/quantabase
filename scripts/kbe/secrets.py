"""Credentials for the CLI.

Every command gets credentials from one place: a local, git-ignored env file
(the repo's `.env` by default; `--env-file` or KBE_ENV_FILE to use another).
It is read with `dotenv_values`, which returns a mapping and exports nothing
into this process. A value is handed to a child program only through that
child's own environment, and is never printed: use `mask()` for anything
shown to a person and `redact()` on text that came back from a child.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Iterator, Mapping

from .errors import KbeError

MASK = "********"
_MIN_REDACT_LENGTH = 6
# A line copied from the example file and not filled in: `NAME=<what goes here>`.
_PLACEHOLDER = re.compile(r"<[^<>]*>")


def is_placeholder(value: str | None) -> bool:
    """True for an example-file placeholder such as `<your-project-ref>`."""
    return value is not None and _PLACEHOLDER.fullmatch(value.strip()) is not None


class Values(Mapping[str, str]):
    """The env file's real values, read-only.

    An empty value and an unfilled `<...>` placeholder both count as unset.
    `placeholders` keeps the names (never the text) of the unfilled ones, so
    an error can say which line still needs a real value.
    """

    def __init__(self, raw: Mapping[str, str | None] | None = None) -> None:
        items = dict(raw or {})
        self._set = {name: value for name, value in items.items()
                     if value and not is_placeholder(value)}
        self.placeholders = frozenset(
            name for name, value in items.items() if is_placeholder(value))

    def __getitem__(self, name: str) -> str:
        return self._set[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._set)

    def __len__(self) -> int:
        return len(self._set)


def load(path: Path) -> Values:
    """Read the env file. Empty values and `<...>` placeholders are left out."""
    if not path.is_file():
        raise KbeError(
            f"No local env file at {path}. Copy .env.example to .env and fill it "
            "in, or pass --env-file."
        )
    try:
        from dotenv import dotenv_values
    except ImportError as error:
        raise KbeError(
            "python-dotenv is not installed. Run: pip install -r pullers/requirements.txt"
        ) from error
    try:
        raw = dotenv_values(path)
    except OSError as error:
        raise KbeError(f"Could not read {path}: {error.strerror}.") from error
    return Values(raw)


def load_optional(path: Path) -> Values:
    """Like `load`, but a missing file is just no values."""
    if not path.is_file():
        return Values()
    return load(path)


WRAPPED_HELP = "A value wrapped in <...> counts as not filled in; remove the brackets."


def _missing_text(values: Mapping[str, str], missing: Iterable[str]) -> str:
    """The missing names, and what a `<...>` value means when one of them has it."""
    unfilled = getattr(values, "placeholders", frozenset())
    names = list(missing)
    listed = ", ".join(
        f"{name} (still the example placeholder)" if name in unfilled else name
        for name in names
    )
    return f"{listed}. {WRAPPED_HELP}" if unfilled.intersection(names) else f"{listed}."


def require(values: Mapping[str, str], *names: str) -> dict[str, str]:
    """The named values, or an error that lists the missing names (only names)."""
    missing = [name for name in names if not values.get(name)]
    if missing:
        raise KbeError(
            f"Missing in your local env file: {_missing_text(values, missing)} "
            "See .env.example for what each one is; `python -m kbe env check` shows every line."
        )
    return {name: values[name] for name in names}


def mask(value: str | None) -> str:
    """A stand-in for display. Shows the length and no part of the value."""
    if not value:
        return "(not set)"
    return f"{MASK} ({len(value)} chars)"


def redact(text: str, values: Mapping[str, str]) -> str:
    """Replace any known credential that appears in `text`."""
    cleaned = text
    for value in sorted(set(values.values()), key=len, reverse=True):
        if len(value) >= _MIN_REDACT_LENGTH:
            cleaned = cleaned.replace(value, MASK)
    return cleaned


def describe(values: Mapping[str, str], names: Iterable[str]) -> list[str]:
    """`NAME = <masked>` lines, for showing what is and is not set."""
    return [f"{name} = {mask(values.get(name))}" for name in names]
