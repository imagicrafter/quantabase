-- 0023_kb_ingest_role.sql
--
-- Creates the `kb_ingest` PostgreSQL role: the WRITE identity for puller jobs,
-- separate from `kb_engine` (0018), which stays read-only with zero table
-- grants. Modelled on 0018, inverted: writes, and no reads it does not need.
--
-- DESIGN — two roles, never one (plan Design Decision 2):
--   The MCP service must never be able to write; the pullers must never be
--   able to read a document they did not just write. `kb_ingest` holds NO
--   grant on any function or table the retrieval path uses.
--
-- Authentication mirrors `kb_engine` exactly: a PostgREST JWT
--   { "role": "kb_ingest", "iss": "supabase", "exp": <1 year> }
-- signed with SUPABASE_JWT_SECRET (shared with another production app -- same caveat
-- as 0018). Minted by `scripts/knowledge/supabase_client.py::get_supabase_ingest()`.
--
-- APPLY WITH `apply_migration`, NEVER `execute_sql` -- this DDL is scoped to
-- the `workspace` schema only. Do not run this against any other schema.
--
-- NOT YET APPLIED as of authoring. Hand back to the session applying
-- migrations with:
--   supabase apply_migration (workspace schema, this file)

create role kb_ingest nologin;

grant usage on schema workspace to kb_ingest;

-- Bronze: append-only by privilege, not convention. INSERT + SELECT only --
-- no UPDATE, no DELETE. Manual Section 4.2.
grant insert, select on workspace.raw_captures to kb_ingest;

-- Silver: pullers write new rows, update existing ones (content changes,
-- tombstoning, distillation, review-status resets) -- never delete.
grant select, insert, update on workspace.documents to kb_ingest;

-- Per-source cursor/lock state.
grant select, insert, update on workspace.connector_state to kb_ingest;

-- Gold queue: the runner both builds batches and applies decided items.
grant select, insert, update on workspace.review_batches to kb_ingest;
grant select, insert, update on workspace.review_items to kb_ingest;

-- Regenerate/exclude decisions insert a rejection row; never read back by
-- pullers beyond the exclusion-key check triage already does in-process.
grant select, insert on workspace.distillation_rejections to kb_ingest;

-- Taxonomy verification (knowledge.config.verify_taxonomy) -- read-only.
grant select on workspace.domains to kb_ingest;

-- SECURITY DEFINER, pinned search_path -- EXECUTE only, no table grant on
-- workspace.documents_search_stats. ingest._refresh_stats() calls this via
-- RPC on every sync that wrote anything; skipping this grant means pullers
-- can write documents but never refresh the BM25 stats that make them
-- findable -- documents_search would then return ZERO ROWS for every
-- caller, indistinguishable from "you have no access." A puller that
-- cannot refresh stats degrades search silently.
grant execute on function workspace.refresh_documents_term_stats() to kb_ingest;

-- Required. Without this, PostgREST's SET ROLE silently falls back and
-- every kb_ingest-authenticated call fails "permission denied" -- Trap 2.
grant kb_ingest to authenticator;


-- VERIFY ------------------------------------------------------------------
-- select rolname from pg_auth_members m
--   join pg_roles r on r.oid = m.roleid
--   join pg_roles a on a.oid = m.member
--  where r.rolname = 'kb_ingest' and a.rolname = 'authenticator';
-- -- expect: one row
--
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_ingest' and privilege_type = 'DELETE';
-- -- expect: 0
--
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_engine';
-- -- expect: 0 (kb_engine keeps zero table grants after this migration)


-- ROLLBACK ------------------------------------------------------------------
-- revoke kb_ingest from authenticator;
-- revoke execute on function workspace.refresh_documents_term_stats() from kb_ingest;
-- revoke select on workspace.domains from kb_ingest;
-- revoke select, insert on workspace.distillation_rejections from kb_ingest;
-- revoke select, insert, update on workspace.review_items from kb_ingest;
-- revoke select, insert, update on workspace.review_batches from kb_ingest;
-- revoke select, insert, update on workspace.connector_state from kb_ingest;
-- revoke select, insert, update on workspace.documents from kb_ingest;
-- revoke insert, select on workspace.raw_captures from kb_ingest;
-- revoke usage on schema workspace from kb_ingest;
-- drop role if exists kb_ingest;
