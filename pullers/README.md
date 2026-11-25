# pullers/

One module per ingest source. Locking, cursors, bronze capture, embedding,
upsert, tombstoning, triage, distillation and the review queue are shared —
see `pullers/runner.py`. A puller is only the source-specific half:

```python
SOURCE = "my-source"          # the source label stamped on every Document
BRONZE = True                 # capture raw text to workspace.raw_captures?
FULL_SYNC = True              # tombstone rows absent from a full fetch?

def fetch(cursor: dict, *, sb=None) -> tuple[Iterable[Any], dict]:
    """Call the source API. Return raw payloads and the NEW cursor.
    Never summarise here -- raw payloads are what bronze captures."""

def to_document(raw: Any) -> Document:
    """Raw payload -> Document. Assign domains here.
    May raise `SkipPayload` (from `pullers.base`) to drop one payload
    without failing the run (incremental sources only -- see FULL_SYNC below)."""
```

## Adding a new source

1. Write `pullers/<name>.py` satisfying the shape above.
2. Register it in `pullers.runner.REGISTRY`.
3. Add the source's job to `engine/deploy/do-app-spec.template.yaml` and to `scripts/kbe/deploy_render.py` (`kbe deploy render` writes one scheduled job per enabled source).
4. Run `python -m pullers.puller_contract_test` — it must name your source.

No pipeline changes. The surface is this narrow on purpose: everything a
source does not own (locking, capture, embedding, summaries, review) is
shared, so a new source cannot get those wrong.

## Optional `before_upsert` hook (Fireflies only today)

```python
def before_upsert(raws, documents, sb) -> tuple[list[Document], dict]:
    """Runs after to_document(), before bronze + upsert. Return the
    (possibly re-stamped) documents and an info dict for the receipt.
    Must not raise."""
```

`pullers/fireflies.py` uses it to own meetings end to end:

1. `meeting_writeback.write_pages()` renders each meeting as an OKF page
   (`meeting_page.py`) with attendees + `related` links (`meeting_links.py`),
   and pushes `knowledge/meetings/<date>-<slug>.md` to knowledge main
   (`knowledge_repo.py`). Recent rows still missing a page are retried
   (self-heal), so a failed push never loses a page.
2. Each document gets `metadata.wiki_page_id` before it is upserted.
3. `fireflies_retention.run()` deletes Fireflies recordings older than 90
   days ONLY when notes + bronze + wiki page are all saved. Off unless
   `FIREFLIES_RETENTION_ENABLED=true` (`FIREFLIES_RETENTION_DRY_RUN=true`
   lists without deleting). Max 25 deletes per run.

**Meetings shared with the owner.** The Fireflies listing only returns meetings
the owner's own Fireflies recorded. A meeting another person's Fireflies recorded
is fetched by id instead: a scheduled job
`fireflies-shared-scan` reads the recap emails and stores the ids in
`connector_state` row `fireflies-shared`, and `fetch()` pulls the ones it has
not handled (tracked in this source's cursor as `shared_seen`). A shared
recording that overlaps one of the owner's own for at least half its length is
the same call and is skipped. Shared rows carry `metadata.fireflies_shared`,
and retention never deletes them. Logic in `fireflies_shared.py`.

**Meetings with no transcript.** A meeting Fireflies returns with notes but no
sentences is saved notes-only and carries
`metadata.fireflies_transcript_unavailable`; retention never deletes it, since
Fireflies may still finish the transcript. A meeting with neither raises
`SkipPayload`: the runner drops it with a `payload.skipped` warning and the
cursor moves on.

The Fireflies notes ride inside the document body between
`<!-- fireflies-notes -->` markers, so they survive deletion upstream.
`backfill_meeting_pages.py` rebuilt the historical pages (2026-10-15).

## `sb` — the `kb_ingest` client

Every DB touch a puller makes must use the `sb` the runner passes in
(`knowledge.supabase_client.get_supabase_ingest()` — a `kb_ingest`-role
PostgREST JWT, never the service-role key). If your puller wraps a shared
`knowledge.*` module that itself talks to the DB (cursors, bronze), pass
`sb=sb` through to it explicitly — do not rely on that module's own
`sb=None` default, which falls back to the service-role client and exists
only for the pre-cutover callers on a long-lived host.

## `BRONZE` and when capture actually runs

`runner.py` calls `bronze.capture()` itself, AFTER `to_document()`, using
each built Document's `body`/`metadata` — not the raw payload from
`fetch()`. Set `BRONZE = True` if this source's raw text should be
recoverable without re-fetching (drive, fireflies); `False` if another
layer already is the bronze copy (wiki: git) or the text must be removable
(gmail: raw captures are never deleted, and mail has to leave the database
when its label comes off).

## Gmail: off by default, labels only

The Gmail puller runs only when the config has `sources.gmail.enabled: true`
(`gmail.enabled()`; the runner asks before it takes the lock). A thread is
read only if it carries a label named `<prefix><topic>`; threads are listed
by label id, so other mail is never fetched or stored. Each thread carries
the owner of its mailbox. Taking the label off a thread takes it out of the
index on the next run: the run is a full sync, and `gmail.confirm_absent()`
checks each missing thread so a real removal does not trip the bulk guard.

## `FULL_SYNC` and the tombstone trap

`FULL_SYNC = True` means `ingest.upsert()` tombstones every row from this
source NOT present in the current fetch. Get this wrong and a connector
whose default scope is narrower than the corpus it's syncing against reads
absence as deletion — this happened in production (2026-08-13, 87 rows).
If your `fetch()` can ever return a deliberately-narrowed subset (a
sensitivity filter, a date window, a page-size cap), either fetch
everything under `full_sync`, or set `FULL_SYNC = False` and accept that
this source never tombstones automatically.

One absence is *not* a deletion: a renumbered wiki section. Section ids are
index-prefixed (`<page>#NN-<slug>`), so adding or removing a `##` heading
renumbers every section below it and the old ids go absent while the page and a
fresh set of section ids are re-emitted in the same run. From 2026-10-24 to
2026-11-05 this blocked the wiki puller for 13 straight nights: 281 renumbered
meeting/decision sections (29% of 983 live rows) tripped the guard, so no new or
changed page was indexed. `ingest.upsert()` now exempts these **superseded**
rows -- an absent id whose stored `parent_external_id` is still in the fetch --
from the threshold (`ingest.split_superseded`). They are still soft-deleted;
they just no longer count as deletions. Absent *pages*, and sections whose
parent page is also gone, still trip the guard exactly as before.

Also: never raise `SkipPayload` from a `FULL_SYNC = True` puller. The runner
treats a skip in a full-sync source as a `RunnerError` -- dropping a row would
silently tombstone its stored copy, which is the same failure mode described above.

## Two known traps in this codebase (read before debugging either)

- **PostgREST bulk-write union-of-keys**: a single INSERT/upsert call is
  built from the UNION of keys across the whole payload; a row omitting a
  key gets that key set to explicit NULL, not its column DEFAULT. Killed the
  wiki connector for seven days. `knowledge.ingest.group_by_columns()` is
  the fix — never bypass it with a raw `.upsert()` call.
- **Supabase `apikey` vs `Authorization`**: the second positional arg to
  `create_client()` becomes the gateway's `apikey` header, validated against
  known PROJECT keys only. A correctly-signed `kb_ingest` role JWT there
  always fails with "Invalid API key". The role JWT goes in `Authorization`
  as the bearer token; `apikey` stays `SUPABASE_ANON_KEY`. See
  `knowledge.supabase_client.get_supabase_ingest`.
