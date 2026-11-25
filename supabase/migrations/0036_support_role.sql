-- 0036_support_role.sql
--
-- The support role: what an outside support person may do in this database.
--
--   kb_support   read the support inbox view (v_support_inbox, 0032)
--                run issue_set_card() and issue_set_status()
--                nothing else
--
-- It cannot read documents, people, grants, settings or the issue table
-- itself: it holds no other grant, and every other function has had PUBLIC
-- execute revoked. The view shows only a category, a source name, an error
-- class, a redacted message and counters (see 0032).
--
-- THE LIMIT OF THAT PROMISE. It covers this Engine's schema. Like every
-- database role, kb_support also has whatever the database gives to PUBLIC
-- outside it: it can see object names and function source in the catalog,
-- and it can run a function in another schema if that schema's owner left it
-- open to PUBLIC. On a hosted project no table in `public` is open that way.
-- If the same database holds another application, check what that
-- application leaves open to PUBLIC before enabling support.
--
-- WHY TWO STEPS. kb_support is a group role with no login and no password, so
-- it can live in a migration. A login needs a password, and a password must
-- never be in a file. `kbe support enable` creates the login role as a member
-- of kb_support, with a password it generates and shows once;
-- `kbe support disable` drops that login. This migration grants nothing to
-- anyone until that command is run.

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'kb_support') then
        create role kb_support nologin;
    end if;
end $$;

grant usage on schema workspace to kb_support;

grant select on workspace.v_support_inbox to kb_support;

grant execute on function workspace.issue_set_card(uuid, text) to kb_support;
grant execute on function workspace.issue_set_status(uuid, text, text, text) to kb_support;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_support';                         -- expect 1 (the view)
-- select has_table_privilege('kb_support', 'workspace.documents', 'select');  -- false
-- select has_table_privilege('kb_support', 'workspace.issues', 'select');     -- false


-- ROLLBACK ------------------------------------------------------------------
-- revoke execute on function workspace.issue_set_status(uuid, text, text, text) from kb_support;
-- revoke execute on function workspace.issue_set_card(uuid, text) from kb_support;
-- revoke select on workspace.v_support_inbox from kb_support;
-- revoke usage on schema workspace from kb_support;
-- drop role if exists kb_support;
