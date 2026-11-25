"""Knowledge pipeline settings.

Two kinds of setting live here:

  * constants that are the same for every Engine (tiers, batch sizes, mime
    types), defined below;
  * the topics ("domains"), which belong to each Engine's own config
    (`.kb-engine/engine.yaml`, see `engine_config.py`). They are read on first
    use through `domains()` and `sensitive_domains()` -- never at import time,
    so importing this module needs no config and no database.

`verify_taxonomy()` asserts the config and `workspace.domains` agree; run it
before any backfill.
"""

from __future__ import annotations

from pathlib import Path

from .engine_config import UNCLASSIFIED
from .kb_schema import db

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent

# The knowledge wiki is a SEPARATE git repository. One setting says where its
# checkout is: KNOWLEDGE_WIKI_ROOT in .env. When it is unset the default below
# is used; when that path does not exist, the pullers clone the repo named in
# the config (sources.wiki.repo) into their own cache instead.
DEFAULT_WIKI_ROOT = Path.home() / "github" / "knowledge"


def _resolve_wiki_root() -> Path:
    try:
        from knowledge.env_file import read as read_env_file

        override = dict(read_env_file(WORKSPACE_ROOT / ".env")).get(
            "KNOWLEDGE_WIKI_ROOT"
        )
        if override:
            return Path(override)
    except Exception:  # noqa: BLE001 - a missing .env must not break imports
        pass

    return DEFAULT_WIKI_ROOT


WIKI_ROOT = _resolve_wiki_root()

# Directories under WIKI_ROOT holding curated wiki pages.
# `sources/` is deliberately absent: it is a raw source tree containing
# holdings, income plans and personal info. See EXCLUDED_WIKI_DIRS.
CURATED_WIKI_DIRS = (
    "concepts",
    "decisions",
    "diagrams",
    "meetings",
    "people",
    "projects",
    "research",
)

# Never ingested. `sources/**` holds raw copies of other files, which may
# include private material that was never meant to be shared.
EXCLUDED_WIKI_DIRS = (
    "sources",
    ".git",
    ".obsidian",
)

# Generated or structural files that are not knowledge pages.
EXCLUDED_WIKI_FILES = (
    "index.md",
    "README.md",
    "log.md",
)

# --- Access taxonomy --------------------------------------------------------
#
# The fall-through topic. A page nothing tagged lands here. It is sensitive, so
# a row nobody has classified is invisible by default rather than readable by
# the first person given any grant: the failure is a miss, not a leak.
DEFAULT_DOMAIN = UNCLASSIFIED


def domains() -> tuple[str, ...]:
    """Every topic id of this Engine, `unclassified` included. Must match
    workspace.domains. Loads the Engine config on first use."""
    from .engine_config import get_config

    return get_config().domain_ids


def sensitive_domains() -> frozenset[str]:
    """Topics that need a deliberate grant. Never included in a bulk or default
    grant, and ingested last -- only after the access filter has been verified
    end to end. `unclassified` is always one of them."""
    from .engine_config import get_config

    return get_config().sensitive_domain_ids


def __getattr__(name: str):
    """`config.DOMAINS` / `config.SENSITIVE_DOMAINS`, read from the Engine
    config when first asked for.

    Kept for older call sites. Use it as `config.DOMAINS` at the point of use;
    `from .config import DOMAINS` at the top of a module would load the config
    at import time, which nothing may do -- call `domains()` instead.
    """
    if name == "DOMAINS":
        return domains()
    if name == "SENSITIVE_DOMAINS":
        return sensitive_domains()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Provenance tiers.
TIER_VERIFIED = 1   # carries an explicit `verified:` stamp
TIER_CURATED = 2    # concepts / decisions / people / projects / research / diagrams
TIER_DISTILLED = 3  # meetings
TIER_RAW = 4        # anything unclassified

# Sectioning. Pages above this are split on `##` boundaries, never below.
SECTION_THRESHOLD_TOKENS = 1500
# Rough chars-per-token for gte-small; only used to decide whether to section.
CHARS_PER_TOKEN = 4

