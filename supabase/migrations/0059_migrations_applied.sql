-- 0059_migrations_applied.sql
--
-- Read-only: the names of the migration files this database has applied, in
-- order, for the service itself (no person, no sign-in).
--
-- The app compares this list with the files it ships with, so it can log the
-- pending ones at boot and show "Database update needed: N pending" on the
-- Health, Indexing and Database screens (instead of a raw RPC failure after an
-- app update whose migrations were never applied). File names only: no
-- checksums, no dates, nothing about the content.
--
-- kbe_migrations is made by `kbe db migrate` (and the Database screen), not by
-- a migration, so a database without it answers an empty list.

create or replace function workspace.engine_migrations_applied()
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_names text[];
begin
    if to_regclass('workspace.kbe_migrations') is null then
        return array[]::text[];
    end if;
    execute 'select coalesce(array_agg(filename order by filename), array[]::text[]) '
            'from workspace.kbe_migrations'
        into v_names;
    return v_names;
end;
$$;

comment on function workspace.engine_migrations_applied() is
    'The applied migration file names, in order. Names only. For the service.';

revoke all on function workspace.engine_migrations_applied() from public;
revoke all on function workspace.engine_migrations_applied() from anon, authenticated;
grant execute on function workspace.engine_migrations_applied() to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('anon',
--   'workspace.engine_migrations_applied()', 'execute');   -- f


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.engine_migrations_applied();
