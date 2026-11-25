#!/usr/bin/env python3
"""Permission regression test: prove principal A cannot read principal B's rows.

    ../.venv/bin/python -m knowledge.access_test

It is one of the few places that assert the access model actually denies. Every
other test in this package checks that something is *returned*; this one checks
that something is *withheld*, which is the property that matters and the one a
refactor silently breaks.

TWO WAYS TO RUN IT
------------------
    python -m knowledge.access_test --roles-only
        What `kbe verify` runs (verification.role-boundary-suite). Asks the
        REST API as the anonymous role and as the service's role and checks
        both are refused. Needs no token, no service-role key, no document.

    python -m knowledge.access_test
        The full suite, for an Engine that has content: it also searches as
        the owner and as a person with no grants. It needs a token for each
        in the local env file (`python -m kbe tokens mint --handle <owner>
        --write-env` and `--embed --write-env`), the service-role key, and a
        document in a sensitive topic. On a new Engine the same property is
        proved without any of that by the `token-path-suite` check in
        setup/manifest.yaml, which makes and rolls back its own fixtures.

READ-ONLY. It performs no INSERT, UPDATE or DELETE, creates no principal and no
grant, and depends only on fixtures already present in the database.

WHICH PATH THIS COVERS
----------------------
There are two front doors onto the same enforcement, and they take different
identity arguments:

    TOKEN PATH  search.py -> `search` edge fn -> documents_search(p_token_hash)
                LIVE TODAY. Needs no engine, no identity provider, no deploy.

    OAUTH PATH  Cowork -> engine -> documents_search_by_oauth_subject(p_sub)
                Blocked until the engine is deployed (master plan A1-A6).

This file tests the token path positively and negatively, and tests the OAuth
path *negatively only* — an unknown subject must resolve to nothing. It cannot
yet test the OAuth path positively because no principal has an `oauth_subject`;
the first successful login pins one via `claim_oauth_subject`. The eight
`engine/tests/access` vitest cases are the positive half and remain the
acceptance gate for Phase A. This file does not replace them.

THE FIXTURES
------------
Two principals that already exist in the database, each with a token in the
workspace's dotenv file (`KNOWLEDGE_TOKEN_<HANDLE>`):

    the owner    administrator  every open topic, plus the sensitive topics
                                granted to them by name (always `unclassified`)
    the reader   reader         0 domains  (no grants at all)

Which principals they are comes from settings, not from this file:

    ACCESS_TEST_OWNER_HANDLE    default: the owner's handle from the Engine
                                config (the part of engine.owner.email
                                before the @)
    ACCESS_TEST_READER_HANDLE   default: `kb-engine`, the embed-only principal
                                every Engine has, which holds no grants
    ACCESS_TEST_SENSITIVE_QUERY default below; set it to words that match
                                something in one of the owner's sensitive topics

The reader is the negative fixture and it is a genuinely useful one: it is a
real, ACTIVE principal holding a VALID token. A test that only ever tries a
garbage token proves the string comparison works, not that the authorisation
does. The interesting question is whether a legitimate caller is correctly told
nothing, and the reader is the only fixture that asks it.

WHY THE POSITIVE CONTROL IS NOT OPTIONAL
----------------------------------------
"the reader got zero rows" is worthless on its own — a typo in the query gives
the same result. Every denial assertion here is paired with a proof that the
same query returned rows for the owner. A denial test without a positive control
passes just as happily when the whole corpus is unreachable.
"""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.config import WORKSPACE_ROOT
from knowledge.engine_config import get_config
from knowledge.mint_token import env_key, token_hash
from knowledge.supabase_client import _role_client, get_supabase, get_supabase_anon
from knowledge.kb_schema import db

# A query chosen to hit a sensitive topic — the most restricted content in the
# corpus. If this stops matching anything for the owner the positive control
# fails loudly rather than letting the denial assertions pass vacuously.
SENSITIVE_QUERY = os.environ.get("ACCESS_TEST_SENSITIVE_QUERY") or "private personal notes"

