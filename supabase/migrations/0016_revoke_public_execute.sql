-- 0016_revoke_public_execute.sql
--
-- Closes the PUBLIC EXECUTE grant on workspace functions that were missed by
-- prior migrations.
--
-- WHY THIS IS NEEDED — verified live 2026-08-14:
--   `select has_function_privilege('anon', p.oid, 'execute')
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'workspace';`
--   returned TRUE for every workspace function, including documents_search,
--   memory_search_authed, principal_can_embed, and resolve_domains.
--
-- ROOT CAUSE: PostgreSQL grants EXECUTE to PUBLIC by default when a function is
-- created. `revoke ... from anon, authenticated` in migrations 0006 and 0011
-- never removed this default PUBLIC grant — `anon` inherits EXECUTE from PUBLIC.
-- Migration 0012 (embedding capability) used the correct pattern:
--   `revoke all ... from public`
-- and that is the model this migration follows.
--
-- EXPOSURE ASSESSMENT (documented here, not understated, not overstated):
--   - documents_search: SECURITY DEFINER, requires a 256-bit token hash. An
--     unauthenticated caller passing a random string gets zero rows (fail-closed
--     contract of resolve_domains). No data was leaked by this defect.
--   - memory_search_authed: same token-hash gate; SECURITY DEFINER.
--   - principal_can_embed: SECURITY DEFINER, returns boolean. An unauthed caller
--     can check whether a specific 256-bit hash matches an active principal — a
--     timing oracle, but not a read path.
--   - resolve_domains: SECURITY DEFINER, returns an empty array for an unmatched
--     hash. No data leaked. BUT: had resolve_domains_for_email (added in 0014)
--     been left on PUBLIC, a guessable email would have been a domain-disclosure
--     primitive. This migration prevents that class of defect.
--   - hybrid_memory_search: SECURITY INVOKER. anon has zero table grants on
--     workspace.memory_chunks, so a direct call fails with "permission denied for
--     table". Not revoked here — it is already protected by table grants.
--
-- IMPACT ON EXISTING CALLERS:
--   supabase/functions/search/index.ts calls documents_search with the anon key.
--   Once this migration lands, that call breaks with "permission denied for
--   function". The fix is in supabase/functions/search/index.ts:
--   switch SUPABASE_ANON_KEY -> SUPABASE_SERVICE_ROLE_KEY. That change and this
--   migration MUST be deployed together. The edge function is server-side and has
--   no reason to use a publishable key.
--
-- NOTE: Do NOT revoke from hybrid_memory_search — it is SECURITY INVOKER and
-- protected by table grants. Revoking PUBLIC EXECUTE on it would break
-- memory_search_authed, which calls it via SECURITY DEFINER (the definer's
-- privileges extend to calling it, but the test suite verifies this path).

-- documents_search — the main search RPC, live on the token path
revoke all on function workspace.documents_search(
    text, vector, text, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) from public;
grant execute on function workspace.documents_search(
    text, vector, text, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) to service_role;

-- resolve_domains — token -> domain array
revoke all on function workspace.resolve_domains(text) from public;
grant execute on function workspace.resolve_domains(text) to service_role;

-- memory_search_authed — memory chunk search with token gate
revoke all on function workspace.memory_search_authed(
    text, vector, text, integer, double precision, double precision
) from public;
grant execute on function workspace.memory_search_authed(
    text, vector, text, integer, double precision, double precision
) to service_role, authenticated;

-- principal_can_embed — embedding capability check
-- Kept: anon, authenticated still need this for the embed edge function.
-- (The edge function is deployed --no-verify-jwt and authenticates with the anon key.)
-- Revoke PUBLIC, re-grant explicit roles.
revoke all on function workspace.principal_can_embed(text) from public;
grant execute on function workspace.principal_can_embed(text) to anon, authenticated, service_role;

-- touch_principal_last_used — best-effort telemetry, same caller set as embed
revoke all on function workspace.touch_principal_last_used(text) from public;
grant execute on function workspace.touch_principal_last_used(text) to anon, authenticated, service_role;


-- ROLLBACK -------------------------------------------------------------------
-- (Dangerous: re-granting PUBLIC restores the defect. Only run to unblock a
--  broken caller while a targeted fix is prepared.)
-- grant execute on function workspace.documents_search(
--     text, vector, text, integer, integer, integer,
--     double precision, double precision[], double precision, boolean
-- ) to public;
-- grant execute on function workspace.resolve_domains(text) to public;
-- grant execute on function workspace.memory_search_authed(
--     text, vector, text, integer, double precision, double precision
-- ) to public;
-- grant execute on function workspace.principal_can_embed(text) to public;
-- grant execute on function workspace.touch_principal_last_used(text) to public;
