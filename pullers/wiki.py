"""Wiki puller -- clone/pull the knowledge repo, then wrap `knowledge.connectors.wiki`.

The wiki connector already does the whole job of turning a LOCAL checkout
into Documents: discover git-tracked curated pages, split sections, assign
domains. That part is unchanged. What this puller adds is the checkout
itself -- `connectors/wiki.collect()` reads `knowledge.config.WIKI_ROOT`,
which on a long-lived host is a path someone already cloned by hand. A DO CRON job
container starts from nothing every run, so `fetch()` clones (or pulls, if
the container happens to be warm) the repo before calling `collect()`.

No incremental cursor: the connector's own idempotency (unchanged
`source_hash` -> zero writes) makes a full re-scan on every run cheap, and
`ingest.upsert(full_sync=True)` is what actually detects additions/removals.
So each already-built `Document` IS the "raw payload" handed to
`to_document()` -- matching what `workflows/capture_sources.py`
already treated as raw for connectors with no separate raw-text bronze
capture. Git is the bronze layer for wiki, so `BRONZE = False`.
"""

from __future__ import annotations

from typing import Any, Iterable

from knowledge.connectors import wiki as _wiki
from knowledge.contract import Document
from pullers import config_sync
from pullers.knowledge_repo import (  # noqa: F401 -- re-exported names
    CHECKOUT_DIR,
    wiki_repo,
    KnowledgeRepoError as WikiPullError,
    ensure_checkout as _ensure_checkout,
)

SOURCE = "wiki"
BRONZE = False
FULL_SYNC = True


def _root():
    """The knowledge repo's checkout: an existing one, or a fresh clone/pull."""
    from knowledge.config import WIKI_ROOT

    return WIKI_ROOT if WIKI_ROOT.exists() else _ensure_checkout()


def prepare(sb: Any) -> None:
    """Before a run reads anything: apply the config from the knowledge repo.

    The config lives in that repo (.kb-engine/engine.yaml). If it changed, it
    is applied first, so the pages are tagged under the config now in force.
    The runner skips this step on a dry run, because it writes. A bad config
    never raises: see config_sync.py for what happens to an invalid file.
    """
    config_sync.apply_from_checkout(_root(), sb)


def fetch(cursor: dict, *, sb: Any = None) -> tuple[Iterable[Document], dict]:
    """Ignore `cursor` -- the wiki connector has none. Returns {} as the new
    cursor so the runner's cursor write is a harmless no-op for this source.

    Only clones/pulls when `knowledge.config.WIKI_ROOT` resolved to a path
    that does not already exist -- KNOWLEDGE_WIKI_ROOT in .env still wins
    (callers on a long-lived host with a pre-existing checkout are unaffected).
    """
    documents, _audits = _wiki.collect(wiki_root=_root(), include_sensitive=True)
    return documents, {}


def to_document(raw: Document) -> Document:
    """Identity -- `fetch()` already returned validated Documents."""
    return raw
