"""The `kbe` command: parse arguments and hand off to a command group.

Each group is one module with a `register(groups)` function that adds its
parser and sets `func=<handler(args, ctx) -> exit code>`. To add a group,
write the module and add it to GROUPS.
"""

from __future__ import annotations

import argparse
import sys
from typing import Sequence

from . import (
    __version__, access, config_cmd, context, db, deploy, doctor, env_check, issues, pages, people,
    repo, sources, support, tags, tokens, verify,
)
from .errors import KbeError

GROUPS = (
    doctor, env_check, db, config_cmd, repo, deploy, access, sources, people, pages, issues,
    support, tokens, tags, verify,
)

_EPILOG = """\
Credentials are read from a local, git-ignored env file (the repo's .env by
default) and are never printed. Setup progress and non-secret answers are kept
in .kb-engine-local/state.json.

Examples:
  python -m kbe doctor
  python -m kbe env check
  python -m kbe db migrate --dry-run
  python -m kbe config apply path/to/engine.yaml
  python -m kbe verify --phases bronze,silver
  python -m kbe repo init --create acme/knowledge --engine-id acme ...
  python -m kbe deploy render --host engine.example.com
  python -m kbe deploy secrets push
  python -m kbe access status
  python -m kbe tags audit
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kbe",
        description="Set up and look after an Engine.",
        epilog=_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"kbe {__version__}")
    parser.add_argument(
        "--env-file", metavar="PATH",
        help="local env file holding credentials (default: KBE_ENV_FILE, then <repo>/.env)",
    )
    groups = parser.add_subparsers(dest="group", required=True, metavar="<group>")
    for group in GROUPS:
        group.register(groups)
    return parser


def main(argv: Sequence[str] | None = None, ctx: context.Context | None = None) -> int:
    """Run one command. Returns the process exit code."""
    args = build_parser().parse_args(argv)
    active = ctx or context.build(args.env_file)
    try:
        return int(args.func(args, active))
    except KbeError as error:
        print(f"kbe: {error}", file=sys.stderr)
        return error.exit_code
    except KeyboardInterrupt:
        print("kbe: stopped.", file=sys.stderr)
        return 130
