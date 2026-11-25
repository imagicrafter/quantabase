-- 0025_kb_ingest_rls_policies.sql
--
-- Completes 0023. Without this, `kb_ingest` holds table grants and reads
-- ZERO ROWS.
--
-- WHY THIS IS NEEDED --------------------------------------------------------
-- Every `workspace` table runs RLS enabled with NO policies (the posture set
-- by 0001). That has been safe until now only because of who does the reading:
--
--   service_role   rolbypassrls = true    -- reads tables directly, bypasses
--   kb_engine      rolbypassrls = false   -- holds ZERO table grants; reads
--                                            only through SECURITY DEFINER
--                                            functions, which run as owner
--   kb_ingest      rolbypassrls = false   -- holds DIRECT table grants  <-- new
--
-- `kb_ingest` is the first role in this build that is neither. RLS enabled
-- with no policy means no row qualifies, so on 2026-08-23, immediately after
-- 0023 applied, a live probe returned:
--
--     kb_ingest reads workspace.domains: 0 rows      (there are 10)
--
-- That is precisely the recorded `aios_readonly` incident this build's manual
-- holds up as its cautionary tale — a SELECT grant with no matching RLS
-- policy returning zero rows silently — reproduced by our own migration.
--
-- It fails worse than it reads. `ingest._fetch_existing()` returning an empty
-- mapping does not raise: it means EVERY document looks new, so a puller would
-- attempt to re-insert and re-embed the entire corpus, and those writes would
-- then be rejected by the same RLS with no error naming the cause.
--
-- WHY POLICIES AND NOT `alter role kb_ingest bypassrls` ----------------------
-- BYPASSRLS is a property of the role across the WHOLE DATABASE. This Supabase
-- project is shared with another production app, a paying client's live system, so a
-- role that bypasses RLS everywhere is a far larger blast radius than the
-- seven tables this role is supposed to touch. Policies are per-table and
-- greppable. Decided by the owner, 2026-08-23.
--
-- WHY PER-COMMAND POLICIES AND NOT `FOR ALL` ---------------------------------
-- Grants gate the command; policies gate the rows. A `FOR ALL` policy would
-- permit DELETE the moment someone added a DELETE grant by mistake. Mirroring
-- 0023's grants command-for-command means TWO mistakes are needed, not one.
-- This build's stated philosophy is structural properties over things somebody
-- has to remember — `kb_engine`'s zero-table-grants posture is the same idea.
--
-- The predicates are `true` deliberately: row-level filtering for this role is
-- not the job here. `kb_ingest` is an ingestion writer; WHICH rows a *reader*
-- may see is enforced elsewhere, inside the SECURITY DEFINER retrieval
-- functions, from a verified identity. See manual Section 10.1 — labelling and
-- enforcement are deliberately separate mechanisms.
--
-- APPLY WITH `apply_migration`, NEVER `execute_sql`. Scoped to the `workspace`
-- schema only. Do not run this against any other schema.


-- raw_captures — 0023 grants INSERT, SELECT. Append-only by privilege: no
-- update policy, no delete policy, matching the grant.
create policy kb_ingest_select on workspace.raw_captures
    for select to kb_ingest using (true);
create policy kb_ingest_insert on workspace.raw_captures
    for insert to kb_ingest with check (true);


-- documents — 0023 grants SELECT, INSERT, UPDATE. Never DELETE: rows are
-- tombstoned via `deleted_at`, never removed (manual Section 7.4).
create policy kb_ingest_select on workspace.documents
    for select to kb_ingest using (true);
create policy kb_ingest_insert on workspace.documents
    for insert to kb_ingest with check (true);
create policy kb_ingest_update on workspace.documents
    for update to kb_ingest using (true) with check (true);


-- connector_state — per-source cursors and the expiring advisory lock.
create policy kb_ingest_select on workspace.connector_state
    for select to kb_ingest using (true);
create policy kb_ingest_insert on workspace.connector_state
    for insert to kb_ingest with check (true);
create policy kb_ingest_update on workspace.connector_state
    for update to kb_ingest using (true) with check (true);


-- review_batches / review_items — the runner both builds batches and applies
-- decided items, so it needs UPDATE on both (applied_at, decisions).
create policy kb_ingest_select on workspace.review_batches
    for select to kb_ingest using (true);
create policy kb_ingest_insert on workspace.review_batches
    for insert to kb_ingest with check (true);
create policy kb_ingest_update on workspace.review_batches
    for update to kb_ingest using (true) with check (true);

create policy kb_ingest_select on workspace.review_items
    for select to kb_ingest using (true);
create policy kb_ingest_insert on workspace.review_items
    for insert to kb_ingest with check (true);
create policy kb_ingest_update on workspace.review_items
    for update to kb_ingest using (true) with check (true);


-- distillation_rejections — 0023 grants SELECT, INSERT only. The ledger is
-- append-only: a rejection is a fact about content at a hash, never edited.
create policy kb_ingest_select on workspace.distillation_rejections
    for select to kb_ingest using (true);
create policy kb_ingest_insert on workspace.distillation_rejections
    for insert to kb_ingest with check (true);


-- domains — read-only taxonomy verification (knowledge.config.verify_taxonomy).
create policy kb_ingest_select on workspace.domains
    for select to kb_ingest using (true);


-- VERIFY ------------------------------------------------------------------
-- The check that actually catches this class of bug is a ROW COUNT, not an
-- absence of exceptions. A zero-rows result and a working query are
-- indistinguishable from the caller's side unless you compare against a known
-- non-zero total.
--
-- As kb_ingest:
--   select count(*) from workspace.domains;     -- expect 10, NOT 0
--   select count(*) from workspace.documents;   -- expect ~1002, NOT 0
--
-- And confirm nothing widened:
--   select count(*) from information_schema.role_table_grants
--    where grantee = 'kb_engine';               -- expect 0
--   select rolbypassrls from pg_roles where rolname = 'kb_ingest';
--                                               -- expect false
--   select tablename, policyname, cmd, roles from pg_policies
--    where schemaname = 'workspace' order by tablename, cmd;
--                                               -- every row roles = {kb_ingest}


-- ROLLBACK ------------------------------------------------------------------
-- drop policy if exists kb_ingest_select on workspace.domains;
-- drop policy if exists kb_ingest_insert on workspace.distillation_rejections;
-- drop policy if exists kb_ingest_select on workspace.distillation_rejections;
-- drop policy if exists kb_ingest_update on workspace.review_items;
-- drop policy if exists kb_ingest_insert on workspace.review_items;
-- drop policy if exists kb_ingest_select on workspace.review_items;
-- drop policy if exists kb_ingest_update on workspace.review_batches;
-- drop policy if exists kb_ingest_insert on workspace.review_batches;
-- drop policy if exists kb_ingest_select on workspace.review_batches;
-- drop policy if exists kb_ingest_update on workspace.connector_state;
-- drop policy if exists kb_ingest_insert on workspace.connector_state;
-- drop policy if exists kb_ingest_select on workspace.connector_state;
-- drop policy if exists kb_ingest_update on workspace.documents;
-- drop policy if exists kb_ingest_insert on workspace.documents;
-- drop policy if exists kb_ingest_select on workspace.documents;
-- drop policy if exists kb_ingest_insert on workspace.raw_captures;
-- drop policy if exists kb_ingest_select on workspace.raw_captures;
