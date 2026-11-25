-- engine_status_v3_test.sql -- checks for migration 0041.
-- Run by apply_local.sh against a throwaway database, as a superuser. Any
-- failed check raises and stops the run. One transaction, rolled back.

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

insert into workspace.domains (domain, label, sensitive) values
    ('consulting', 'Consulting', false)
on conflict (domain) do nothing;

insert into workspace.principals (handle, display_name, role, email, active) values
    ('olive', 'Olive Owner', 'administrator', 'olive@example.com', true),
    ('adam', 'Adam Admin', 'administrator', 'adam@example.com', true),
    ('rita', 'Rita Reader', 'reader', 'rita@example.com', true),
    ('old', 'Old Admin', 'administrator', 'old@example.com', false);

-- 1. Privileges: one public function, four internal ones.
do $$
declare
    v_fn text;
begin
    assert has_function_privilege('kb_engine', 'workspace.engine_status(text)', 'execute');
    assert not has_function_privilege('anon', 'workspace.engine_status(text)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.engine_status(text)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.engine_status(text)', 'execute');
    foreach v_fn in array array['_status_tagging', '_status_issues', '_status_setup', '_status_config']
    loop
        assert not has_function_privilege('kb_engine', format('workspace.%I()', v_fn), 'execute'), v_fn;
        assert not has_function_privilege('kb_ingest', format('workspace.%I()', v_fn), 'execute'), v_fn;
        assert not has_function_privilege('anon', format('workspace.%I()', v_fn), 'execute'), v_fn;
        assert not has_function_privilege('authenticated', format('workspace.%I()', v_fn), 'execute'), v_fn;
    end loop;
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
end $$;

-- 2. An empty Engine: every new key is present and empty, old keys intact.
set local role kb_engine;
do $$
declare
    v jsonb := workspace.engine_status('Olive@Example.com');
