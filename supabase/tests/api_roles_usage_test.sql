-- api_roles_usage_test.sql -- checks for migration 0045.
-- Run by apply_local.sh against a throwaway database, as a superuser. Any
-- failed check raises and stops the run. Nothing is written.

begin;

-- 1. The three API roles can look inside the schema. The embed function
--    needs this to call principal_can_embed with the anon key.
do $$
begin
    assert has_schema_privilege('anon', 'workspace', 'usage'), 'anon lacks USAGE';
    assert has_schema_privilege('authenticated', 'workspace', 'usage'), 'authenticated lacks USAGE';
    assert has_schema_privilege('service_role', 'workspace', 'usage'), 'service_role lacks USAGE';
    assert not has_schema_privilege('anon', 'workspace', 'create'), 'anon may CREATE';
    assert not has_schema_privilege('authenticated', 'workspace', 'create'), 'authenticated may CREATE';
end;
$$;

-- 2. USAGE opened no table, view or sequence to anon or authenticated.
do $$
declare
    v_open text;
begin
    select string_agg(c.relname, ', ' order by c.relname) into v_open
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'workspace'
      and c.relkind in ('r', 'p', 'v', 'm')
      and (has_table_privilege('anon', c.oid, 'select, insert, update, delete')
        or has_table_privilege('authenticated', c.oid, 'select, insert, update, delete'));
    assert v_open is null, 'anon or authenticated can reach: ' || v_open;

    select string_agg(c.relname, ', ' order by c.relname) into v_open
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'workspace'
      and c.relkind = 'S'
      and (has_sequence_privilege('anon', c.oid, 'usage, select, update')
        or has_sequence_privilege('authenticated', c.oid, 'usage, select, update'));
    assert v_open is null, 'anon or authenticated can use sequence: ' || v_open;
end;
$$;

-- 3. The exact functions each role may run. A new function that forgets
--    `revoke ... from public` shows up here and fails the run.
do $$
declare
    v_anon text[];
    v_auth text[];
begin
    select array_agg(p.proname::text order by p.proname::text) into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'workspace' and has_function_privilege('anon', p.oid, 'execute');

    select array_agg(p.proname::text order by p.proname::text) into v_auth
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'workspace' and has_function_privilege('authenticated', p.oid, 'execute');

    assert v_anon = array['principal_can_embed', 'touch_principal_last_used'],
        'anon may run: ' || coalesce(array_to_string(v_anon, ', '), 'nothing');
    assert v_auth = array['memory_search_authed', 'principal_can_embed', 'touch_principal_last_used'],
        'authenticated may run: ' || coalesce(array_to_string(v_auth, ', '), 'nothing');
end;
$$;

-- 4. The call the embed function makes works as anon: an unknown token is
--    answered "false", not refused.
set local role anon;
do $$
begin
    assert workspace.principal_can_embed('no-such-token-hash') is false;
end;
$$;
reset role;

rollback;
