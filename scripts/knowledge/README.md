# scripts/knowledge — the ingest library

The library the jobs in `pullers/` use: the document contract, ingest, tags,
summaries, embedding, the review queue, and the token and access tools. It
writes one row per document into the `documents` table of the Engine's schema
(`workspace` unless `KB_SCHEMA` says otherwise).

How it fits with the rest: [`docs/architecture.md`](../../docs/architecture.md).

## Layout

| File | Role |
|---|---|
| `config.py` | Paths, taxonomy mirror, tiers, batch sizes. `verify_taxonomy()` asserts the local domain list matches `workspace.domains`. |
| `contract.py` | The `Document` dataclass. Frozen, validated on construction. |
| `tag_resolver.py` | Decides a document's topics from tags at the source: content tag, container tag, source default, then `unclassified`. No keyword rules. See `docs/tagging.md`. |
| `tag_sources/` | Per-source tag readers (wiki frontmatter, Drive descriptions, Fireflies channels, Gmail labels). |
| `taxonomy.py` | Removed; a shim that points to `tag_resolver`. |
| `frontmatter.py` | YAML frontmatter parsing with a dependency-free fallback. |
| `ingest.py` | Hash-diff upsert, tombstone-on-resync, BM25 stats refresh. |
| `supabase_client.py` | Service-role client, credentials read from `.env`. |
| `connectors/wiki.py` | The local clone of the knowledge repo (`KNOWLEDGE_WIKI_ROOT`) → documents. |
| `connectors/drive.py` | Google Drive artifacts → documents. |
| `connector_contract_test.py` | The gate every connector must pass. |
| `verify_ingest.py` | Live checks: zero-writes-on-rerun, tombstone-and-revive. |
| `backfill_wiki.py` / `backfill_drive.py` | Backfill CLIs. |
| `mint_token.py` / `search.py` | Issue a bearer token; query the store. |
| `model_backends.py` | Thin, pluggable model caller for the eval harness: `do` (DigitalOcean, OpenAI-compatible), `anthropic`, `agent_sdk` (the production agent path). |
| `model_eval.py` | Distillation model evaluation harness: freezes a reproducible candidate set, runs it through several arms, scores every reply with `distill.parse()` / `distill.verify_terms()` unchanged. |

## Running

The jobs call this library through `pullers/runner.py`; see
`pullers/README.md`. The commands below are for work on the library itself.
Run them from `scripts/`, with a Python that has `pullers/requirements.txt`
installed.

```
cd scripts

# Reads the wiki, resolves topics and tiers, writes a CSV audit.
# No database contact, no embedding.
python -m knowledge.backfill_wiki --audit-only

# The contract every connector must pass. The wiki only; add --network for Drive.
python -m knowledge.connector_contract_test

# Reads the database, reports the difference, writes nothing.
python -m knowledge.backfill_wiki --dry-run

# Search as a person whose token is in the local env file.
python -m knowledge.search "lease renewal"
```

Embedding uses the embed function (`KNOWLEDGE_EMBED_BACKEND=remote`). The
`local` backend needs `sentence-transformers`, which is not in
`pullers/requirements.txt`; a machine that uses both should run
`python -m knowledge.verify_embedding_alignment` first.

## The Drive connector

Indexes native Google Workspace documents: Docs, Sheets and Slides. Only
Docs expose plain text cheaply, so Sheets and Slides are indexed on their
metadata (title, type, folder path, link). That is enough to find them;
opening them is the second step.

A Drive file's topics come from a tag in its own description or in a folder
above it (`docs/tagging.md`). A file with no tag is `unclassified`.

## Retrieval

`documents_search(query_text, query_embedding, p_token_hash, ...)`.

Tunables are named parameters with stated defaults: `match_count` 10,
`candidate_pool` 200, `rrf_k` 60, `half_life_days` 365,
`tier_weights` `[1.30, 1.15, 1.00, 0.85]`.

One behaviour worth knowing: a narrower grant gives deeper coverage of its
own topic, because `candidate_pool` caps the pool before the two rankings
are fused. A caller granted one topic can see rows of that topic which a
broader caller's top results miss. Every returned row still carries a
granted topic, so this is not an access problem, but "a restricted caller
gets a strict subset of a broad caller's results" is false and must not be
used as a test.

## Writing a connector

A connector is one module exposing `collect()` that returns `Document`
objects. Add it to the registry in `connector_contract_test.py` and make the
test pass. Nothing downstream changes.

Three rules the contract enforces and one it cannot:

1. **One row per document.** A meeting is one row. A long page is split only
   above about 1,500 tokens, on `##` boundaries, never below `##`.
2. **`external_id` and `source_hash` must be stable** across runs over
   unchanged input. Ingest compares hashes to decide whether to write, so an
   unstable hash re-embeds everything on every run.
3. **`domains` is never empty.** A row with no topic would be invisible to
   everyone, with no error. A database constraint backs this up.
4. *(Not machine-checkable)* **`tier` must be justified against real
   content.** Tier is assigned by the folder a page is curated into.

Folders under the wiki that are raw mirrors, not curated pages, are left out
(`config.EXCLUDED_WIKI_DIRS`).

## Distillation

The summary written to `documents.distillation`, and therefore the text that
is embedded. It has three parts:

```
WHAT   what this document is
WHY    why it exists or what it decided, and its standing
TERMS  concrete strings someone might type
```

`TERMS` matters most for documents with no extractable body text (Sheets
and Slides). For those the distillation is the only searchable text.

**Every term must appear verbatim in the source.** Terms not found are
dropped, and a generation whose terms are mostly invented is rejected whole
and writes nothing.

`distill.py` defines the contract and renders the prompt. The jobs call the
model through `model_client.py`, with the model named by `models.distill` in
the Engine config.

### Why it is safe to re-run

`Document.source_hash` deliberately excludes `distillation`. Otherwise every
run would see its own placeholder summary differ from the generated one,
overwrite it and re-embed. Excluding it is safe because the distillation is
derived from `title` and `body`, both of which are hashed.

`metadata.distill` records `{version, model, content_hash}`, so unchanged
content is not distilled twice. Bump `DISTILLER_VERSION` to refresh
everything.

### Triage rules are deterministic on purpose

Rules are testable, diffable and free. The model is never asked whether a
document deserves a summary, only to write one for what survives. Skipped:
sections of a larger document, bodies under 400 characters, untitled, backup,
copy and test-fixture titles, byte-identical duplicates, and anything already
distilled at the current version.

Title similarity is not treated as evidence of a duplicate; identical
content is.

## Model evaluation

`model_eval.py` compares distillation models before one is adopted. It
scores every reply with the same `distill.parse()` and `verify_terms()` the
jobs use.

```
cd scripts
python -m knowledge.model_eval --freeze 25    # fix a reproducible set
python -m knowledge.model_eval --run          # run every arm against it
python -m knowledge.model_eval_test           # offline tests, no spend
```

`--max-docs` defaults to 25 and refuses to exceed 50 without `--confirm`.

## Access model

`domains` on the row, grants held separately, intersected in SQL. The
retrieval function takes a **token hash**, not a topic list. A caller that
could supply its own topic list could supply every topic, which would make
the model a suggestion and not a boundary.

A sensitive topic is never part of an implicit or bulk grant. It is granted
by name. See `docs/roles.md`.
