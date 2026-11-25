-- migrations_applied_test.sql -- checks for migration 0059.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * engine_migrations_applied: kb_engine only; an empty list without the
--     tracking table; the applied names in order once it exists

begin;

do $$
begin
    assert has_function_privilege('kb_engine', 'workspace.engine_migrations_applied()', 'execute'), 'kb_engine may read';
    assert not has_function_privilege('anon', 'workspace.engine_migrations_applied()', 'execute'), 'anon may not';
    assert not has_function_privilege('authenticated', 'workspace.engine_migrations_applied()', 'execute'), 'authenticated may not';

    drop table if exists workspace.kbe_migrations;
    assert workspace.engine_migrations_applied() = array[]::text[], 'no table: empty list';

    create table workspace.kbe_migrations (
        filename text primary key, checksum text not null, applied_at timestamptz not null default now()
    );
    insert into workspace.kbe_migrations (filename, checksum)
    values ('0002_b.sql', 'x'), ('0000_a.sql', 'y');
    assert workspace.engine_migrations_applied() = array['0000_a.sql', '0002_b.sql'], 'names in order';
end;
$$;

rollback;