# A deliberately broad query. The reader must get zero rows for this too, not
# just for the sensitive one — zero domains means zero rows for everything.
BROAD_QUERY = "project status"

DEFAULT_READER_HANDLE = "kb-engine"


def owner_handle() -> str:
    return os.environ.get("ACCESS_TEST_OWNER_HANDLE") or get_config().owner_handle


def reader_handle() -> str:
    return os.environ.get("ACCESS_TEST_READER_HANDLE") or DEFAULT_READER_HANDLE

UNKNOWN_TOKEN = "not-a-real-token-" + "0" * 32
UNKNOWN_SUB = "user_00000000000000000000000000"
UNKNOWN_EMAIL = "nobody@example.invalid"
NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000"


class AccessTestFailure(AssertionError):
    """A permission assertion did not hold."""


_results: list[tuple[bool, str, str]] = []
_skipped: list[tuple[str, str]] = []


def _check(label: str, condition: bool, detail: str) -> bool:
    _results.append((bool(condition), label, detail))
    print(f"{'PASS' if condition else 'FAIL'}  {label}: {detail}")
    return bool(condition)


def _skip(label: str, reason: str) -> None:
    """Record an assertion this client is not privileged to make.

    A skip is NOT a pass. It is counted and printed separately so a suite that
    silently stopped testing something cannot read as a clean run.
    """
    _skipped.append((label, reason))
    print(f"SKIP  {label}: {reason}")


class _PermissionDenied(Exception):
    pass


def _rpc_or_denied(sb, name: str, args: dict):
    """Call an RPC, raising _PermissionDenied on a 42501 rather than crashing.

    The OAuth-path functions are granted to `kb_engine` ONLY — deliberately, by
    migration 0018, which gives that role six functions and zero tables. The
    service-role client this file uses is therefore *correctly* refused. That is
    least privilege working, not a defect, so it is reported as a skip.
    """
    try:
        return (db(sb).rpc(name, args).execute()).data
    except Exception as error:
        if "42501" in str(error) or "permission denied" in str(error).lower():
            raise _PermissionDenied(name) from error
        raise


def _read_token(handle: str) -> str:
    from knowledge.env_file import read as read_env_file

    key = env_key(handle)
    token = dict(read_env_file(WORKSPACE_ROOT / ".env")).get(key)
    if not token:
        raise AccessTestFailure(
            f"{key} is not set in .env. This test needs both principal tokens; "
            "it does not mint them, because minting REPLACES the stored hash and "
            "would revoke the live one."
        )
    return token


def _embed(text: str) -> list[float]:
    from knowledge.embedder import embed_query

    return embed_query(text)


def _search_by_token(sb, query: str, embedding: list[float], token: str) -> list[dict]:
    resp = (
        db(sb)
        .rpc(
            "documents_search",
            {
                "query_text": query,
                "query_embedding": embedding,
                "p_token_hash": token_hash(token),
                "match_count": 20,
            },
        )
        .execute()
    )
    return resp.data or []


def _rpc(sb, name: str, args: dict):
    return (db(sb).rpc(name, args).execute()).data


# --------------------------------------------------------------------------
# 1. resolve_domains — the single chokepoint every read path funnels through
# --------------------------------------------------------------------------


