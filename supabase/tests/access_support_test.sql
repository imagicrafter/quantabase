-- access_support_test.sql -- checks for migrations 0035, 0036 and 0037.
-- Run by apply_local.sh against a throwaway database, as a superuser (it uses
-- `set role` to act as each role). Any failed check raises and stops the run.
-- Everything happens in one transaction that is rolled back.

begin;

create or replace function pg_temp.raises(p_sql text, p_state text default null)
returns boolean
language plpgsql
as $$
begin
    execute p_sql;
    return false;
exception when others then
    if p_state is not null and sqlstate <> p_state then
        raise exception 'expected SQLSTATE % but got % (%) for: %',
            p_state, sqlstate, sqlerrm, p_sql;
    end if;
    return true;
end;
$$;

-- 1. Who may run the two access functions: kb_ingest, and nobody else.
do $$
begin
    assert has_function_privilege('kb_ingest', 'workspace.engine_access_status()', 'execute');
    assert has_function_privilege('kb_ingest', 'workspace.engine_access_adopt(jsonb)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.engine_access_status()', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.engine_access_adopt(jsonb)', 'execute');
    assert not has_function_privilege('anon', 'workspace.engine_access_status()', 'execute');
    assert not has_function_privilege('anon', 'workspace.engine_access_adopt(jsonb)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.engine_access_adopt(jsonb)', 'execute');
    assert not has_function_privilege('kb_support', 'workspace.engine_access_status()', 'execute');
    assert not has_function_privilege('kb_support', 'workspace.engine_access_adopt(jsonb)', 'execute');
end $$;

-- 2. A new database: setup is open, no code, no sign-in settings.
set local role kb_ingest;
do $$
declare
    v jsonb := workspace.engine_access_status();
begin
    assert v->>'setup_state' = 'open';
    assert (v->>'setup_code_set')::boolean = false;
    assert v->'access' = 'null'::jsonb;
    assert not (v ? 'setup_code_hash'), 'the code hash must never be returned';
end $$;

-- 3. A setup code is stored as its hash; status says only that one is set.
select workspace.engine_setup_reopen(encode(sha256(convert_to('a-long-random-setup-code', 'UTF8')), 'hex'));
do $$
declare
    v jsonb := workspace.engine_access_status();
begin
    assert v->>'setup_state' = 'open' and (v->>'setup_code_set')::boolean;
    assert v->>'setup_opened_at' is not null;
    assert position(encode(sha256(convert_to('a-long-random-setup-code', 'UTF8')), 'hex') in v::text) = 0;
end $$;

-- 4. Adopt refuses settings that could not work, and changes nothing.
do $$
begin
    assert pg_temp.raises('select workspace.engine_access_adopt(null)', '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt('[]'::jsonb)$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://team.example.com", "aud": "a", "host": "engine.example.com"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "", "host": "engine.example.com"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "a", "host": "https://engine.example.com"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "a", "status_aud": "a", "host": "engine.example.com"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "a", "host": "engine.example.com", "level": "everyone"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "a", "host": "engine.example.com", "api_token": "x"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": 5, "host": "engine.example.com"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "a", "host": "engine.example.com", "resource_url": "https://elsewhere.example.com/mcp"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "a", "status_aud": " ", "host": "engine.example.com"}')$q$, '22023');
    assert workspace.engine_access_status()->>'setup_state' = 'open';
    assert workspace.engine_access_status()->'access' = 'null'::jsonb;
end $$;

-- 5. Adopt stores the settings, completes setup, erases the code and any lock.
reset role;
update workspace.engine_settings
set setup_failed_at = array[now()], setup_locked_until = now() + interval '1 hour',
    setup_code_ok_at = now();
set local role kb_ingest;
do $$
declare
    v jsonb := workspace.engine_access_adopt(
        '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "aud-mcp",
          "status_aud": "aud-status", "host": "engine.example.com", "level": "people"}');
begin
    assert v->>'setup_state' = 'complete' and not (v->>'setup_code_set')::boolean;
    assert v #>> '{access,host}' = 'engine.example.com';
    assert v #>> '{access,resource_url}' = 'https://engine.example.com/mcp';
    assert v #>> '{access,level}' = 'people';
end $$;
reset role;
do $$
begin
    assert (select setup_code_hash is null and setup_state = 'complete'
                   and setup_failed_at = '{}' and setup_locked_until is null
                   and setup_code_ok_at is null
            from workspace.engine_settings), 'adopt must clear the code and the lockout';
end $$;

-- The service sees the adopted settings through its own function.
set local role kb_engine;
do $$
begin
    assert workspace.engine_settings_public() #>> '{access,aud}' = 'aud-mcp';
    assert workspace.engine_settings_public() ->> 'setup_state' = 'complete';
    assert pg_temp.raises('select workspace.engine_access_status()', '42501');