SOURCE_WIKI = "wiki"
SOURCE_DRIVE = "drive"
SOURCE_GMAIL = "gmail"
# Full meeting transcripts. Named `fireflies` because that is their origin and
# because workspace.raw_captures has a CHECK constraint allowing only
# gmail / fireflies / drive. Do not invent a fourth source value.
SOURCE_FIREFLIES = "fireflies"

# --- Gmail connector --------------------------------------------------------
#
# The only scope is the label: a thread is indexed when it carries a label
# named `<prefix><topic>` (see connectors/gmail.py). There is no sender list
# and no contact list here.

# A run that finds more labelled threads than this stops before reading any:
# a full sync must never carry only part of the set.
GMAIL_MAX_THREADS_PER_RUN = 500
GMAIL_MAX_THREAD_CHARS = 60_000

# --- Transcripts connector --------------------------------------------------
# 119 files, local, no API. Currently indexed in NEITHER store -- verified.
# The wiki holds 134 meeting SUMMARIES; these hold the actual quotes.
TRANSCRIPTS_DIR = WORKSPACE_ROOT / "memory" / "transcripts"

# --- Google Drive connector -------------------------------------------------
#
# The connector indexes native Workspace types by default
# (`sources.drive.include_mime`). Everything else is opt-in: a Drive full of
# scanned files would bury the documents that matter and cost far more to embed.

DRIVE_MIME_DOC = "application/vnd.google-apps.document"
DRIVE_MIME_SHEET = "application/vnd.google-apps.spreadsheet"
DRIVE_MIME_SLIDE = "application/vnd.google-apps.presentation"
DRIVE_MIME_FOLDER = "application/vnd.google-apps.folder"

DRIVE_INDEXED_MIMES: tuple[str, ...] = (
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEET,
    DRIVE_MIME_SLIDE,
)

# Folders skipped wholesale, matched against any ancestor folder name.
DRIVE_EXCLUDED_FOLDERS: tuple[str, ...] = ()

# Only Google Docs expose plain text cheaply. Sheets and Slides are indexed on
# their metadata -- title, folder path, link -- which is enough to FIND them.
DRIVE_FETCH_BODY_MIMES: tuple[str, ...] = (DRIVE_MIME_DOC,)

# Guard against a runaway backfill.
DRIVE_MAX_FILES = 2000
DRIVE_MAX_BODY_CHARS = 40_000

# Embedding -- both backends in embedder.py must produce this size.
EMBEDDING_DIM = 384

# Backends live in scripts/knowledge/embedder.py. `local` uses
# sentence-transformers (a developer machine only); `remote` calls the `embed` edge function.
# Selected at runtime via KNOWLEDGE_EMBED_BACKEND in .env, defaulting to local.
# The two must be verified equivalent by verify_embedding_alignment.py before
# `remote` writes anything to production -- a divergence produces no error, only
# silently wrong cosines between rows written on different machines.
EMBEDDING_MODEL_NAME = "gte-small"
EMBEDDING_ALIGNMENT_THRESHOLD = 0.99

# Batch size for embedding calls and for Supabase upserts.
EMBED_BATCH_SIZE = 32
UPSERT_BATCH_SIZE = 200


def verify_taxonomy(supabase_client) -> None:
    """Assert the Engine config's topics match workspace.domains.

    A connector labelling rows with a domain the database does not know produces
    rows no grant can ever reach. Raises rather than warning.
    """
    try:
        resp = (
            db(supabase_client)
            .table("domains")
            .select("domain")
            .execute()
        )
    except Exception as error:
        raise RuntimeError(
            "Could not read the domains table to verify the taxonomy. "
            "Have the migrations been applied?"
        ) from error

    db_domains = {row["domain"] for row in (resp.data or [])}
    local_domains = set(domains())

    if db_domains != local_domains:
        missing_in_db = sorted(local_domains - db_domains)
        missing_locally = sorted(db_domains - local_domains)
        raise ValueError(
            "Domain taxonomy drift between the Engine config and "
            f"the domains table. Missing in database: {missing_in_db}. "
            f"Missing in config: {missing_locally}."
        )
