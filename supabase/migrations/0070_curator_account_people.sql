-- 0070_curator_account_people.sql
--
-- Curator round 4 (2026-11-22): the curator never makes a person page for
-- the Engine's owner or anyone with an account on it. It learns who they
-- are here, from workspace.principals, never from code or config files.
--
--   curator_account_people()   email and display name of every active
--                              principal, for the curator (kb_engine) only.

create or replace function workspace.curator_account_people()
returns table (email text, display_name text)
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select lower(btrim(p.email)), p.display_name
    from workspace.principals p
    where p.active
    order by p.created_at;
$$;

revoke all on function workspace.curator_account_people() from public;
revoke all on function workspace.curator_account_people() from anon, authenticated;
grant execute on function workspace.curator_account_people() to kb_engine;
