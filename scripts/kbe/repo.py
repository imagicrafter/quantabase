"""`kbe repo` -- the private knowledge repository.

    kbe repo init (--create OWNER/NAME | --use URL-OR-OWNER/NAME) [--adopt]
                  --engine-id ID --engine-name NAME --owner-email EMAIL
                  [--owner-name NAME ...] [--topic id=Label[:sensitive] ...]
                  [--sources wiki,drive,fireflies,gmail] [--path DIR]
                  [--dry-run] [--yes]
    kbe repo status [--path DIR]

The knowledge repo holds the wiki pages and the Engine config
(.kb-engine/engine.yaml). `init` builds that config from the flags, checks
it, and only then creates, clones, writes and pushes.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import repo_config, repo_scaffold, state
from .context import Context
from .errors import KbeError, UsageError

PHASE = "knowledge_repo"
PATH_ANSWER = "knowledge_repo_path"
REPO_ANSWER = "wiki_repo"
_REQUIRED = (("engine_id", "--engine-id"), ("engine_name", "--engine-name"),
             ("owner_email", "--owner-email"))


@dataclass(frozen=True)
class Plan:
    repo: str
    path: Path
    create: bool
    adopt: bool
    config_text: str
    engine_id: str
    engine_name: str
    owner_email: str


def _answers(args: argparse.Namespace) -> repo_config.Answers:
    missing = [flag for name, flag in _REQUIRED if not (getattr(args, name) or "").strip()]
    if missing:
        raise UsageError(f"Missing: {', '.join(missing)}. See `kbe repo init --help`.")
    return repo_config.Answers(
        engine_id=args.engine_id.strip(),
        engine_name=args.engine_name.strip(),
        owner_email=args.owner_email.strip().lower(),
        owner_names=tuple(name.strip() for name in args.owner_name or () if name.strip()),
        topics=repo_config.parse_topics(args.topic),
        sources=repo_config.parse_sources(args.sources),
    )


def _target(given: str | None, engine_id: str) -> Path:
    path = Path(given).expanduser() if given else Path.home() / f"knowledge-{engine_id}"
    path = path if path.is_absolute() else Path.cwd() / path
    if path.is_file() or (path.is_dir() and any(path.iterdir())):
        raise KbeError(
            f"{path} already exists and is not empty. Choose another --path, or move it aside."
        )
    return path


def make_plan(args: argparse.Namespace) -> Plan:
    """Check every answer. Raises before anything outside this machine is touched."""
    if args.adopt and args.create:
        raise UsageError("--adopt goes with --use: a repository made by --create is empty.")
    repo = repo_config.parse_repo_ref(args.create or args.use)
    answers = _answers(args)
    config = repo_config.build_config(answers, repo)
    repo_config.validate(config)
    return Plan(
        repo=repo,
        path=_target(args.path, answers.engine_id),
        create=bool(args.create),
        adopt=bool(args.adopt),
        config_text=repo_config.render_yaml(config),
        engine_id=answers.engine_id,
        engine_name=answers.engine_name,
        owner_email=answers.owner_email,
    )


def _describe(plan: Plan, root: Path) -> list[str]:
    first = (
        f"create the private GitHub repository {plan.repo}" if plan.create
        else f"use the existing GitHub repository {plan.repo}"
    )
    if plan.adopt:
        files = f"add only {repo_config.CONFIG_FILE} (nothing else is touched)"
    else:
        count = len(repo_scaffold.template_files(root))
        files = f"add the starter vault ({count} files) and {repo_config.CONFIG_FILE}"
    return [
        "This will:",
        f"  1. {first}",
        f"  2. clone it to {plan.path}",
        f"  3. {files}",
        f"  4. commit and push to {repo_scaffold.BRANCH}",
    ]


def _refuse_content(plan: Plan, ctx: Context) -> None:
    """An existing repository must be empty, unless --adopt was given."""
    if plan.create or plan.adopt:
        return
    if repo_scaffold.branch_count(ctx.runner, plan.repo) > 0:
        raise KbeError(
            f"{plan.repo} is not empty. Nothing was changed. To keep its content and add "
            f"only {repo_config.CONFIG_FILE}, re-run with --adopt."
        )


def _write_files(plan: Plan, ctx: Context) -> tuple[str, ...]:
    if plan.adopt:
        branch = repo_scaffold.current_branch(ctx.runner, plan.path)
        if branch != repo_scaffold.BRANCH:
            raise KbeError(
                f'{plan.repo} is on the branch "{branch}". The Engine reads '
                f"{repo_scaffold.BRANCH}; rename the default branch first. Nothing was changed."
            )
        return (repo_scaffold.write_config(plan.path, plan.config_text),)
    repo_scaffold.start_main(ctx.runner, plan.path)
    copied = repo_scaffold.copy_template(ctx.root, plan.path)
    return (*copied, repo_scaffold.write_config(plan.path, plan.config_text))


def _remember(plan: Plan, ctx: Context) -> None:
    answers = {
        REPO_ANSWER: plan.repo,
        PATH_ANSWER: str(plan.path),
        "engine_id": plan.engine_id,
        "owner_email": plan.owner_email,
    }
    updated = state.load(ctx.state_file)
    for key, value in answers.items():
        updated = state.with_answer(updated, key, value)
    state.save(ctx.state_file, state.with_phase(updated, PHASE, "done"))


def _next_steps(plan: Plan) -> list[str]:
    return [
        f"Done. {plan.repo} is cloned at {plan.path}.",
        "",
        "To read and edit it as an Obsidian vault: open Obsidian, choose "
        f'"Open folder as vault", and pick {plan.path}.',
        "",
        "Next, apply the config to the database:",
        f"  python -m kbe config apply {plan.path / repo_config.CONFIG_FILE}",
    ]


def _cmd_init(args: argparse.Namespace, ctx: Context) -> int:
    plan = make_plan(args)
    _refuse_content(plan, ctx)
    for line in _describe(plan, ctx.root):
        ctx.out(line)
    if args.dry_run:
        ctx.out("Dry run: nothing was changed.")
        return 0
    if not args.yes and not ctx.confirm("Go ahead?"):
        raise KbeError("Nothing was changed. Re-run with --yes to go ahead without being asked.")
    if plan.create:
        repo_scaffold.create_remote(ctx.runner, plan.repo)
        ctx.out(f"Created {plan.repo} (private).")
    repo_scaffold.clone(ctx.runner, plan.repo, plan.path)
    written = _write_files(plan, ctx)
    repo_scaffold.commit_and_push(
        ctx.runner, plan.path, written, f"Set up the knowledge repo for {plan.engine_name}"
    )
    _remember(plan, ctx)
    for line in _next_steps(plan):
        ctx.out(line)
    return 0


# --- status -------------------------------------------------------------------


def _status_path(args: argparse.Namespace, ctx: Context) -> Path:
    given = args.path or state.answer(state.load(ctx.state_file), PATH_ANSWER)
    if not given:
        raise UsageError(
            "No knowledge repo is recorded yet. Pass --path, or run `kbe repo init` first."
        )
    path = Path(given).expanduser()
    return path if path.is_absolute() else Path.cwd() / path


def _check_clean(ctx: Context, path: Path) -> str:
    if not repo_scaffold.is_clean(ctx.runner, path):
        raise KbeError("there are changes that are not committed")
    return "nothing uncommitted"


def _check_sync(ctx: Context, path: Path) -> str:
    behind, ahead = repo_scaffold.sync_state(ctx.runner, path)
    if behind or ahead:
        raise KbeError(
            f"{ahead} commit(s) not pushed, {behind} not pulled "
            f"(against origin/{repo_scaffold.BRANCH})"
        )
    return f"in step with origin/{repo_scaffold.BRANCH}"


def _check_config(_ctx: Context, path: Path) -> str:
    from . import config_cmd

    config = config_cmd.read_config(path / repo_config.CONFIG_FILE)
    return f'config is valid (engine "{config["engine"]["id"]}")'


_CHECKS: tuple[tuple[str, Callable[[Context, Path], str]], ...] = (
    ("clean", _check_clean),
    ("in sync", _check_sync),
    ("config", _check_config),
)


def _cmd_status(args: argparse.Namespace, ctx: Context) -> int:
    path = _status_path(args, ctx)
    if not (path / ".git").exists():
        ctx.out(f"FAIL  clone: no git clone at {path}")
        return 1
    ctx.out(f"ok    clone: {path}")
    failed = False
    for name, check in _CHECKS:
        try:
            ctx.out(f"ok    {name}: {check(ctx, path)}")
        except KbeError as error:
            failed = True
            ctx.out(f"FAIL  {name}: {str(error).splitlines()[0]}")
    return 1 if failed else 0


# --- parser -------------------------------------------------------------------


def _add_init(commands: argparse._SubParsersAction) -> None:
    init = commands.add_parser(
        "init",
        help="create or connect the knowledge repo and write its Engine config",
        description="Set up the private GitHub repository that holds your wiki pages and "
        "the Engine config (.kb-engine/engine.yaml). The config is built from the flags "
        "and checked first; nothing is created, cloned or pushed if it is not valid. "
        "A repository that already has content is refused unless --adopt is given, and "
        "then only .kb-engine/engine.yaml is added. Uses your own `gh` and `git` logins.",
    )
    where = init.add_mutually_exclusive_group(required=True)
    where.add_argument("--create", metavar="OWNER/NAME", help="create this private repository")
    where.add_argument("--use", metavar="URL-OR-OWNER/NAME", help="use a repository that exists")
    init.add_argument("--adopt", action="store_true",
                      help="with --use: keep the repository's content, add only the config")
    init.add_argument("--path", metavar="DIR",
                      help="where to clone it (default: ~/knowledge-<engine id>)")
    init.add_argument("--engine-id", help="short id, lower-case letters, digits and dashes")
    init.add_argument("--engine-name", help='display name, e.g. "Acme\'s Quantabase"')
    init.add_argument("--owner-email", help="the owner; becomes the first administrator")
    init.add_argument("--owner-name", action="append", metavar="NAME",
                      help="how the owner appears in meeting notes (repeatable)")
    init.add_argument("--topic", action="append", metavar="ID=LABEL[:sensitive]",
                      help="a topic that decides who sees what (repeatable)")
    init.add_argument("--sources", metavar="LIST",
                      help="comma-separated sources to turn on besides the wiki: "
                      "drive, fireflies, gmail")
    init.add_argument("--dry-run", action="store_true", help="show the plan only")
    init.add_argument("--yes", action="store_true", help="go ahead without asking")
    init.set_defaults(func=_cmd_init)


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "repo",
        help="create or connect the knowledge repo, and check its state",
        description="The knowledge repo is a private GitHub repository of Markdown pages "
        "(an Obsidian vault) plus the Engine config, .kb-engine/engine.yaml. The Engine "
        "reads both from it.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    _add_init(commands)
    status = commands.add_parser(
        "status",
        help="is the local clone present, clean, in sync, and its config valid",
        description="Check the local clone of the knowledge repo: it exists, has nothing "
        "uncommitted, matches origin/main, and its .kb-engine/engine.yaml is valid. "
        "Exits 1 if any check fails.",
    )
    status.add_argument("--path", metavar="DIR",
                        help="the clone (default: the path `kbe repo init` recorded)")
    status.set_defaults(func=_cmd_status)
