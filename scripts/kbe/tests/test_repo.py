"""`kbe repo init` and `kbe repo status`, with `gh` and `git` faked."""

from __future__ import annotations

import dataclasses
import re
from pathlib import Path

import pytest

from kbe import cli, config_cmd, context, proc, repo_scaffold, state
from kbe.errors import KbeError, UsageError
from kbe.tests.helpers import FakeRunner, make_context

REPO_ROOT = context.repo_root()
SLUG = "acme/knowledge"
FLAGS = [
    "--engine-id", "acme", "--engine-name", "Acme's Knowledge Base Engine",
    "--owner-email", "Owner@Example.com", "--owner-name", "Pat Owner",
    "--topic", "consulting=Consulting", "--topic", "private=Private:sensitive",
    "--sources", "drive",
]
# Nothing that belongs to one deployment: a sign-in team name, an AUD tag, a
# real-looking email address or a GitHub owner.
OWNER_STRINGS = re.compile(
    r"[a-z0-9-]+\.cloudflareaccess\.com|\b[0-9a-f]{64}\b|github\.com/|"
    r"[\w.+-]+@(?!example\.(?:com|org)\b)[\w-]+\.[a-z]{2,}",
    re.IGNORECASE,
)


def _ok(stdout=""):
    return proc.ProcResult(0, stdout, "")


def _fail(stderr="boom"):
    return proc.ProcResult(1, "", stderr)


def _fake_clone(existing=()):
    """A `gh repo clone` that makes the folder, with a .git and any given files."""

    def run(argv, _stdin):
        target = Path(argv[-1])
        (target / ".git").mkdir(parents=True)
        for name in existing:
            (target / name).parent.mkdir(parents=True, exist_ok=True)
            (target / name).write_text("kept\n", encoding="utf-8")
        return _ok()

    return run


def _setup(tmp_path, answers=None, confirm=None):
    runner = FakeRunner({"gh repo clone": _fake_clone(), **(answers or {})})
    base, seen = make_context(tmp_path, runner=runner, confirm=confirm)
    ctx = dataclasses.replace(base, root=REPO_ROOT, state_override=tmp_path / "state.json")
    return ctx, seen, runner


def _init(ctx, *argv):
    return cli.main(["repo", "init", *argv], ctx=ctx)


def _mutating(runner):
    return [line for line in runner.lines() if not line.startswith("gh api")]


# --- answers are checked first -----------------------------------------------


def test_help_exists(capsys):
    for argv in (["repo", "--help"], ["repo", "init", "--help"], ["repo", "status", "--help"]):
        with pytest.raises(SystemExit) as stopped:
            cli.main(argv)
        assert stopped.value.code == 0
        assert len(capsys.readouterr().out) > 120, argv


def test_a_missing_answer_is_named(tmp_path):
    ctx, _seen, runner = _setup(tmp_path)
    args = cli.build_parser().parse_args(
        ["repo", "init", "--create", SLUG, "--engine-id", "acme", "--path", str(tmp_path / "k")]
    )
    with pytest.raises(UsageError, match=r"--engine-name, --owner-email"):
        args.func(args, ctx)
    assert runner.calls == []


def test_an_invalid_config_stops_before_anything_runs(tmp_path, capsys):
    ctx, _seen, runner = _setup(tmp_path)
    code = _init(ctx, "--create", SLUG, "--engine-id", "Bad Id", "--engine-name", "X",
                 "--owner-email", "nope", "--path", str(tmp_path / "k"), "--yes")
    assert code == 1
    error = capsys.readouterr().err
    assert "engine.id" in error and "engine.owner.email" in error
    assert runner.calls == []
    assert not (tmp_path / "k").exists()
    assert not ctx.state_file.exists()


def test_adopt_needs_use(tmp_path):
    ctx, _seen, runner = _setup(tmp_path)
    args = cli.build_parser().parse_args(["repo", "init", "--create", SLUG, "--adopt", *FLAGS])
    with pytest.raises(UsageError, match="--adopt goes with --use"):
        args.func(args, ctx)
    assert runner.calls == []


def test_a_target_folder_with_content_is_refused(tmp_path):
    ctx, _seen, runner = _setup(tmp_path)
    target = tmp_path / "k"
    target.mkdir()
    (target / "notes.md").write_text("mine\n", encoding="utf-8")
    args = cli.build_parser().parse_args(
        ["repo", "init", "--create", SLUG, *FLAGS, "--path", str(target), "--yes"]
    )
    with pytest.raises(KbeError, match="not empty"):
        args.func(args, ctx)
    assert runner.calls == []


