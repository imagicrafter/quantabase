-- 0045_api_roles_schema_usage.sql
--
-- Lets the three Supabase API roles (anon, authenticated, service_role) look
-- inside the `workspace` schema. Without USAGE on the schema a role cannot
-- call any function in it, whatever EXECUTE grants the function has.
--
-- Why now: the embed function calls workspace.principal_can_embed with the
-- project's anon key (0012, 0016 grant EXECUTE on it to anon). Migrations
-- 0001-0028 were first written against a project where the schema already
-- carried this USAGE, so no migration ever granted it. On a database built
-- from empty the call failed ("permission denied for schema") and the embed
-- function answered HTTP 500 authorization_check_failed.
--
-- What this does NOT open: USAGE gives no access to any table, and no
-- function that has had EXECUTE revoked from PUBLIC. The tables carry no
-- grants to these roles, and api_roles_usage_test.sql pins the exact list of
-- functions anon and authenticated may run.
--
-- Safe to re-run and a no-op where the grant is already there.

grant usage on schema workspace to anon, authenticated, service_role;


-- VERIFY ------------------------------------------------------------------
-- select has_schema_privilege('anon', 'workspace', 'usage');          -- expect t
-- select has_schema_privilege('authenticated', 'workspace', 'usage'); -- expect t
-- select has_schema_privilege('service_role', 'workspace', 'usage');  -- expect t


-- ROLLBACK ------------------------------------------------------------------
-- Only on a database built from empty (an older database had this grant
-- before any migration ran, and the embed function needs it):
-- revoke usage on schema workspace from anon, authenticated, service_role;
