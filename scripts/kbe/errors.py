"""Errors the CLI turns into a clear message and a non-zero exit."""

from __future__ import annotations


class KbeError(Exception):
    """Something the user can act on. The message is shown as-is."""

    exit_code = 1


class UsageError(KbeError):
    """The command was called in a way that cannot work."""

    exit_code = 2