def test_the_default_path_is_named_after_the_engine(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ctx, seen, _runner = _setup(tmp_path)
    assert _init(ctx, "--create", SLUG, *FLAGS, "--dry-run") == 0
    assert any(str(tmp_path / "knowledge-acme") in line for line in seen)


# --- dry run and confirmation ---------------------------------------------------


def test_dry_run_changes_nothing(tmp_path):
    ctx, seen, runner = _setup(tmp_path, {"gh api": _ok("0\n")})
    target = tmp_path / "k"
    assert _init(ctx, "--use", SLUG, *FLAGS, "--path", str(target), "--dry-run") == 0
    assert _mutating(runner) == []
    assert not target.exists()
    assert not ctx.state_file.exists()
    assert seen[-1] == "Dry run: nothing was changed."
    assert any("use the existing GitHub repository acme/knowledge" in line for line in seen)


def test_without_a_yes_nothing_is_created(tmp_path, capsys):
    ctx, _seen, runner = _setup(tmp_path, confirm=lambda _question: False)
    assert _init(ctx, "--create", SLUG, *FLAGS, "--path", str(tmp_path / "k")) == 1
    assert "Nothing was changed" in capsys.readouterr().err
    assert runner.calls == []


def test_a_yes_at_the_prompt_goes_ahead(tmp_path):
    asked = []
    ctx, _seen, runner = _setup(tmp_path, confirm=lambda q: asked.append(q) or True)
    assert _init(ctx, "--create", SLUG, *FLAGS, "--path", str(tmp_path / "k")) == 0
    assert len(asked) == 1
    assert runner.lines()[0] == f"gh repo create {SLUG} --private"


# --- create ---------------------------------------------------------------------


def test_create_makes_a_private_repo_fills_it_and_pushes(tmp_path):
    ctx, seen, runner = _setup(tmp_path)
    target = tmp_path / "k"
    assert _init(ctx, "--create", SLUG, *FLAGS, "--path", str(target), "--yes") == 0

    lines = runner.lines()
    assert lines[0] == f"gh repo create {SLUG} --private"
    assert lines[1] == f"gh repo clone {SLUG} {target}"
    assert lines[2] == "git symbolic-ref HEAD refs/heads/main"
    assert lines[3].startswith("git add -- ")
    assert lines[4].startswith("git commit -m Set up the knowledge repo for Acme's Knowledge Base Engine -- ")
    assert lines[5] == "git push -u origin HEAD:main"
    assert all(call["cwd"] == target for call in runner.calls[2:])

    for name in ("README.md", "CLAUDE.md", "index.md", ".gitignore", "concepts/.gitkeep",
                 "decisions/.gitkeep", "projects/.gitkeep", "people/.gitkeep",
                 "meetings/.gitkeep", ".kb-engine/engine.yaml"):
        assert (target / name).is_file(), name
        assert name in runner.calls[3]["argv"]

    config = config_cmd.read_config(target / ".kb-engine" / "engine.yaml")
    assert config["sources"]["wiki"]["repo"] == SLUG
    assert config["sources"]["drive"]["enabled"] is True
    assert config["engine"]["owner"]["email"] == "owner@example.com"

    saved = state.load(ctx.state_file)
    assert saved["answers"] == {
        "wiki_repo": SLUG, "knowledge_repo_path": str(target),
        "engine_id": "acme", "owner_email": "owner@example.com",
    }
    assert state.phase_done(saved, "knowledge_repo")
    said = "\n".join(seen)
    assert "Open folder as vault" in said
    assert f"python -m kbe config apply {target}/.kb-engine/engine.yaml" in said


def test_a_failed_create_stops_there(tmp_path, capsys):
    ctx, _seen, runner = _setup(tmp_path, {"gh repo create": _fail("name already exists")})
    assert _init(ctx, "--create", SLUG, *FLAGS, "--path", str(tmp_path / "k"), "--yes") == 1
    error = capsys.readouterr().err
    assert "name already exists" in error and "--use" in error
    assert len(runner.calls) == 1
    assert not ctx.state_file.exists()


def test_a_failed_push_keeps_the_commit_and_records_nothing(tmp_path, capsys):
    ctx, _seen, _runner = _setup(tmp_path, {"git push": _fail("rejected")})
    assert _init(ctx, "--create", SLUG, *FLAGS, "--path", str(tmp_path / "k"), "--yes") == 1
    assert "rejected" in capsys.readouterr().err
    assert not ctx.state_file.exists()


def test_a_clone_that_did_not_appear_is_an_error(tmp_path, capsys):
    ctx, _seen, _runner = _setup(tmp_path, {"gh repo clone": _ok()})
    assert _init(ctx, "--create", SLUG, *FLAGS, "--path", str(tmp_path / "k"), "--yes") == 1
    assert "is not there" in capsys.readouterr().err


# --- use and adopt ----------------------------------------------------------------


def test_use_accepts_an_empty_repo_given_as_a_url(tmp_path):
    ctx, _seen, runner = _setup(tmp_path, {"gh api": _ok("0\n")})
    target = tmp_path / "k"
    code = _init(ctx, "--use", "https://github.com/acme/knowledge.git", *FLAGS,
                 "--path", str(target), "--yes")
    assert code == 0
    assert runner.lines()[0] == f"gh api repos/{SLUG}/branches --jq length"
    assert not any(line.startswith("gh repo create") for line in runner.lines())
    assert (target / "README.md").is_file()


def test_use_refuses_a_repo_with_content(tmp_path, capsys):
    ctx, _seen, runner = _setup(tmp_path, {"gh api": _ok("2\n")})
    assert _init(ctx, "--use", SLUG, *FLAGS, "--path", str(tmp_path / "k"), "--yes") == 1
    assert "--adopt" in capsys.readouterr().err
    assert _mutating(runner) == []
    assert not (tmp_path / "k").exists()


def test_use_reports_a_repo_it_cannot_see(tmp_path, capsys):
    ctx, _seen, _runner = _setup(tmp_path, {"gh api": _fail("HTTP 404")})
    assert _init(ctx, "--use", SLUG, *FLAGS, "--path", str(tmp_path / "k"), "--yes") == 1
    assert "gh auth status" in capsys.readouterr().err


def test_an_unreadable_branch_count_is_an_error(tmp_path, capsys):
    ctx, _seen, _runner = _setup(tmp_path, {"gh api": _ok("what\n")})
    assert _init(ctx, "--use", SLUG, *FLAGS, "--path", str(tmp_path / "k"), "--yes") == 1
    assert "unreadable" in capsys.readouterr().err


def test_adopt_adds_only_the_config(tmp_path):
    answers = {
        "gh repo clone": _fake_clone(existing=("README.md", "notes/a.md")),
        "git rev-parse --abbrev-ref HEAD": _ok("main\n"),
    }
    ctx, seen, runner = _setup(tmp_path, answers)
    target = tmp_path / "k"
    assert _init(ctx, "--use", SLUG, "--adopt", *FLAGS, "--path", str(target), "--yes") == 0

    assert (target / "README.md").read_text(encoding="utf-8") == "kept\n"
    files = sorted(
        str(p.relative_to(target)) for p in target.rglob("*")
        if p.is_file() and ".git" not in p.relative_to(target).parts[:1]
    )
    assert files == [".kb-engine/engine.yaml", "README.md", "notes/a.md"]
    lines = runner.lines()
    assert "git add -- .kb-engine/engine.yaml" in lines
    assert any(line.endswith("-- .kb-engine/engine.yaml") and line.startswith("git commit")
               for line in lines)
    assert not any("symbolic-ref" in line or line.startswith("gh api") for line in lines)
    assert any("add only .kb-engine/engine.yaml" in line for line in seen)


def test_adopt_refuses_a_repo_that_already_has_a_config_folder(tmp_path, capsys):
    answers = {
        "gh repo clone": _fake_clone(existing=(".kb-engine/engine.yaml",)),
        "git rev-parse --abbrev-ref HEAD": _ok("main\n"),
    }
    ctx, _seen, runner = _setup(tmp_path, answers)
    target = tmp_path / "k"
    assert _init(ctx, "--use", SLUG, "--adopt", *FLAGS, "--path", str(target), "--yes") == 1
    assert "already set up" in capsys.readouterr().err
    assert (target / ".kb-engine" / "engine.yaml").read_text(encoding="utf-8") == "kept\n"
    assert not any(line.startswith(("git add", "git commit", "git push"))
                   for line in runner.lines())


def test_adopt_refuses_a_default_branch_that_is_not_main(tmp_path, capsys):
    answers = {
        "gh repo clone": _fake_clone(existing=("README.md",)),
        "git rev-parse --abbrev-ref HEAD": _ok("master\n"),
    }
    ctx, _seen, _runner = _setup(tmp_path, answers)
    target = tmp_path / "k"
    assert _init(ctx, "--use", SLUG, "--adopt", *FLAGS, "--path", str(target), "--yes") == 1
    assert '"master"' in capsys.readouterr().err
    assert not (target / ".kb-engine").exists()


def test_the_scaffold_never_overwrites_a_file(tmp_path):
    clone = tmp_path / "clone"
    (clone / "concepts").mkdir(parents=True)
    (clone / "README.md").write_text("mine\n", encoding="utf-8")
    with pytest.raises(KbeError, match="README.md"):
        repo_scaffold.copy_template(REPO_ROOT, clone)
    assert (clone / "README.md").read_text(encoding="utf-8") == "mine\n"
    assert not (clone / "index.md").exists()


def test_a_checkout_without_the_template_says_so(tmp_path):
    with pytest.raises(KbeError, match="template is missing"):
        repo_scaffold.template_dir(tmp_path)


# --- the template -------------------------------------------------------------------


def test_the_template_has_what_a_vault_needs_and_nothing_personal():
    names = repo_scaffold.template_files(REPO_ROOT)
    for name in ("README.md", "CLAUDE.md", "index.md", ".gitignore", "concepts/.gitkeep",
                 "decisions/.gitkeep", "projects/.gitkeep", "people/.gitkeep",
                 "meetings/.gitkeep"):
        assert name in names
    assert not any(name.startswith(".kb-engine") for name in names)
    base = repo_scaffold.template_dir(REPO_ROOT)
    for name in names:
        text = (base / name).read_text(encoding="utf-8")
        assert OWNER_STRINGS.search(text) is None, name
    rules = (base / "CLAUDE.md").read_text(encoding="utf-8")
    assert "domains: [topic-id]" in rules
    assert "only the owner can see it" in rules
    assert ".obsidian/workspace*" in (base / ".gitignore").read_text(encoding="utf-8")
