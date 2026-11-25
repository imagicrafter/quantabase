"""`kbe tags` -- see how documents are tagged, and tag the untagged ones.

    python -m kbe.tags audit [--source S] [--limit N] [--json]
    python -m kbe.tags suggest --source S --out proposals.csv [--limit N]
    python -m kbe.tags apply proposals.csv [--wiki-root DIR] [--write [--yes]]
    python -m kbe.tags authorize --source drive|gmail --client-secret F --out TOKEN

`apply` is a dry run unless `--write` is given. See docs/tagging.md.

Mounted as `python -m kbe tags ...` and following the CLI's conventions:
handlers are `(args, ctx) -> exit code`, the database client is built from the
local env file (`--env-file` is honoured), output goes through `ctx.out`, and
an expected failure is raised as `KbeError`. `python -m kbe.tags ...` still
works and behaves the same way.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from kbe import context, ingest_client, secrets, tag_apply, tag_audit, tag_suggest
from kbe.context import Context
from kbe.errors import KbeError
from knowledge.engine_config import ConfigurationError, get_config
from knowledge.tag_resolver import SOURCES

def _database(ctx: Context) -> Any:
    """The kb_ingest client for the project and schema in the local env file."""
    return ingest_client.client(secrets.load(ctx.env_file))


def _model_ask(prompt: str) -> dict:
    from knowledge.model_client import ask_json

    return ask_json(prompt, system_prompt=tag_suggest.SYSTEM_PROMPT)


def run_audit(args: argparse.Namespace, ctx: Context, *, sb: Any = None) -> int:
    rows = tag_audit.fetch_rows(sb or _database(ctx), args.source)
    audits = tag_audit.summarise(rows)
    if args.json:
        ctx.out(json.dumps(tag_audit.as_json(audits), indent=2))
    else:
        ctx.out(tag_audit.render(audits, limit=args.limit))
    return 0


def run_suggest(
    args: argparse.Namespace, ctx: Context, *, sb: Any = None,
    ask: tag_suggest.Ask | None = None,
) -> int:
    target = Path(args.out)
    if target.exists():
        raise tag_suggest.TagSuggestError(f"{target} already exists; choose another --out")
    config = get_config()
    rows = tag_audit.fetch_rows(sb or _database(ctx), args.source, tag_suggest.BODY_COLUMNS)
    untagged = [row for row in rows if tag_audit.is_untagged(row)][: args.limit]
    proposals = tag_suggest.suggest(untagged, config, ask or _model_ask)
    tag_suggest.write_csv(proposals, target)
    with_topic = sum(1 for proposal in proposals if proposal.proposed)
    ctx.out(
        f"{len(proposals)} untagged {args.source} item(s) looked at, "
        f"{with_topic} with a proposed topic. Wrote {target}.\n"
        "Nothing was changed at the source. Review the file, then run "
        f"`kbe tags apply {target}` (a dry run)."
    )
    return 0


def _writers(args: argparse.Namespace, config: Any, needed: Sequence[str]) -> dict:
    """Build a writer for each source the file needs. Only called for --write."""
    from kbe import tag_clients

    writers: dict = {}
    if "wiki" in needed:
        writers["wiki"] = tag_apply.wiki_writer(Path(args.wiki_root), config.tagging.frontmatter_key)
    for source, token, build, writer in (
        ("drive", args.drive_token, tag_clients.drive_client, tag_apply.drive_writer),
        ("gmail", args.gmail_token, tag_clients.gmail_client, tag_apply.gmail_writer),
    ):
        if source in needed:
            if not token:
                raise tag_apply.TagApplyError(f"--write for {source} rows needs --{source}-token")
            writers[source] = writer(build(Path(token)), config)
    return writers


def _confirm_write(args: argparse.Namespace, ctx: Context, actions: Sequence[Any]) -> None:
    """Show what would be written and get a yes. `--yes` skips the question."""
    ready = [action for action in actions if action.status == tag_apply.READY]
    if not ready or getattr(args, "yes", False):
        return
    ctx.out(tag_apply.render(actions, wrote=False).rsplit("\n", 1)[0])
    sources = ", ".join(tag_apply.sources_needed(actions))
    question = f"Write {len(ready)} tag(s) to {sources}? A tag decides who can see an item."
    if not ctx.confirm(question):
        raise KbeError("Nothing was written. Re-run with --yes to write without being asked.")


def run_apply(
    args: argparse.Namespace, ctx: Context, *, writers: dict | None = None
) -> int:
    config = get_config()
    rows = tag_apply.read_proposals(Path(args.proposals))
    wiki_root = Path(args.wiki_root) if args.wiki_root else None
    actions = tag_apply.plan(rows, config, wiki_root=wiki_root)
    if args.write and writers is None:
        writers = _writers(args, config, tag_apply.sources_needed(actions))
    if args.write:
        # After the credentials are known to be there, before anything is written.
        _confirm_write(args, ctx, actions)
    results = tag_apply.apply(actions, writers or {}, write=bool(args.write))
    ctx.out(tag_apply.render(results, wrote=bool(args.write)))
    return 1 if any(action.status == tag_apply.FAILED for action in results) else 0


def run_authorize(args: argparse.Namespace, ctx: Context) -> int:
    from kbe import tag_clients

    saved = tag_clients.authorize(args.source, Path(args.client_secret), Path(args.out))
    ctx.out(f"Saved a {args.source} token for tagging at {saved}. Keep it on this machine only.")
    return 0


def _positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be 1 or more")
    return number


def add_commands(parser: argparse.ArgumentParser) -> None:
    commands = parser.add_subparsers(dest="tags_command", required=True)

    audit = commands.add_parser("audit", help="how each source's documents got their topics")
    audit.add_argument("--source", choices=SOURCES)
    audit.add_argument("--limit", type=_positive, default=50, help="items listed per group")
    audit.add_argument("--json", action="store_true")
    audit.set_defaults(handler=run_audit)

    suggest = commands.add_parser("suggest", help="propose a topic for untagged items (file only)")
    suggest.add_argument("--source", choices=SOURCES, required=True)
    suggest.add_argument("--out", required=True, help="CSV to write; must not exist")
    suggest.add_argument("--limit", type=_positive, default=tag_suggest.DEFAULT_LIMIT)
    suggest.set_defaults(handler=run_suggest)

    apply = commands.add_parser("apply", help="write a reviewed proposals file to the sources")
    apply.add_argument("proposals", help="the CSV from `suggest`, reviewed by a person")
    apply.add_argument("--write", action="store_true", help="apply; without it, a dry run")
    apply.add_argument("--yes", action="store_true",
                       help="with --write: write without asking first")
    apply.add_argument("--wiki-root", help="local clone of the knowledge repo")
    apply.add_argument("--drive-token", help="token from `authorize --source drive`")
    apply.add_argument("--gmail-token", help="token from `authorize --source gmail`")
    apply.set_defaults(handler=run_apply)

    authorize = commands.add_parser("authorize", help="one-time Google sign-in for tagging")
    authorize.add_argument("--source", choices=("drive", "gmail"), required=True)
    authorize.add_argument("--client-secret", required=True, help="OAuth client JSON")
    authorize.add_argument("--out", required=True, help="token file to create")
    authorize.set_defaults(handler=run_authorize)


def _expected() -> tuple[type[BaseException], ...]:
    from kbe.tag_clients import TagClientError

    return (
        ConfigurationError, tag_audit.TagAuditError, tag_suggest.TagSuggestError,
        tag_apply.TagApplyError, TagClientError,
    )


def run(args: argparse.Namespace, ctx: Context) -> int:
    """Run a parsed command. An expected failure becomes a `KbeError`."""
    try:
        return int(args.handler(args, ctx))
    except _expected() as error:
        raise KbeError(str(error)) from error


def register(subparsers: Any) -> argparse.ArgumentParser:
    """Mount `tags` as a group of the `kbe` command."""
    parser = subparsers.add_parser(
        "tags",
        help="audit, suggest and apply source tags",
        description="See how each source's documents got their topics, have a model "
        "propose a topic for the untagged ones (into a file only), and write a "
        "reviewed file back to the sources. Nothing is written to a source without "
        "`apply --write`. Credentials come from the local env file. See docs/tagging.md.",
    )
    add_commands(parser)
    parser.set_defaults(func=run)
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="kbe tags", description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--env-file", metavar="PATH",
        help="local env file holding credentials (default: KBE_ENV_FILE, then the repo's own)",
    )
    add_commands(parser)
    return parser


def main(argv: Sequence[str] | None = None, ctx: Context | None = None) -> int:
    """`python -m kbe.tags`: the same commands, reported the way `kbe` does."""
    args = build_parser().parse_args(argv)
    try:
        return run(args, ctx or context.build(args.env_file))
    except KbeError as error:
        sys.stderr.write(f"kbe tags: {error}\n")
        return error.exit_code


if __name__ == "__main__":
    sys.exit(main())