def test_resolve_domains(sb, owner_token: str, reader_token: str) -> None:
    print("\n-- resolve_domains (token path) --")

    owner_domains = _rpc(sb, "resolve_domains", {"p_token_hash": token_hash(owner_token)}) or []
    _check(
        "the owner resolves to a non-empty domain set",
        len(owner_domains) > 0,
        f"{len(owner_domains)} domains",
    )
    _check(
        "the owner is granted `unclassified`, the topic every Engine locks to its owner",
        "unclassified" in set(owner_domains),
        f"resolved: {sorted(owner_domains)}",
    )

    reader_domains = _rpc(sb, "resolve_domains", {"p_token_hash": token_hash(reader_token)}) or []
    _check(
        "the reader (valid token, zero grants) resolves to ZERO domains",
        reader_domains == [],
        f"resolved: {reader_domains!r}",
    )

    for label, bad in (
        ("unknown token", UNKNOWN_TOKEN),
        ("empty token", ""),
    ):
        resolved = _rpc(sb, "resolve_domains", {"p_token_hash": token_hash(bad)}) or []
        _check(
            f"{label} resolves to ZERO domains",
            resolved == [],
            f"resolved: {resolved!r}",
        )

    # A null hash is a distinct code path from an unmatched one — a `where
    # token_hash = null` that returns everything instead of nothing is the
    # classic fail-open bug, and it would never be caught by the garbage-token
    # case above.
    resolved = _rpc(sb, "resolve_domains", {"p_token_hash": None}) or []
    _check(
        "null token hash resolves to ZERO domains",
        resolved == [],
        f"resolved: {resolved!r}",
    )


# --------------------------------------------------------------------------
# 2. documents_search — A must not receive B's rows
# --------------------------------------------------------------------------


def test_search_denies(sb, owner_token: str, reader_token: str) -> None:
    print("\n-- documents_search (token path) --")

    for query in (SENSITIVE_QUERY, BROAD_QUERY):
        embedding = _embed(query)

        owner_rows = _search_by_token(sb, query, embedding, owner_token)
        # THE POSITIVE CONTROL. Without this, every assertion below is vacuous.
        got_rows = _check(
            f"positive control — the owner gets rows for {query!r}",
            len(owner_rows) > 0,
            f"{len(owner_rows)} rows",
        )

        reader_rows = _search_by_token(sb, query, embedding, reader_token)
        _check(
            f"the reader gets ZERO rows for {query!r}",
            len(reader_rows) == 0,
            f"{len(reader_rows)} rows"
            + ("" if got_rows else "  (WARNING: positive control failed, so this proves nothing)"),
        )

        unknown_rows = _search_by_token(sb, query, embedding, UNKNOWN_TOKEN)
        _check(
            f"unknown token gets ZERO rows for {query!r}",
            len(unknown_rows) == 0,
            f"{len(unknown_rows)} rows",
        )

    # The sharpest form of the question: the owner can actually see rows in a
    # sensitive topic, and the reader is denied those exact rows.
    embedding = _embed(SENSITIVE_QUERY)
    owner_rows = _search_by_token(sb, SENSITIVE_QUERY, embedding, owner_token)
    sensitive_hits = [
        row
        for row in owner_rows
        if get_config().sensitive_domain_ids & set(row.get("domains") or [])
    ]
    _check(
        "positive control — the owner's results actually include sensitive rows",
        len(sensitive_hits) > 0,
        f"{len(sensitive_hits)} of {len(owner_rows)} rows carry a sensitive domain",
    )
    reader_rows = _search_by_token(sb, SENSITIVE_QUERY, embedding, reader_token)
    leaked = {row["id"] for row in reader_rows} & {row["id"] for row in sensitive_hits}
    _check(
        "no sensitive row the owner can see is visible to the reader",
        not leaked,
        f"leaked ids: {sorted(leaked) or 'none'}",
    )


# --------------------------------------------------------------------------
# 3. OAuth path — negative only, until an oauth_subject is pinned
# --------------------------------------------------------------------------


