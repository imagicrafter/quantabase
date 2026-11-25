"""Shared fakes for the kbe tests."""

from __future__ import annotations

from pathlib import Path

from kbe import context, proc


class FakeRunner:
    """Stands in for `proc.run`. Records every call; answers from a script.

    `answers` maps a prefix of argv (joined with spaces) to a ProcResult, or
    to a function `(argv, stdin) -> ProcResult`. The longest match wins.
    Anything unmatched succeeds with no output.
    """

    def __init__(self, answers=None):
        self.answers = dict(answers or {})
        self.calls = []

    def __call__(self, argv, *, extra=None, stdin=None, cwd=None, timeout=None):
        self.calls.append({"argv": list(argv), "extra": dict(extra or {}), "stdin": stdin,
                           "cwd": cwd})
        line = " ".join(argv)
        matches = sorted((k for k in self.answers if line.startswith(k)), key=len, reverse=True)
        if not matches:
            return proc.ProcResult(0, "", "")
        answer = self.answers[matches[0]]
        return answer(list(argv), stdin) if callable(answer) else answer

    def lines(self):
        return [" ".join(call["argv"]) for call in self.calls]


def make_context(tmp_path: Path, runner=None, confirm=None):
    """A Context rooted in a temp folder, with captured output."""
    seen: list[str] = []
    ctx = context.Context(
        root=tmp_path,
        env_file=tmp_path / "local.env",
        out=seen.append,
        runner=runner or FakeRunner(),
        confirm=confirm or (lambda _question: False),
    )
    return ctx, seen
