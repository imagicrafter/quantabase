"""What every command is handed: where things are and how to talk to the user."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import proc

STATE_DIR = ".kb-engine-local"
ENV_FILE_VAR = "KBE_ENV_FILE"
STATE_FILE_VAR = "KBE_STATE_FILE"


def repo_root() -> Path:
    """The checkout this CLI lives in (scripts/kbe/ -> repo root)."""
    return Path(__file__).resolve().parent.parent.parent


def _print(text: str) -> None:
    print(text)


def _ask(question: str) -> bool:
    if not sys.stdin.isatty():
        return False
    try:
        answer = input(f"{question} [y/N] ")
    except EOFError:
        return False
    return answer.strip().lower() in ("y", "yes")


@dataclass(frozen=True)
class Context:
    root: Path
    env_file: Path
    out: Callable[[str], None] = _print
    runner: proc.Runner = proc.run
    confirm: Callable[[str], bool] = _ask
    state_override: Path | None = None

    @property
    def state_file(self) -> Path:
        return self.state_override or self.root / STATE_DIR / "state.json"

    @property
    def migrations_dir(self) -> Path:
        return self.root / "supabase" / "migrations"

    @property
    def manifest_file(self) -> Path:
        return self.root / "setup" / "manifest.yaml"


def build(env_file: str | None = None, root: Path | None = None) -> Context:
    """The real context.

    Env file: --env-file, then KBE_ENV_FILE, then <repo>/.env.
    State file: KBE_STATE_FILE, then <repo>/.kb-engine-local/state.json.
    """
    base = root or repo_root()
    chosen = env_file or os.environ.get(ENV_FILE_VAR)
    path = Path(chosen).expanduser() if chosen else base / ".env"
    state_file = os.environ.get(STATE_FILE_VAR)
    return Context(
        root=base,
        env_file=path if path.is_absolute() else Path.cwd() / path,
        state_override=Path(state_file).expanduser().absolute() if state_file else None,
    )
