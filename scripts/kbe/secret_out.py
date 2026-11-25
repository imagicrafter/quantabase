"""Handing a newly made secret to a person without putting it on the screen.

A command that makes a secret (a setup code, a token, a connection string)
takes exactly one of:

    --clipboard   copy it to the clipboard; nothing secret is printed
    --out FILE    write NAME=value to a new file only its owner can read (0600)
    --show        print it once in the terminal -- for a person, in their own
                  terminal. Refused when the output is not a terminal, so a
                  program or an assistant session cannot use it.

With none of the three the command refuses before it changes anything, so a
secret is never made and then lost, and never printed by default. The choice
is checked first (`choose`), the secret is handed over last (`Delivery.send`).
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from . import sources_drive
from .context import Context
from .errors import KbeError, UsageError

CLIPBOARD, FILE, SHOW = "clipboard", "file", "show"

_NO_CHOICE = (
    "Say where the {what} should go. It is never printed unless you ask:\n"
    "  --clipboard   copy it to the clipboard (nothing secret is printed)\n"
    "  --out FILE    write it to a new file only you can read\n"
    "  --show        print it once here; only in your own terminal, never when an "
    "assistant or a program runs this command"
)


_NO_TERMINAL = (
    "--show prints the {what}, so it only works when a person is at the terminal. "
    "This command is being run by a program or an assistant. Use --clipboard or --out FILE."
)


def _at_a_terminal() -> bool:
    """True when the output goes to a screen a person is looking at."""
    try:
        return sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


@dataclass(frozen=True)
class Delivery:
    """Where one secret goes. Built before the secret exists."""

    mode: str
    path: Path | None = None

    def send(
        self, ctx: Context, values: Mapping[str, str],
        show: Callable[[Context], None] | None = None,
    ) -> list[str]:
        """Hand the secret over. Returns plain lines that say where it went."""
        names = ", ".join(values)
        if self.mode == SHOW:
            if show is None:
                raise KbeError("This command cannot print its secret. Use --clipboard or --out FILE.")
            show(ctx)
            return []
        if self.mode == FILE and self.path is not None:
            written = sources_drive.to_file(self.path, values)
            return [f"{names} was written to {written} (only you can read it). "
                    "Delete the file once the value is where it belongs."]
        for value in values.values():
            sources_drive.copy(ctx, value)
        return [f"{names} is on the clipboard. Paste it where it belongs, then copy "
                "something else so it does not stay there."]


def add_flags(parser: argparse.ArgumentParser, *, what: str, show: bool = True) -> None:
    """The three ways out, as one either-or group."""
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--clipboard", action="store_true",
                       help=f"copy the {what} to the clipboard; print nothing secret")
    group.add_argument("--out", metavar="FILE",
                       help=f"write the {what} to a new file only you can read (never replaced)")
    if show:
        group.add_argument("--show", action="store_true",
                           help=f"print the {what} once (your own terminal only)")


def choose(args: argparse.Namespace, *, what: str) -> Delivery:
    """The delivery the flags name. Refuses, changing nothing, when none is given."""
    if getattr(args, "clipboard", False):
        return Delivery(CLIPBOARD)
    out = getattr(args, "out", None)
    if out:
        path = Path(out).expanduser()
        if os.path.lexists(path):
            raise UsageError(f"{path} already exists. It is never replaced; name a new file.")
        if not path.parent.is_dir():
            raise UsageError(f"The folder {path.parent} does not exist.")
        return Delivery(FILE, path)
    if getattr(args, "show", False):
        if not _at_a_terminal():
            raise UsageError(_NO_TERMINAL.format(what=what))
        return Delivery(SHOW)
    raise UsageError(_NO_CHOICE.format(what=what))
