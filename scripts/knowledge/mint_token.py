#!/usr/bin/env python3
"""Mint a bearer token for a principal.

    ../.venv/bin/python -m knowledge.mint_token --handle owner --write-env

`python -m kbe tokens mint` is the command a setup uses: it needs only the
database URL, and can also put the token on the clipboard or in a file. This
script is the older form, which needs the service-role key.

The plaintext token is never printed to stdout, never logged, and never returned
by any query. Only its SHA-256 is stored. `--write-env` appends it to the workspace
`.env` under `KNOWLEDGE_TOKEN_<HANDLE>`; without that flag the token is generated,
its hash stored, and the plaintext discarded — which is only useful for revoking an
old token.

Re-running for the same handle REPLACES the stored hash, invalidating the previous
token. That is the revocation path.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import WORKSPACE_ROOT
from knowledge.supabase_client import get_supabase
from knowledge.kb_schema import db

TOKEN_BYTES = 32
ENV_PREFIX = "KNOWLEDGE_TOKEN"


def token_hash(token: str) -> str:
    """SHA-256 hex digest. Must match what the engine computes per request."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def env_key(handle: str) -> str:
    """The env-file name a principal's token is kept under.

    Every character that is not a letter or digit becomes `_`, so a handle
    such as `first.last` still gives a name an env file can hold.
    """
    return f"{ENV_PREFIX}_{re.sub(r'[^A-Za-z0-9]', '_', handle).upper()}"


_env_key = env_key


def _append_to_env(handle: str, token: str) -> Path:
    """Append or replace the token line in .env, preserving everything else."""
    env_path = WORKSPACE_ROOT / ".env"
    key = _env_key(handle)

    existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    kept = [
        line
        for line in existing.splitlines()
        if not line.startswith(f"{key}=")
    ]
    kept.append(f"{key}={token}")

    env_path.write_text("\n".join(kept).rstrip("\n") + "\n", encoding="utf-8")
    return env_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    lookup = parser.add_mutually_exclusive_group(required=True)
    lookup.add_argument("--handle", help="principal handle")
    lookup.add_argument("--email", help="principal email (migration 0014+)")
    parser.add_argument(
        "--write-env",
        action="store_true",
        help="append the plaintext token to .env (otherwise it is discarded)",
    )
    args = parser.parse_args()

    sb = get_supabase()

    if args.handle:
        resp = (
            db(sb)
            .table("principals")
            .select("id, handle, role, active")
            .eq("handle", args.handle)
            .execute()
        )
        lookup_desc = f"handle {args.handle!r}"
        update_filter = ("handle", args.handle)
    else:
        resp = (
            db(sb)
            .table("principals")
            .select("id, handle, role, active")
            .ilike("email", args.email.strip())
            .execute()
        )
        lookup_desc = f"email {args.email!r}"
        update_filter = None  # resolved after row is found

    rows = resp.data or []
    if not rows:
        print(
            f"ERROR: no principal with {lookup_desc}. Create it first.",
            file=sys.stderr,
        )
        return 1

    principal = rows[0]
    if update_filter is None:
        update_filter = ("handle", principal["handle"])

    token = secrets.token_urlsafe(TOKEN_BYTES)

    try:
        (
            db(sb)
            .table("principals")
            .update({"token_hash": token_hash(token)})
            .eq(*update_filter)
            .execute()
        )
    except Exception as error:
        print(f"ERROR: could not store token hash: {error}", file=sys.stderr)
        return 1

    print(f"Token minted for {principal['handle']} ({principal['role']}).")
    print("Any previously issued token for this principal is now invalid.")

    if args.write_env:
        # The principal's own handle: `args.handle` is None when --email was used.
        env_path = _append_to_env(principal["handle"], token)
        print(f"Plaintext written to {env_path} as {env_key(principal['handle'])}.")
    else:
        print(
            "Plaintext discarded (no --write-env). Re-run with --write-env if you "
            "need a usable token."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
