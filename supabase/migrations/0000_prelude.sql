-- 0000_prelude.sql
--
-- What every later migration takes for granted: the `workspace` schema,
-- pgvector in `public`, and workspace.set_updated_at(). Migrations 0001-0028
-- were first written against a project that already had these three, so a
-- fresh database needs them created first.
--
-- Safe on a database that already has them: every statement is
-- `if not exists` or `or replace`, and the function body is the same one
-- already in use. `kbe db adopt` records this file as applied without
-- running it.

create schema if not exists workspace;

create extension if not exists vector with schema public;

create or replace function workspace.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

comment on function workspace.set_updated_at() is
    'Trigger function: stamps updated_at on every row update.';


-- VERIFY ------------------------------------------------------------------
-- select to_regnamespace('workspace') is not null;                  -- expect t
-- select count(*) from pg_extension where extname = 'vector';       -- expect 1
-- select to_regprocedure('workspace.set_updated_at()') is not null; -- expect t


-- ROLLBACK ------------------------------------------------------------------
-- Nothing to undo on a database that had these before. On a database built
-- from empty, after rolling back every later migration:
-- drop function if exists workspace.set_updated_at();
-- drop schema if exists workspace;
