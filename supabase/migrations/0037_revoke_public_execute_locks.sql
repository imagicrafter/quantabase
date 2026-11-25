-- 0037_revoke_public_execute_locks.sql
--
-- Closes the default PUBLIC execute grant on six functions that earlier
-- migrations left open (the same defect 0016 closed for the search functions).
-- Postgres grants EXECUTE to PUBLIC when a function is created; a
-- `grant ... to service_role` does not remove it.
--
-- Why now: a role with no grants of its own (kb_support, 0036) could still run
-- these through PUBLIC. Three of them are SECURITY DEFINER:
--
--   acquire_connector_lock / release_connector_lock
--       anyone could hold or drop a source's run lock and stall ingestion
--   refresh_documents_term_stats
--       anyone could start the search statistics rebuild
--
-- The other three do no harm on their own (a pure scoring function and two
-- trigger functions) and are closed so "nothing else" can be tested by name.
-- Triggers keep firing: Postgres checks a trigger function's EXECUTE when the
-- trigger is created, not when it fires. documents_search() calls the scoring
-- function as its own owner.
--
-- Who keeps access: the pullers (kb_ingest) take and release the lock and
-- rebuild the statistics; service_role keeps the grants it already had.

revoke all on function workspace.acquire_connector_lock(text, text, integer) from public;
revoke all on function workspace.acquire_connector_lock(text, text, integer) from anon, authenticated;
revoke all on function workspace.release_connector_lock(text) from public;
revoke all on function workspace.release_connector_lock(text) from anon, authenticated;
revoke all on function workspace.refresh_documents_term_stats() from public;
revoke all on function workspace.refresh_documents_term_stats() from anon, authenticated;
revoke all on function workspace.documents_bm25_score(
    tsvector, tsquery, integer, integer, double precision, double precision, double precision
) from public;
revoke all on function workspace.documents_tsv_trigger() from public;
revoke all on function workspace.set_updated_at() from public;

grant execute on function workspace.acquire_connector_lock(text, text, integer)
    to kb_ingest, service_role;
grant execute on function workspace.release_connector_lock(text) to kb_ingest, service_role;
grant execute on function workspace.refresh_documents_term_stats() to kb_ingest, service_role;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('anon',
--   'workspace.acquire_connector_lock(text, text, integer)', 'execute');   -- false
-- select has_function_privilege('kb_ingest',
--   'workspace.acquire_connector_lock(text, text, integer)', 'execute');   -- true


-- ROLLBACK ------------------------------------------------------------------
-- grant execute on function workspace.acquire_connector_lock(text, text, integer) to public;
-- grant execute on function workspace.release_connector_lock(text) to public;
-- grant execute on function workspace.refresh_documents_term_stats() to public;
-- grant execute on function workspace.documents_bm25_score(
--     tsvector, tsquery, integer, integer, double precision, double precision, double precision
-- ) to public;
-- grant execute on function workspace.documents_tsv_trigger() to public;
-- grant execute on function workspace.set_updated_at() to public;
