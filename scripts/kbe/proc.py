"""Running other programs.

One small wrapper so every command runs children the same way and tests can
swap in a fake. Extra values a child needs (a database password, say) are
passed through `extra`, never on the command line, where `ps` would show them.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence

NOT_FOUND = 127
TIMED_OUT = 124


@dataclass(frozen=True)
class ProcResult:
    code: int
    stdout: str = ""
    stderr: str = ""

    @property
    def ok(self) -> bool:
        return self.code == 0


# (argv, extra=None, stdin=None, cwd=None, timeout=...) -> ProcResult
Runner = Callable[..., ProcResult]


def run(
    argv: Sequence[str],
    *,
    extra: Mapping[str, str] | None = None,
    stdin: str | None = None,
    cwd: Path | str | None = None,
    timeout: float = 300,
) -> ProcResult:
    """Run a program and capture its output. Never raises for a failed child."""
    child_vars = {**os.environ, **(extra or {})}
    try:
        done = subprocess.run(  # noqa: S603 - argv is a list, no shell
            list(argv),
            input=stdin,
            capture_output=True,
            text=True,
            env=child_vars,
            cwd=str(cwd) if cwd is not None else None,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return ProcResult(NOT_FOUND, "", f"{argv[0]}: not installed or not on PATH")
    except subprocess.TimeoutExpired:
        return ProcResult(TIMED_OUT, "", f"{argv[0]}: timed out after {timeout:.0f}s")
    except OSError as error:
        return ProcResult(NOT_FOUND, "", f"{argv[0]}: could not start ({error.strerror})")
    return ProcResult(done.returncode, done.stdout or "", done.stderr or "")
