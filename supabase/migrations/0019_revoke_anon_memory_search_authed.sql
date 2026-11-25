-- 0019_revoke_anon_memory_search_authed.sql
--
-- Removes the last anon-reachable path into the knowledge/memory search surface.
--
-- WHY THIS EXISTS, and why 0016 was not sufficient:
--
-- 0016 revoked PUBLIC EXECUTE on workspace.memory_search_authed and re-granted it
-- to service_role + authenticated. It did NOT remove the DIRECT `anon` grant that
-- 0013 added -- `revoke ... from public` removes only the PUBLIC default, never a
-- direct role grant. Verified live 2026-08-14: `anon` still held EXECUTE after
-- 0016 had been applied.
--
-- 0013 granted anon deliberately and correctly for its time: the
-- supabase/functions/agent-memory-search edge function authenticated with the
-- publishable anon key. As part of the 0016 rollout that function was moved to the
-- service role, deployed, and verified working against the live project BEFORE
-- this migration was applied. It is the only caller of this RPC anywhere in the
-- repository (grepped across *.ts, *.py, *.sh). The anon grant is therefore dead.
--
-- Ordering note for anyone replaying this history: the edge-function deploy must
-- land BEFORE this migration, or agent-memory-search fails on every request.

revoke execute on function workspace.memory_search_authed(
    text, vector, text, integer, double precision, double precision
) from anon;

comment on function workspace.memory_search_authed(
    text, vector, text, integer, double precision, double precision
) is
    'Token-gated SECURITY DEFINER wrapper over hybrid_memory_search. '
    'Reachable by service_role and authenticated only -- the anon grant from 0013 '
    'was removed in 0019 once craft-memory-search moved to the service role.';

-- Deliberately NOT done, and not an oversight:
--   * hybrid_memory_search keeps its anon grant. It is SECURITY INVOKER with no
--     grants on workspace.memory_chunks, so an anon caller hits a table-permission
--     wall. Revoking it would break memory_search_authed, which calls it as the
--     definer. This is the same reasoning recorded in 0013.
--   * principal_can_embed and touch_principal_last_used keep anon. The embed edge
--     function is deployed --no-verify-jwt and authenticates with the anon key;
--     0016 re-granted them explicitly for exactly this reason.

-- ROLLBACK -------------------------------------------------------------------
-- Only if a caller is found that legitimately needs the publishable key:
--   grant execute on function workspace.memory_search_authed(
--       text, vector, text, integer, double precision, double precision
--   ) to anon;