begin
    assert v ?& array['generated_at', 'connectors', 'review_undecided', 'people', 'snapshot',
                      'documents', 'runs_daily', 'review_waiting', 'areas', 'recent'], v::text;
    assert v ?& array['tagging', 'issues', 'setup', 'config'], v::text;
    assert v->'tagging' = '[]'::jsonb;
    assert v #> '{issues,open}' = '[]'::jsonb;
    assert (v #>> '{issues,fixed_last_30_days}')::int = 0;
    assert (v #>> '{issues,care_plan_enabled}')::boolean = false;
    assert v #>> '{setup,setup_state}' = 'open';
    assert v #> '{setup,level}' = 'null'::jsonb and v #> '{setup,host}' = 'null'::jsonb;
    assert v #> '{setup,locked_until}' = 'null'::jsonb;
    assert v #> '{config,applied_at}' = 'null'::jsonb;
    assert (v #>> '{config,rejected}')::boolean = false;

    assert pg_temp.raises($q$select workspace.engine_status('rita@example.com')$q$, '42501');
    assert pg_temp.raises($q$select workspace.engine_status('old@example.com')$q$, '42501');
    assert pg_temp.raises($q$select workspace.engine_status('nobody@example.com')$q$, '42501');
    assert pg_temp.raises($q$select workspace.engine_status(null)$q$, '42501');
    assert pg_temp.raises('select workspace._status_setup()', '42501');
    assert pg_temp.raises('select workspace._status_issues()', '42501');
end $$;
reset role;

-- 3. Fill it in.
insert into workspace.documents
    (source, external_id, source_hash, title, body, domains, tag_source, tag_signals,
     parent_external_id, deleted_at, owner_principal_id)
values
    ('wiki', 'a.md', 'h', 'A', 'b', '{consulting}', 'content', '{consulting}', null, null, null),
    ('wiki', 'a.md#00-x', 'h', 'A x', 'b', '{consulting}', 'content', '{consulting}', 'a.md', null, null),
    ('wiki', 'b.md', 'h', 'B', 'b', '{unclassified}', 'default', '{}', null, null, null),
    ('wiki', 'c.md', 'h', 'C', 'b', '{unclassified}', 'content',
        '{unknown_tag,unknown_tag:privte}', null, null, null),
    ('wiki', 'gone.md', 'h', 'Gone', 'b', '{unclassified}', 'default', '{}', null, now(), null),
    ('drive', 'f1', 'h', 'F1', 'b', '{consulting}', 'container', '{consulting}', null, null, null),
    ('drive', 'f2', 'h', 'F2', 'b', '{consulting}', 'source_default', '{}', null, null, null),
    ('drive', 'f3', 'h', 'F3', 'b', '{unclassified}', null, null, null, null, null),
    ('gmail', 't1', 'h', 'Olive thread', 'b', '{consulting}', 'content', '{consulting}', null, null,
        (select id from workspace.principals where handle = 'olive')),
    ('gmail', 't2', 'h', 'Legacy thread', 'b', '{consulting}', null, null, null, null, null);

insert into workspace.review_batches (id, recipient, reply_token)
values ('00000000-0000-0000-0000-0000000000b1', 'terminal', 'test-token');
insert into workspace.review_items (batch_id, item_number, document_id)
select '00000000-0000-0000-0000-0000000000b1', row_number() over (order by d.external_id), d.id
from workspace.documents d
where d.external_id in ('a.md', 't1', 't2');

select workspace.issue_upsert('source_failure', 'Drive run failed', 'timeout', 'drive',
                              'TimeoutError', 'run-drive');
select workspace.issue_upsert('source_failure', 'Drive run failed', 'timeout', 'drive',
                              'TimeoutError', 'run-drive');
select workspace.issue_upsert('unknown_tag', 'Old tag problem', null, 'wiki', null, 'tag-old');
select workspace.issue_close_by_key('tag-old', 'fixed');

update workspace.engine_settings
set setup_state = 'complete',
    setup_code_hash = repeat('ab', 32),
    setup_failed_at = array[now()],
    access = jsonb_build_object(
        'team_domain', 'https://acme.cloudflareaccess.com', 'aud', 'aud-mcp',
        'status_aud', 'aud-status', 'host', 'engine.example.com', 'level', 'people'),
    config_applied_at = '2026-11-01T00:00:00Z'
where id;

set local role kb_engine;
do $$
declare
    v jsonb := workspace.engine_status('olive@example.com');
    v_adam jsonb := workspace.engine_status('adam@example.com');
    v_wiki jsonb;
    v_drive jsonb;
    v_issue jsonb;
begin
    -- Tagging: whole, live documents only, per source.
    select t into v_wiki from jsonb_array_elements(v->'tagging') t where t->>'source' = 'wiki';
    select t into v_drive from jsonb_array_elements(v->'tagging') t where t->>'source' = 'drive';
    assert (v_wiki->>'total')::int = 3, v_wiki::text;
    assert (v_wiki #>> '{by_tag_source,content}')::int = 2;
    assert (v_wiki #>> '{by_tag_source,default}')::int = 1;
    assert (v_wiki->>'untagged')::int = 1 and (v_wiki->>'unknown_tag')::int = 1;
    assert (v_drive #>> '{by_tag_source,container}')::int = 1;
    assert (v_drive #>> '{by_tag_source,source_default}')::int = 1;
    assert (v_drive #>> '{by_tag_source,not_recorded}')::int = 1;
    assert (v_drive->>'unknown_tag')::int = 0;

    -- Issues: the open one, counted twice; the closed one counted as fixed.
    assert jsonb_array_length(v #> '{issues,open}') = 1, (v->'issues')::text;
    v_issue := v #> '{issues,open,0}';
    assert v_issue->>'category' = 'source_failure' and v_issue->>'source' = 'drive';
    assert v_issue->>'title' = 'Drive run failed' and v_issue->>'status' = 'open';
    assert (v_issue->>'occurrences')::int = 2 and (v_issue->>'has_card')::boolean = false;
    assert v_issue ? 'opened_at';
    assert not (v_issue ? 'id') and not (v_issue ? 'detail') and not (v_issue ? 'reported_by');
    assert (v #>> '{issues,fixed_last_30_days}')::int = 1;
    assert (v #>> '{issues,care_plan_enabled}')::boolean = false;

    -- Setup and config: the plain facts and nothing secret.
    assert v #>> '{setup,setup_state}' = 'complete';
    assert v #>> '{setup,level}' = 'people' and v #>> '{setup,host}' = 'engine.example.com';
    assert v #> '{setup,locked_until}' = 'null'::jsonb;
    assert (select array_agg(k order by k) from jsonb_object_keys(v->'setup') k)
        = array['host', 'level', 'locked_until', 'setup_state'];
    assert v::text not like '%' || repeat('ab', 32) || '%', 'the setup code hash leaked';
    assert v::text not like '%setup_code_hash%' and v::text not like '%setup_failed_at%';
    assert v::text not like '%aud-mcp%' and v::text not like '%aud-status%';
    assert (v #>> '{config,applied_at}')::timestamptz = '2026-11-01T00:00:00Z';
    assert (v #>> '{config,rejected}')::boolean = false;

    -- Waiting list: the owner sees her own thread; the other administrator
    -- does not; nobody sees the thread that has no owner.
    assert (select array_agg(w->>'title' order by w->>'title')
            from jsonb_array_elements(v->'review_waiting') w) = array['A', 'Olive thread'],
        (v->'review_waiting')::text;
    assert (select array_agg(w->>'title' order by w->>'title')
            from jsonb_array_elements(v_adam->'review_waiting') w) = array['A'],
        (v_adam->'review_waiting')::text;
end $$;
reset role;

-- 4. The facts that flip: a rejected config, a locked setup, a support login.
select workspace.issue_upsert('config_invalid', 'Config was rejected', null, 'wiki', null, 'config');
update workspace.engine_settings set setup_locked_until = now() + interval '30 minutes' where id;
create role kb_support_test_login login in role kb_support;

set local role kb_engine;
do $$
declare
    v jsonb := workspace.engine_status('olive@example.com');
begin
    assert (v #>> '{config,rejected}')::boolean = true;
    assert (v #>> '{setup,locked_until}')::timestamptz > now();
    assert (v #>> '{issues,care_plan_enabled}')::boolean = true;
    assert jsonb_array_length(v #> '{issues,open}') = 2;
end $$;
reset role;

-- A lock that has run out is not reported.
update workspace.engine_settings set setup_locked_until = now() - interval '1 minute' where id;
set local role kb_engine;
do $$
begin
    assert workspace.engine_status('olive@example.com') #> '{setup,locked_until}' = 'null'::jsonb;
end $$;
reset role;

rollback;
