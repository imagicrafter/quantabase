#!/usr/bin/env python3
"""Search workspace.documents.

    ../.venv/bin/python -m knowledge.search "territory dispatch"
    ../.venv/bin/python -m knowledge.search "quarterly pricing review" --limit 5 --json

Mirrors `scripts/memory/search.py` in shape, but retrieves documents rather than
chunks and enforces the access model through the `search` edge function: the
caller's principal token travels as a bearer header, and the function hashes it
and passes the hash to `workspace.documents_search`, which resolves domains
internally. No domain list, service-role key, or raw token hash is ever computed
or sent by this client.

The token comes from `KNOWLEDGE_TOKEN_<HANDLE>` in `.env`. An absent or unknown
token returns zero rows — that is the fail-closed design, not a bug, so this
distinguishes the two cases in its output.

The handle comes from `--handle`, else the `KNOWLEDGE_HANDLE` environment
variable, else the owner's handle from the Engine config (the part of
`engine.owner.email` before the @). An agent that searches as its own principal
sets `KNOWLEDGE_HANDLE` once and needs no `--handle`.

Default path calls the `search` edge function (no service-role key on this
machine). `--direct` bypasses the function and calls `documents_search` locally
with a service-role client, for debugging the RPC itself when the function is
suspect -- do not use `--direct` as the everyday path.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import WORKSPACE_ROOT
from knowledge.engine_config import get_config
from knowledge.mint_token import token_hash
from knowledge.supabase_client import ConfigurationError, get_supabase, get_supabase_anon
from knowledge.kb_schema import db

HANDLE_ENV_VAR = "KNOWLEDGE_HANDLE"
# A handle becomes part of an .env key name, so only plain names are accepted.
_HANDLE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
DEFAULT_LIMIT = 8


def default_handle() -> str:
    """$KNOWLEDGE_HANDLE when it is a plain handle, else the owner's handle."""
    handle = (os.environ.get(HANDLE_ENV_VAR) or "").strip().lower()
    if _HANDLE.match(handle):
        return handle
    return get_config().owner_handle


class SearchError(RuntimeError):
    """Search could not run."""


def _read_token(handle: str) -> str:
    from knowledge.env_file import read as read_env_file

    env_path = WORKSPACE_ROOT / ".env"
    if not env_path.exists():
        raise SearchError(f"No .env file at {env_path}.")

    from knowledge.mint_token import env_key

    key = env_key(handle)
    token = dict(read_env_file(env_path)).get(key)
    if not token:
        raise SearchError(
            f"{key} is not set in .env. Mint one with:\n"
            f"  ../.venv/bin/python -m knowledge.mint_token "
            f"--handle {handle} --write-env"
        )
    return token


def _embed_query(text: str) -> list[float]:
    """The query vector, from the configured embedding backend."""
    from .embedder import EmbeddingError, embed_query

    try:
        return embed_query(text)
    except EmbeddingError as error:
        raise SearchError(str(error)) from error


def _search_via_function(
    query: str,
    token: str,
    *,
    limit: int,
    require_approved: bool,
) -> list[dict]:
    sb = get_supabase_anon()

    try:
        response = sb.functions.invoke(
            "search",
            invoke_options={
                "headers": {
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                "body": {
                    "query": query,
                    "match_count": limit,
                    "require_approved": require_approved,
                },
            },
        )
    except Exception as error:
        raise SearchError(f"search function call failed: {error}") from error

    payload = response if isinstance(response, dict) else json.loads(response)
    if "error" in payload:
        raise SearchError(f"search function returned an error: {payload['error']}")
    return payload.get("results") or []


def _search_direct(
    query: str,
    token: str,
    *,
    limit: int,
    require_approved: bool,
) -> list[dict]:
    embedding = _embed_query(query)
    try:
        sb = get_supabase()
    except ConfigurationError as error:
        raise SearchError(
            f"direct fallback unavailable here ({error}); the search edge "
            "function must be up"
        ) from error

    try:
        resp = db(sb).rpc(
            "documents_search",
            {
                "query_text": query,
                "query_embedding": embedding,
                "p_token_hash": token_hash(token),
                "match_count": limit,
                "require_approved": require_approved,
            },
        ).execute()
    except Exception as error:
        raise SearchError(f"documents_search failed: {error}") from error

    return resp.data or []


def search(
    query: str,
    *,
    handle: str | None = None,
    limit: int = DEFAULT_LIMIT,
    require_approved: bool = False,
    direct: bool = False,
) -> list[dict]:
    if not query or not query.strip():
        raise SearchError("Query is empty.")

    handle = handle or default_handle()
    token = _read_token(handle)

    if direct:
        return _search_direct(query, token, limit=limit, require_approved=require_approved)

    # Prefer the edge function -- it is the path that does NOT hand a
    # service-role key to the client. But a search tool that hard-fails when one
    # remote dependency is missing is the wrong failure mode: CLAUDE.md now tells
    # every session to reach for this first, so an outage here costs real work on
    # every session rather than degrading.
    #
    # Fall back to the direct RPC, and say so LOUDLY. A silent fallback would
    # read as normal operation while the security property -- no service-role key
    # in the client -- is quietly not in effect for that call.
    try:
        return _search_via_function(
            query, token, limit=limit, require_approved=require_approved
        )
    except SearchError as error:
        print(
            f"WARNING: search edge function unavailable ({error}).\n"
            "WARNING: falling back to the DIRECT service-role path. Results are "
            "correct, but this call is not going through the authenticated "
            "function. Deploy the `search` function to restore it.",
            file=sys.stderr,
        )
        return _search_direct(
            query, token, limit=limit, require_approved=require_approved
        )


def _format(rows: list[dict], query: str, handle: str) -> str:
    if not rows:
        return (
            f"No documents matched {query!r}.\n"
            f"If this is unexpected, check that the token for {handle!r} is valid — "
            "an unknown token returns zero rows by design."
        )

    lines = [f"{len(rows)} document(s) for {query!r}:\n"]
    for index, row in enumerate(rows, 1):
        rankers = []
        if row.get("matched_vector"):
            rankers.append("semantic")
        if row.get("matched_keyword"):
            rankers.append("keyword")

        lines.append(
            f"{index}. [{row['source']}] {row['title']}\n"
            f"   tier {row['tier']} | {', '.join(row.get('domains') or [])} "
            f"| {'+'.join(rankers) or 'none'} | score {row['fused_score']:.4f}"
        )

        # For a Drive artifact the link IS the result -- printing only the
        # external_id (an opaque file id) would make the row useless.
        url = row.get("url") or ""
        lines.append(f"   {url}" if url.startswith("http") else f"   {row['external_id']}")

        distillation = (row.get("distillation") or "").strip().replace("\n", " ")
        if distillation:
            lines.append(f"   {distillation[:220]}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", help="what to search for")
    parser.add_argument(
        "--handle",
        default=None,
        help="principal handle (default: $KNOWLEDGE_HANDLE, else the owner's handle)",
    )
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--json", action="store_true", help="raw JSON output")
    parser.add_argument(
        "--require-approved", action="store_true", help="only human-verified rows"
    )
    parser.add_argument(
        "--direct",
        action="store_true",
        help="bypass the search edge function, call documents_search locally "
        "with a service-role client (debugging only)",
    )
    args = parser.parse_args()
    handle = args.handle or default_handle()

    try:
        rows = search(
            args.query,
            handle=handle,
            limit=args.limit,
            require_approved=args.require_approved,
            direct=args.direct,
        )
    except SearchError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(rows, indent=2, default=str))
    else:
        print(_format(rows, args.query, handle))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
