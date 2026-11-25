"""`kbe config` -- check an engine.yaml and apply it to the database.

    kbe config validate <path>
    kbe config apply <path> [--dry-run] [--yes] [--via auto|api|db]
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Mapping

from . import config_diff, config_store, secrets, state
from .context import Context
from .errors import KbeError

PHASE = "config"


def read_config(path: Path) -> Mapping[str, Any]:
    """Parse and validate a config file. The error lists every problem."""
    from knowledge import engine_config

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise KbeError(f"Could not read {path}: {error.strerror}.") from error
    try:
        import yaml
        from knowledge import engine_config_schema

        raw = engine_config_schema.load_yaml(text)
    except ImportError as error:
        raise KbeError(
            "PyYAML is not installed. Run: pip install -r pullers/requirements.txt"
        ) from error
    except yaml.YAMLError as error:
        raise KbeError(f"{path} is not valid YAML:\n{error}") from error
    try:
        engine_config.validate(raw)
    except engine_config.ConfigurationError as error:
        raise KbeError(f"{path}: {error}") from error
    return raw


def _summary(config: Mapping[str, Any]) -> str:
    topics = [str(t.get("id")) for t in config.get("domains") or []]
    sources = config.get("sources") or {}
    on = sorted(name for name, s in sources.items() if isinstance(s, Mapping) and s.get("enabled"))
    return (
        f'engine "{config["engine"]["name"]}", owner {config["engine"]["owner"]["email"]}, '
        f"{len(topics)} topic(s): {', '.join(topics) or 'none'}; "
        f"sources on: {', '.join(on) or 'none'}"
    )


def apply_config(
    store: config_store.ConfigStore,
    config: Mapping[str, Any],
    ctx: Context,
    *,
    dry_run: bool = False,
    yes: bool = False,
) -> bool:
    """Show the diff, confirm, apply. True when the database was changed."""
    change = config_diff.diff(store.get(), config)
    ctx.out(config_diff.render(change))
    if change.is_empty:
        return False
    if dry_run:
        ctx.out("Dry run: nothing was changed.")
        return False
    if not yes and not ctx.confirm("Apply this config to the database?"):
        raise KbeError("Not applied. Re-run with --yes to apply without being asked.")
    result = store.apply(config, config_diff.config_hash(config))
    ctx.out(f"Applied. Owner: {result.get('owner_email', config['engine']['owner']['email'])}.")
    return True


def _remember(ctx: Context, config: Mapping[str, Any]) -> None:
    """Note the non-secret facts later setup steps want."""
    current = state.load(ctx.state_file)
    answers = {
        "engine_id": config["engine"]["id"],
        "owner_email": config["engine"]["owner"]["email"],
        "wiki_repo": (config.get("sources") or {}).get("wiki", {}).get("repo"),
    }
    updated = current
    for key, value in answers.items():
        if value:
            updated = state.with_answer(updated, key, value)
    state.save(ctx.state_file, state.with_phase(updated, PHASE, "done"))


def _cmd_validate(args: argparse.Namespace, ctx: Context) -> int:
    config = read_config(Path(args.path))
    ctx.out(f"OK: {args.path} is a valid Engine config.")
    ctx.out(_summary(config))
    return 0


def _cmd_apply(args: argparse.Namespace, ctx: Context) -> int:
    config = read_config(Path(args.path))
    store = config_store.choose(secrets.load(ctx.env_file), args.via, ctx.runner)
    ctx.out(f"Using {store.describe()}.")
    changed = apply_config(store, config, ctx, dry_run=args.dry_run, yes=args.yes)
    if changed:
        _remember(ctx, config)
    return 0


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "config",
        help="validate an engine.yaml and apply it to the database",
        description="The Engine config (.kb-engine/engine.yaml in your knowledge "
        "repo) names the owner, the topics and the sources. The service and the "
        "pullers read it from the database, so it has to be applied there.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")

    check = commands.add_parser(
        "validate",
        help="check a config file and list every problem",
        description="Check a config file. Prints every problem found, not just the first.",
    )
    check.add_argument("path", help="path to engine.yaml")
    check.set_defaults(func=_cmd_validate)

    send = commands.add_parser(
        "apply",
        help="show what would change, then apply the config",
        description="Validate the file, show a diff against the config the database "
        "has now (topics added, removed or changed; sources turned on or off; the "
        "owner), ask for a yes, then apply it. The database applies it all or not "
        "at all, and refuses unsafe changes such as unlocking a sensitive topic.",
    )
    send.add_argument("path", help="path to engine.yaml")
    send.add_argument("--dry-run", action="store_true", help="show the diff only")
    send.add_argument("--yes", action="store_true", help="apply without asking")
    send.add_argument(
        "--via", choices=("auto", "api", "db"), default="auto",
        help="how to reach the database: the REST API as the pullers do (api), "
        "KBE_DATABASE_URL (db), or whichever is configured (auto, the default)",
    )
    send.set_defaults(func=_cmd_apply)
