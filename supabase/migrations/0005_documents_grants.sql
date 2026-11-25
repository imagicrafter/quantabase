-- 0005_documents_grants.sql
--
-- Grant the trusted writer role access to the new tables.
--
-- Why this migration exists: 0001-0003 created the tables and revoked anon and
-- authenticated. What they did NOT do is grant anything to `service_role`. The
-- `workspace` schema has no default privileges covering new tables, so the tables
-- landed owned by `postgres` with no other grantee at all. Ingest failed with
-- "Could not read workspace.domains", which reads like a missing migration rather
-- than a permissions problem.
--
-- This is the same shape as the documented `aios_readonly` incident: a privilege
-- decision that produces silent emptiness instead of an error. Making the grant an
-- explicit, reviewable migration is the point.
--
-- `service_role` only. anon and authenticated stay revoked -- they are the roles a
-- browser-side key maps to, and the retrieval path for those is
-- workspace.documents_search, which is SECURITY DEFINER and needs no table grant.

grant select, insert, update, delete on workspace.documents             to service_role;
grant select, insert, update, delete on workspace.documents_search_stats to service_role;
grant select, insert, update, delete on workspace.documents_term_stats   to service_role;
grant select                          on workspace.domains               to service_role;
grant select, insert, update, delete on workspace.principals             to service_role;
grant select, insert, update, delete on workspace.access_grants          to service_role;

grant execute on function workspace.refresh_documents_term_stats() to service_role;
grant execute on function workspace.resolve_domains(text)          to service_role;
grant execute on function workspace.documents_search(
    text, vector, text, integer, integer, integer, double precision, double precision[]
) to service_role;

-- Belt and braces: these were revoked at creation, but re-assert it here so the
-- posture is stated in one place rather than inferred across three migrations.
revoke all on workspace.documents             from anon, authenticated;
revoke all on workspace.documents_search_stats from anon, authenticated;
revoke all on workspace.documents_term_stats   from anon, authenticated;
revoke all on workspace.domains               from anon, authenticated;
revoke all on workspace.principals            from anon, authenticated;
revoke all on workspace.access_grants         from anon, authenticated;


-- ROLLBACK -------------------------------------------------------------------
-- revoke all on workspace.documents,
--               workspace.documents_search_stats,
--               workspace.documents_term_stats,
--               workspace.domains,
--               workspace.principals,
--               workspace.access_grants
--   from service_role;
