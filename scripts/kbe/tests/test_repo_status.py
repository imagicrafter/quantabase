"""`kbe repo status`, and `init` end to end with real git on a local remote."""

from __future__ import annotations

import dataclasses
import shutil
from pathlib import Path

import pytest

from kbe import cli, proc, state
from kbe.tests.helpers import make_context
from kbe.tests.test_repo import FLAGS, REPO_ROOT, SLUG, _fail, _init, _ok, _setup


# --- status -------------------------------------------------------------------------


def _clone_with_config(tmp_path):
    clone = tmp_path / "k"
    (clone / ".git").mkdir(parents=True)
    (clone / ".kb-engine").mkdir()
    shutil.copyfile(REPO_ROOT / "config" / "engine.example.yaml",
                    clone / ".kb-engine" / "engine.yaml")
    return clone


def test_status_passes_for_a_clean_clone_in_sync(tmp_path):
    clone = _clone_with_config(tmp_path)
    ctx, seen, runner = _setup(tmp_path, {"git rev-list": _ok("0\t0\n")})
    assert cli.main(["repo", "status", "--path", str(clone)], ctx=ctx) == 0
    assert [line[:4] for line in seen] == ["ok  "] * 4
    assert "git fetch origin" in runner.lines()
    assert all(call["cwd"] == clone for call in runner.calls)


def test_status_uses_the_recorded_path(tmp_path):
    clone = _clone_with_config(tmp_path)
    ctx, seen, _runner = _setup(tmp_path, {"git rev-list": _ok("0\t0\n")})
    state.save(ctx.state_file, state.with_answer(state.empty(), "knowledge_repo_path", str(clone)))
    assert cli.main(["repo", "status"], ctx=ctx) == 0
    assert str(clone) in seen[0]


def test_status_needs_a_path_from_somewhere(tmp_path, capsys):
    ctx, _seen, _runner = _setup(tmp_path)
    assert cli.main(["repo", "status"], ctx=ctx) == 2
    assert "kbe repo init" in capsys.readouterr().err


def test_status_fails_when_there_is_no_clone(tmp_path):
    ctx, seen, runner = _setup(tmp_path)
    assert cli.main(["repo", "status", "--path", str(tmp_path / "nowhere")], ctx=ctx) == 1
    assert seen[0].startswith("FAIL  clone")
    assert runner.calls == []


def test_status_reports_each_problem_and_keeps_going(tmp_path):
    clone = _clone_with_config(tmp_path)
    (clone / ".kb-engine" / "engine.yaml").write_text("version: 2\n", encoding="utf-8")
    answers = {"git status": _ok(" M index.md\n"), "git rev-list": _ok("2\t1\n")}
    ctx, seen, _runner = _setup(tmp_path, answers)
    assert cli.main(["repo", "status", "--path", str(clone)], ctx=ctx) == 1
    assert seen[1].startswith("FAIL  clean")
    assert "1 commit(s) not pushed, 2 not pulled" in seen[2]
    assert seen[3].startswith("FAIL  config")


def test_status_reports_a_failed_fetch(tmp_path):
    clone = _clone_with_config(tmp_path)
    ctx, seen, _runner = _setup(tmp_path, {"git fetch": _fail("no network")})
    assert cli.main(["repo", "status", "--path", str(clone)], ctx=ctx) == 1
    assert seen[2].startswith("FAIL  in sync: git fetch failed")


# --- with real git, against a local bare repository ------------------------------------


def _local_runner(bare: Path, branches: str):
    """Real `git`; `gh` is answered locally (clone comes from the bare repo)."""

    def run(argv, *, extra=None, stdin=None, cwd=None, timeout=300):
        if argv[:3] == ["gh", "repo", "clone"]:
            return proc.run(["git", "clone", str(bare), argv[-1]])
        if argv[:2] == ["gh", "api"]:
            return proc.ProcResult(0, branches, "")
        if argv[0] == "gh":
            return proc.ProcResult(0, "", "")
        return proc.run(argv, extra=extra, stdin=stdin, cwd=cwd, timeout=timeout)

    return run


@pytest.fixture
def git_identity(monkeypatch, tmp_path):
    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    for name, value in (
        ("GIT_AUTHOR_NAME", "Test"), ("GIT_AUTHOR_EMAIL", "test@example.com"),
        ("GIT_COMMITTER_NAME", "Test"), ("GIT_COMMITTER_EMAIL", "test@example.com"),
        ("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig")), ("GIT_CONFIG_NOSYSTEM", "1"),
    ):
        monkeypatch.setenv(name, value)


def test_init_then_status_with_real_git(tmp_path, git_identity):
    bare = tmp_path / "remote.git"
    assert proc.run(["git", "init", "--bare", str(bare)]).ok
    base, seen = make_context(tmp_path, runner=_local_runner(bare, "0\n"))
    ctx = dataclasses.replace(base, root=REPO_ROOT, state_override=tmp_path / "state.json")
    target = tmp_path / "vault"

    assert _init(ctx, "--use", SLUG, *FLAGS, "--path", str(target), "--yes") == 0
    pushed = proc.run(["git", "--git-dir", str(bare), "ls-tree", "-r", "--name-only", "main"])
    assert pushed.ok
    names = pushed.stdout.split()
    assert ".kb-engine/engine.yaml" in names and "meetings/.gitkeep" in names

    seen.clear()
    assert cli.main(["repo", "status"], ctx=ctx) == 0
    assert all(line.startswith("ok") for line in seen)

    (target / "index.md").write_text("changed\n", encoding="utf-8")
    assert cli.main(["repo", "status"], ctx=ctx) == 1


def test_adopt_with_real_git_touches_nothing_else(tmp_path, git_identity):
    bare = tmp_path / "remote.git"
    seed = tmp_path / "seed"
    assert proc.run(["git", "init", "--bare", "--initial-branch", "main", str(bare)]).ok
    assert proc.run(["git", "clone", str(bare), str(seed)]).ok
    (seed / "README.md").write_text("theirs\n", encoding="utf-8")
    for argv in (["symbolic-ref", "HEAD", "refs/heads/main"], ["add", "--", "README.md"],
                 ["commit", "-m", "first"], ["push", "origin", "HEAD:main"]):
        assert proc.run(["git", *argv], cwd=seed).ok, argv
    base, _seen = make_context(tmp_path, runner=_local_runner(bare, "1\n"))
    ctx = dataclasses.replace(base, root=REPO_ROOT, state_override=tmp_path / "state.json")
    target = tmp_path / "vault"

    assert _init(ctx, "--use", SLUG, "--adopt", *FLAGS, "--path", str(target), "--yes") == 0
    changed = proc.run(
        ["git", "--git-dir", str(bare), "diff", "--name-only", "main~1", "main"]
    )
    assert changed.stdout.split() == [".kb-engine/engine.yaml"]
    assert (target / "README.md").read_text(encoding="utf-8") == "theirs\n"
    assert not (target / "CLAUDE.md").exists()