end $$;
reset role;

-- 6. The support role: the inbox view and the two issue functions, nothing else.
insert into workspace.issues (category, title, detail, source, dedupe_key)
values ('source_failure', 'wiki run failed', 'HTTP 500', 'wiki', 'run-wiki');
insert into workspace.documents (source, external_id, source_hash, title, body, domains)
values ('wiki', 'support-probe', 'x', 'Private title', 'Private body', array['unclassified']);

do $$
declare
    v_can_run text[];
begin
    assert (select not rolcanlogin from pg_roles where rolname = 'kb_support'),
        'kb_support itself must not be able to log in';
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_support') = 1, 'kb_support holds one grant: the view';
    assert has_table_privilege('kb_support', 'workspace.v_support_inbox', 'select');
    assert not has_table_privilege('kb_support', 'workspace.v_support_inbox', 'insert');
    assert not has_table_privilege('kb_support', 'workspace.issues', 'select');
    assert not has_table_privilege('kb_support', 'workspace.documents', 'select');
    assert not has_table_privilege('kb_support', 'workspace.principals', 'select');
    assert not has_table_privilege('kb_support', 'workspace.access_grants', 'select');
    assert not has_table_privilege('kb_support', 'workspace.domains', 'select');
    assert not has_table_privilege('kb_support', 'workspace.engine_settings', 'select');
    assert not has_table_privilege('kb_support', 'workspace.raw_captures', 'select');
    assert not has_table_privilege('kb_support', 'workspace.events', 'select');
    -- Every function it may run, by name: exactly two.
    select array_agg(p.proname::text order by p.proname) into v_can_run
    from pg_proc p
    where p.pronamespace = 'workspace'::regnamespace
      and has_function_privilege('kb_support', p.oid, 'execute');
    if v_can_run is distinct from array['issue_set_card', 'issue_set_status'] then
        raise exception 'kb_support may run issue_set_card and issue_set_status only, but can run: %',
            v_can_run;
    end if;
end $$;

set local role kb_support;
do $$
declare
    v_id uuid;
begin
    select id into v_id from workspace.v_support_inbox where title = 'wiki run failed';
    assert v_id is not null, 'the support role must see the inbox';
    perform workspace.issue_set_card(v_id, 'support-acme-1');
    perform workspace.issue_set_status(v_id, 'in_progress');
    assert (select card_id || '/' || status from workspace.v_support_inbox where id = v_id)
           = 'support-acme-1/in_progress';

    assert pg_temp.raises('select * from workspace.documents', '42501');
    assert pg_temp.raises('select * from workspace.principals', '42501');
    assert pg_temp.raises('select * from workspace.access_grants', '42501');
    assert pg_temp.raises('select * from workspace.engine_settings', '42501');
    assert pg_temp.raises('select * from workspace.issues', '42501');
    assert pg_temp.raises('select workspace.engine_settings_public()', '42501');
    assert pg_temp.raises('select workspace.engine_config_get()', '42501');
    assert pg_temp.raises('select workspace.engine_access_status()', '42501');
    assert pg_temp.raises('select workspace.admin_people_list(''owner@example.com'')', '42501');
    assert pg_temp.raises(
        'update workspace.v_support_inbox set title = ''x''', '42501');
    assert pg_temp.raises(
        'select workspace.issue_upsert(''source_failure'', ''t'')', '42501');
end $$;
reset role;

-- 7. The lock and statistics functions: the pullers keep them, nobody else gets them.
do $$
begin
    assert has_function_privilege('kb_ingest', 'workspace.acquire_connector_lock(text, text, integer)', 'execute');
    assert has_function_privilege('kb_ingest', 'workspace.release_connector_lock(text)', 'execute');
    assert has_function_privilege('kb_ingest', 'workspace.refresh_documents_term_stats()', 'execute');
    assert not has_function_privilege('anon', 'workspace.acquire_connector_lock(text, text, integer)', 'execute');
    assert not has_function_privilege('anon', 'workspace.release_connector_lock(text)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.refresh_documents_term_stats()', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.acquire_connector_lock(text, text, integer)', 'execute');
end $$;
set local role kb_ingest;
do $$
begin
    assert workspace.acquire_connector_lock('wiki', 'access-support-test', 60);
    perform workspace.release_connector_lock('wiki');
end $$;
reset role;
-- Triggers still fire for a role that may not run the trigger function itself.
set local role kb_ingest;
update workspace.documents set title = 'Private title 2' where external_id = 'support-probe';
reset role;

rollback;