def test_oauth_path_denies(sb) -> None:
    print("\n-- OAuth path (negative assertions only) --")

    doc_rows = (
        db(sb)
        .table("documents")
        .select("id, external_id, title")
        .is_("deleted_at", "null")
        .limit(1)
        .execute()
        .data
    )
    if not doc_rows:
        _check("a live document exists to test with", False, "corpus is empty")
        return
    doc = doc_rows[0]

    # Every assertion below is "an unknown subject gets nothing". Each is
    # attempted, and each degrades to a SKIP if this client lacks EXECUTE --
    # which is the expected outcome for the kb_engine-only functions.
    attempts = [
        (
            "resolve_domains_for_oauth_subject: unknown sub resolves to ZERO domains",
            "resolve_domains_for_oauth_subject",
            {"p_sub": UNKNOWN_SUB},
            lambda d: (d or []) == [],
        ),
        (
            "resolve_domains_for_email: unknown email resolves to ZERO domains",
            "resolve_domains_for_email",
            {"p_email": UNKNOWN_EMAIL},
            lambda d: (d or []) == [],
        ),
        (
            "resolve_domains_for_email: null email resolves to ZERO domains",
            "resolve_domains_for_email",
            {"p_email": None},
            lambda d: (d or []) == [],
        ),
        (
            "document_get: unknown sub cannot fetch a REAL document",
            "document_get",
            {"p_oauth_subject": UNKNOWN_SUB, "p_id": doc["id"]},
            lambda d: (d or []) == [],
        ),
        (
            "wiki_page_get: unknown sub cannot fetch a REAL page by title",
            "wiki_page_get",
            {"p_oauth_subject": UNKNOWN_SUB, "p_title_or_path": doc["title"]},
            lambda d: (d or []) == [],
        ),
    ]

    denied_fns: set[str] = set()
    for label, fn, args, predicate in attempts:
        try:
            data = _rpc_or_denied(sb, fn, args)
        except _PermissionDenied:
            denied_fns.add(fn)
            _skip(label, f"service_role has no EXECUTE on {fn} (kb_engine only, by design)")
            continue
        _check(label, predicate(data), f"returned: {data!r}")

    # The existence-oracle check needs two calls to the same function, so it is
    # only meaningful when that function was reachable at all.
    if "document_get" in denied_fns:
        _skip(
            "document_get: forbidden and nonexistent are INDISTINGUISHABLE",
            "service_role has no EXECUTE on document_get (kb_engine only, by design)",
        )
    else:
        forbidden = _rpc_or_denied(sb, "document_get", {"p_oauth_subject": UNKNOWN_SUB, "p_id": doc["id"]}) or []
        nonexistent = _rpc_or_denied(sb, "document_get", {"p_oauth_subject": UNKNOWN_SUB, "p_id": NONEXISTENT_UUID}) or []
        # A distinguishable "exists but forbidden" turns document_get into an
        # existence oracle for documents the caller may not know about.
        _check(
            "document_get: forbidden and nonexistent are INDISTINGUISHABLE",
            forbidden == nonexistent,
            f"forbidden={forbidden!r} nonexistent={nonexistent!r}",
        )

    if denied_fns:
        print(
            "\n  NOTE: the skips above are the CORRECT posture, not a gap in the\n"
            "  database. Migration 0018 grants the OAuth-path functions to the\n"
            "  `kb_engine` role and to nothing else, so the service-role client\n"
            "  used here is refused. Those assertions are covered by\n"
            "  engine/tests/access (master plan A7), which runs as kb_engine.\n"
            "  If any of them ever start PASSING here, that is the finding:\n"
            "  it means service_role was granted something it should not hold."
        )


# --------------------------------------------------------------------------
# 4. anon must not be able to call the read functions at all
# --------------------------------------------------------------------------


def test_anon_is_denied() -> None:
    print("\n-- anon direct RPC (migrations 0016 / 0019) --")

    anon = get_supabase_anon()
    for fn, args in (
        ("resolve_domains", {"p_token_hash": "x" * 64}),
        ("documents_search", {"query_text": "x", "query_embedding": [0.0] * 384, "p_token_hash": "x" * 64}),
    ):
        try:
            data = db(anon).rpc(fn, args).execute().data
        except Exception as error:
            _check(
                f"anon cannot execute {fn}",
                True,
                f"denied ({type(error).__name__})",
            )
        else:
            _check(
                f"anon cannot execute {fn}",
                False,
                f"EXECUTED and returned {data!r} — anon holds EXECUTE it should not",
            )


# --------------------------------------------------------------------------
# 5. engine settings — the service role sees the config, never the setup code
# --------------------------------------------------------------------------

