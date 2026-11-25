"""The file and `git` / `gh` work behind `kbe repo`.

Every program is run through the context's runner, with the clone as its
working folder. Nothing here takes or passes a credential: `gh` and `git` use
the logins the person already has on this machine.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Sequence

from . import proc
from .errors import KbeError
from .repo_config import CONFIG_DIR, CONFIG_FILE

TEMPLATE = Path("templates") / "knowledge-repo"
BRANCH = "main"
_GIT_TIMEOUT = 180


def template_dir(root: Path) -> Path:
    found = root / TEMPLATE
    if not found.is_dir():
        raise KbeError(f"The knowledge repo template is missing from this checkout: {found}")
    return found


def template_files(root: Path) -> tuple[str, ...]:
    """Every file in the template, as a path relative to it."""
    base = template_dir(root)
    return tuple(sorted(str(p.relative_to(base)) for p in base.rglob("*") if p.is_file()))


def _must(result: proc.ProcResult, what: str, hint: str = "") -> proc.ProcResult:
    if result.ok:
        return result
    reason = (result.stderr or result.stdout).strip() or f"exit code {result.code}"
    tail = f"\n{hint}" if hint else ""
    raise KbeError(f"{what} failed:\n{reason}{tail}")


def _git(runner: proc.Runner, clone: Path, *args: str) -> proc.ProcResult:
    return runner(["git", *args], cwd=clone, timeout=_GIT_TIMEOUT)


def branch_count(runner: proc.Runner, repo: str) -> int:
    """How many branches the GitHub repo has. Zero means it holds no commit."""
    result = _must(
        runner(["gh", "api", f"repos/{repo}/branches", "--jq", "length"], timeout=60),
        f"Looking up {repo} on GitHub",
        "Check the name, and that `gh auth status` shows a login that can see it.",
    )
    try:
        return int(result.stdout.strip())
    except ValueError as error:
        raise KbeError(f"GitHub gave an unreadable answer about {repo}.") from error


def create_remote(runner: proc.Runner, repo: str) -> None:
    _must(
        runner(["gh", "repo", "create", repo, "--private"], timeout=120),
        f"Creating the private repository {repo}",
        "If it already exists, re-run with --use instead of --create.",
    )


def clone(runner: proc.Runner, repo: str, target: Path) -> None:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise KbeError(f"Could not create {target.parent}: {error.strerror}.") from error
    _must(
        runner(["gh", "repo", "clone", repo, str(target)], timeout=_GIT_TIMEOUT),
        f"Cloning {repo} to {target}",
        f"The repository itself is untouched. Re-run with --use {repo} once this is fixed.",
    )
    if not target.is_dir():
        raise KbeError(f"Cloning {repo} reported success, but {target} is not there.")


def current_branch(runner: proc.Runner, clone_path: Path) -> str:
    result = _must(
        _git(runner, clone_path, "rev-parse", "--abbrev-ref", "HEAD"), "Reading the branch"
    )
    return result.stdout.strip()


def _write(target: Path, text: str) -> None:
    """Create one file. An existing file is never replaced."""
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "x", encoding="utf-8") as stream:
            stream.write(text)
    except FileExistsError as error:
        raise KbeError(f"{target} already exists; it was left as it is.") from error
    except OSError as error:
        raise KbeError(f"Could not write {target}: {error.strerror}.") from error


def write_config(clone_path: Path, text: str) -> str:
    """Write .kb-engine/engine.yaml. Refuses a clone that already has that folder."""
    if (clone_path / CONFIG_DIR).exists():
        raise KbeError(
            f"{clone_path / CONFIG_DIR} already exists. This repository is already set up "
            "for an Engine; edit its engine.yaml instead. Nothing was changed."
        )
    _write(clone_path / CONFIG_FILE, text)
    return CONFIG_FILE


def copy_template(root: Path, clone_path: Path) -> tuple[str, ...]:
    """Copy the scaffold into an empty clone. Returns what was written."""
    base = template_dir(root)
    names = template_files(root)
    clashes = [name for name in names if (clone_path / name).exists()]
    if clashes:
        raise KbeError(
            f"{clone_path} already has: {', '.join(clashes)}. Nothing was copied. "
            "Use --adopt to add only the Engine config to a repository with content."
        )
    for name in names:
        target = clone_path / name
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(base / name, target)
        except OSError as error:
            raise KbeError(f"Could not write {target}: {error.strerror}.") from error
    return names


def start_main(runner: proc.Runner, clone_path: Path) -> None:
    """Point a clone with no commit at the branch the Engine reads."""
    _must(
        _git(runner, clone_path, "symbolic-ref", "HEAD", f"refs/heads/{BRANCH}"),
        f"Starting the {BRANCH} branch",
    )


def commit_and_push(
    runner: proc.Runner, clone_path: Path, paths: Sequence[str], message: str
) -> None:
    """Commit exactly `paths` as the person's own git identity and push."""
    _must(_git(runner, clone_path, "add", "--", *paths), "git add")
    _must(
        _git(runner, clone_path, "commit", "-m", message, "--", *paths),
        "git commit",
        "If git does not know who you are, set user.name and user.email "
        f"(git config --global ...), then commit and push in {clone_path} yourself.",
    )
    _must(
        _git(runner, clone_path, "push", "-u", "origin", f"HEAD:{BRANCH}"),
        "git push",
        f"The commit is saved in {clone_path}. Fix the cause, then run `git push` there.",
    )


def is_clean(runner: proc.Runner, clone_path: Path) -> bool:
    result = _must(_git(runner, clone_path, "status", "--porcelain"), "git status")
    return result.stdout.strip() == ""


def sync_state(runner: proc.Runner, clone_path: Path) -> tuple[int, int]:
    """(commits only on the remote, commits only here) against origin/main."""
    _must(_git(runner, clone_path, "fetch", "origin"), "git fetch")
    result = _must(
        _git(runner, clone_path, "rev-list", "--left-right", "--count",
             f"origin/{BRANCH}...HEAD"),
        f"Comparing with origin/{BRANCH}",
    )
    try:
        behind, ahead = (int(part) for part in result.stdout.split())
    except ValueError as error:
        raise KbeError("git gave an unreadable answer about the remote.") from error
    return behind, ahead
