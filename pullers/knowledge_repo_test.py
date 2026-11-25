#!/usr/bin/env python3
"""`knowledge_repo` pushes only its own commit, and never a human's.

    python -m pullers.knowledge_repo_test

Uses a throwaway bare repo as `origin` -- no GitHub, no token.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.knowledge_repo import (  # noqa: E402
    KnowledgeRepoError,
    commit_and_push,
    on_main,
    prepare_local,
)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@t", *args],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def _repo() -> tuple[Path, Path]:
    base = Path(tempfile.mkdtemp())
    origin = base / "origin.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(origin)], check=True, capture_output=True)
    work = base / "work"
    subprocess.run(["git", "clone", str(origin), str(work)], check=True, capture_output=True)
    _git(work, "checkout", "-b", "main")
    (work / "seed.md").write_text("seed\n")
    _git(work, "add", "seed.md")
    _git(work, "commit", "-m", "seed")
    _git(work, "push", "origin", "main")
    return origin, work


def test_commits_only_given_paths_and_pushes() -> None:
    origin, work = _repo()
    (work / "meetings").mkdir()
    (work / "meetings/a.md").write_text("page\n")
    (work / "dirty.md").write_text("human draft\n")
    sha = commit_and_push(work, ["meetings/a.md"], "wiki(auto): test")
    assert sha
    assert _git(origin, "log", "-1", "--format=%s", "main") == "wiki(auto): test"
    files = _git(origin, "show", "--name-only", "--format=", "main")
    assert files == "meetings/a.md", files
    assert (work / "dirty.md").exists()
    assert on_main(work, "meetings/a.md")


def test_nothing_staged_returns_empty() -> None:
    _origin, work = _repo()
    assert commit_and_push(work, ["seed.md"], "noop") == ""


def test_refuses_when_human_commit_unpushed() -> None:
    origin, work = _repo()
    (work / "human.md").write_text("mine\n")
    _git(work, "add", "human.md")
    _git(work, "commit", "-m", "human work")
    try:
        prepare_local(work)
        raise AssertionError("prepare_local should refuse")
    except KnowledgeRepoError:
        pass
    (work / "meetings").mkdir()
    (work / "meetings/b.md").write_text("page\n")
    try:
        commit_and_push(work, ["meetings/b.md"], "wiki(auto): b")
        raise AssertionError("commit_and_push should refuse")
    except KnowledgeRepoError:
        pass
    assert _git(origin, "log", "-1", "--format=%s", "main") == "seed"
    assert _git(work, "log", "-1", "--format=%s") == "human work"  # bot commit undone


def test_refuses_off_main() -> None:
    _origin, work = _repo()
    _git(work, "checkout", "-b", "feature")
    try:
        prepare_local(work)
        raise AssertionError("should refuse off main")
    except KnowledgeRepoError:
        pass


def test_rebases_onto_newer_origin() -> None:
    origin, work = _repo()
    other = work.parent / "other"
    subprocess.run(["git", "clone", str(origin), str(other)], check=True, capture_output=True)
    (other / "x.md").write_text("x\n")
    _git(other, "add", "x.md")
    _git(other, "commit", "-m", "someone else")
    _git(other, "push", "origin", "main")
    (work / "meetings").mkdir()
    (work / "meetings/c.md").write_text("page\n")
    assert commit_and_push(work, ["meetings/c.md"], "wiki(auto): c")
    log = _git(origin, "log", "--format=%s", "main").splitlines()
    assert log[:2] == ["wiki(auto): c", "someone else"], log


TESTS = [
    test_commits_only_given_paths_and_pushes,
    test_nothing_staged_returns_empty,
    test_refuses_when_human_commit_unpushed,
    test_refuses_off_main,
    test_rebases_onto_newer_origin,
]


def main() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