# Every table in the workspace schema. `kb_engine` must be refused on each one:
# it reads only through SECURITY DEFINER functions (migrations 0018, 0029).
WORKSPACE_TABLES = (
    "documents",
    "domains",
    "principals",
    "access_grants",
    "raw_captures",
    "connector_state",
    "review_batches",
    "review_items",
    "distillation_rejections",
    "events",
    "engine_settings",
)


def _is_denied(error: Exception) -> bool:
    return "42501" in str(error) or "permission denied" in str(error).lower()


def test_engine_settings(engine) -> None:
    """`engine` is a client that PostgREST runs as the `kb_engine` role.

    Read-only in effect: the one call that could write (`engine_setup_complete`)
    is made with a code that cannot be right, and the test asserts that it
    changed nothing.
    """
    print("\n-- engine settings (migrations 0029 / 0030) --")

    for table in WORKSPACE_TABLES:
        try:
            rows = db(engine).table(table).select("*").limit(1).execute().data
        except Exception as error:
            _check(
                f"kb_engine has no table grant on {table}",
                _is_denied(error),
                f"refused ({type(error).__name__})" if _is_denied(error) else f"unexpected error: {error}",
            )
        else:
            _check(
                f"kb_engine has no table grant on {table}",
                False,
                f"SELECT ran and returned {len(rows or [])} row(s) -- kb_engine must hold zero table grants",
            )

    try:
        db(engine).table("engine_settings").select("setup_code_hash").execute()
    except Exception as error:
        _check("kb_engine cannot read setup_code_hash", _is_denied(error), "column read refused")
    else:
        _check("kb_engine cannot read setup_code_hash", False, "the column was readable")

    before = _rpc(engine, "engine_settings_public", {}) or {}
    _check(
        "engine_settings_public never returns the setup code hash",
        "setup_code_hash" not in before and "setup_code_hash" not in str(before),
        f"keys returned: {sorted(before)}",
    )

    wrong_code = "not-the-setup-code-" + uuid.uuid4().hex
    access = {"team_domain": "https://invalid.example", "aud": "invalid", "host": "invalid.example"}
    accepted = _rpc(engine, "engine_setup_complete", {"p_code": wrong_code, "p_access": access})
    after = _rpc(engine, "engine_settings_public", {}) or {}
    _check("a wrong setup code is refused", accepted is False, f"returned {accepted!r}")
    _check(
        "a wrong setup code leaves the setup state unchanged",
        after.get("setup_state") == before.get("setup_state"),
        f"state before={before.get('setup_state')!r} after={after.get('setup_state')!r}",
    )
    _check(
        "a wrong setup code stores no access settings",
        after.get("access") == before.get("access"),
        "access settings unchanged",
    )


def _run_token_path() -> int:
    """The checks that need two minted tokens, the service-role key and content."""
    try:
        owner_token = _read_token(owner_handle())
        reader_token = _read_token(reader_handle())
    except AccessTestFailure as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    sb = get_supabase()
    test_resolve_domains(sb, owner_token, reader_token)
    test_search_denies(sb, owner_token, reader_token)
    test_oauth_path_denies(sb)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument(
        "--roles-only", action="store_true",
        help="only the role checks (anon is refused; kb_engine reads no table). Needs no "
        "token, no service-role key and no document: this is what `kbe verify` runs.",
    )
    args = parser.parse_args(argv)

    if not args.roles_only:
        code = _run_token_path()
        if code:
            return code
    test_anon_is_denied()
    test_engine_settings(_role_client("kb_engine"))

    failures = [(label, detail) for ok, label, detail in _results if not ok]
    print(
        f"\n{len(_results) - len(failures)}/{len(_results)} assertions passed, "
        f"{len(_skipped)} skipped."
    )
    if _skipped:
        print("\nSKIPPED (not covered by this client -- see note above):")
        for label, reason in _skipped:
            print(f"  - {label}: {reason}")
    if failures:
        print("\nFAILED:")
        for label, detail in failures:
            print(f"  - {label}: {detail}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
