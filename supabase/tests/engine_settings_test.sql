-- engine_settings_test.sql -- checks for migrations 0029 and 0030.
-- Run by apply_local.sh against a throwaway database, as a superuser (it uses
-- `set role` to act as each service role). Any failed check raises
-- and stops the run. Everything happens in one transaction that is rolled back.

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

create temp table cfg (doc jsonb);
grant select on cfg to kb_ingest, kb_engine;
insert into cfg values ('{
  "version": 1,
  "engine": {"id": "acme", "name": "Acme''s Knowledge Base Engine",
             "owner": {"email": "Owner@Example.com", "names": ["Pat Owner"]}},
  "domains": [
    {"id": "consulting", "label": "Consulting"},
    {"id": "properties", "label": "Rental Properties"},
    {"id": "private", "label": "Private", "sensitive": true}
  ]
}'::jsonb);

-- 1. kb_engine holds no table grant, and nobody unexpected can run anything.
do $$
begin
    -- (the temp table above is this test's own; every real schema counts)
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
    assert not has_table_privilege('kb_engine', 'workspace.engine_settings', 'select');
    assert not has_table_privilege('kb_ingest', 'workspace.engine_settings', 'select');
    assert not has_table_privilege('anon', 'workspace.engine_settings', 'select');
    assert not has_function_privilege('anon', 'workspace.engine_settings_public()', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.engine_settings_public()', 'execute');
    assert not has_function_privilege('anon', 'workspace.engine_setup_complete(text, jsonb)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.engine_config_apply(jsonb, text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.engine_config_get()', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.engine_setup_reopen(text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.domains_apply(jsonb)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.domains_apply(jsonb)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.engine_setup_complete(text, jsonb)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.engine_settings_public()', 'execute');
end $$;

-- 2. A fresh database has no owner-specific rows.
do $$
begin
    assert (select count(*) from workspace.principals where email is not null) = 0,
        'no person may be seeded by a migration';
    assert (select array_agg(domain order by domain) from workspace.domains)
           = array['unclassified'], 'only unclassified may be seeded';
    assert (select setup_state from workspace.engine_settings) = 'open';
end $$;

-- 3. The pullers' role applies a config: owner, topics, unclassified.
set local role kb_ingest;
select workspace.engine_config_apply((select doc from cfg), 'hash-1');
do $$
begin
    assert workspace.engine_config_get() #>> '{engine,id}' = 'acme';
    assert pg_temp.raises('select * from workspace.engine_settings', '42501'),
        'kb_ingest must not read the settings table';
end $$;
reset role;

do $$
declare
    v_owner workspace.principals%rowtype;
begin
    select * into v_owner from workspace.principals where email = 'owner@example.com';
    assert found and v_owner.role = 'administrator' and v_owner.active,
        'owner must be an active administrator';
    assert v_owner.handle = 'owner' and v_owner.display_name = 'Pat Owner';
    assert (select array_agg(domain order by domain) from workspace.domains)
           = array['consulting', 'private', 'properties', 'unclassified'];
    assert (select sensitive from workspace.domains where domain = 'private');
    assert (select sensitive from workspace.domains where domain = 'unclassified');
    assert (select array_agg(principal_id) from workspace.access_grants
            where domain = 'unclassified') = array[v_owner.id],
        'unclassified must be granted to the owner only';
    assert (select config_hash from workspace.engine_settings) = 'hash-1';
end $$;

-- 4. Re-applying is harmless; a grant on unclassified to anyone else is removed.
insert into workspace.principals (handle, display_name, role, email)
values ('reader', 'A Reader', 'reader', 'reader@example.com');
insert into workspace.access_grants (principal_id, domain)
select id, d from workspace.principals, unnest(array['unclassified', 'properties']) d
where handle = 'reader';
set local role kb_ingest;
select workspace.engine_config_apply((select doc from cfg), 'hash-2');
reset role;
do $$
begin
    assert (select count(*) from workspace.access_grants where domain = 'unclassified') = 1;
    assert (select count(*) from workspace.principals where role = 'administrator') = 1;
end $$;

-- 5. A config cannot hand the Engine to a new owner, or declare unclassified.
set local role kb_ingest;
do $$
declare
    v_doc jsonb := (select doc from cfg);
begin
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{engine,owner,email}', '"reader@example.com"'), 'h'), '42501'),
        'an existing reader must not be promoted by a config';
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{engine,owner,email}', '"stranger@example.com"'), 'h'), '42501'),
        'a new owner must not be created by a config';
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{domains}', '[{"id": "unclassified", "label": "Mine"}]'), 'h'), '22023');
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)', v_doc - 'version', 'h'), '22023');
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        v_doc #- '{engine,owner,email}', 'h'), '22023');
end $$;
reset role;
do $$
begin
    assert (select config_hash from workspace.engine_settings) = 'hash-2',
        'a refused config must leave the last good one in force';
    assert (select count(*) from workspace.principals where role = 'administrator') = 1;
end $$;

-- 6. A topic in use cannot be removed; an unused one can.
insert into workspace.documents (source, external_id, source_hash, title, body, domains)
values ('wiki', 'test/consulting-page', 'x', 'T', 'B', array['consulting']);
set local role kb_ingest;
do $$
declare
    v_doc jsonb := (select doc from cfg);
begin
    -- drops consulting (has a document)
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{domains}', (v_doc->'domains') - 0), 'h'), '23503');
    -- drops properties (granted to the reader)
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{domains}', (v_doc->'domains') - 1), 'h'), '23503');
    -- drops private (unused) and relabels consulting
    perform workspace.engine_config_apply(
        jsonb_set(v_doc, '{domains}',
            '[{"id": "consulting", "label": "Advice"}, {"id": "properties", "label": "Rental Properties"}]'),
        'hash-3');
end $$;
reset role;
do $$
begin
    assert (select array_agg(domain order by domain) from workspace.domains)
           = array['consulting', 'properties', 'unclassified'];
    assert (select label from workspace.domains where domain = 'consulting') = 'Advice';
end $$;

-- 6b. A config may lock a topic but never unlock one.
set local role kb_ingest;
do $$
declare
    v_doc    jsonb := (select doc from cfg);
    v_locked jsonb := '[{"id": "consulting", "label": "Advice", "sensitive": true},
                        {"id": "properties", "label": "Rental Properties"}]';
    v_open   jsonb := '[{"id": "consulting", "label": "Advice"},
                        {"id": "properties", "label": "Rental Properties"}]';
begin
    perform workspace.engine_config_apply(jsonb_set(v_doc, '{domains}', v_locked), 'hash-4');
    -- leaving `sensitive` out, or setting it false, must not unlock the topic
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{domains}', v_open), 'h'), '42501');
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{domains}', jsonb_set(v_locked, '{0,sensitive}', 'false')), 'h'), '42501');
end $$;
reset role;
do $$
begin
    assert (select sensitive from workspace.domains where domain = 'consulting'),
        'a refused config must leave the topic locked';
    assert (select config_hash from workspace.engine_settings) = 'hash-4';
end $$;

-- 6c. An administrator with no email still counts: no second one is created.
update workspace.principals set active = false where email = 'owner@example.com';
insert into workspace.principals (handle, display_name, role)
values ('token-admin', 'Token-only admin', 'administrator');
set local role kb_ingest;
do $$
declare
    v_doc jsonb := (select doc from cfg);
begin
    assert pg_temp.raises(format(
        'select workspace.engine_config_apply(%L::jsonb, %L)',
        jsonb_set(v_doc, '{engine,owner,email}', '"stranger@example.com"'), 'h'), '42501');
end $$;
reset role;
delete from workspace.principals where handle = 'token-admin';
update workspace.principals set active = true where email = 'owner@example.com';

-- 7. The setup window: the service never sees the hash; a wrong code changes nothing.
set local role kb_ingest;
do $$
begin
    assert pg_temp.raises($q$select workspace.engine_setup_reopen('not-a-hash')$q$, '22023');
    perform workspace.engine_setup_reopen(encode(sha256(convert_to('correct horse', 'UTF8')), 'hex'));
end $$;
reset role;

set local role kb_engine;
do $$
declare
    v_public jsonb := workspace.engine_settings_public();
    v_access jsonb := '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "aud-1", "host": "engine.example.com"}';
begin
    assert v_public ? 'config' and v_public ? 'access' and v_public ? 'setup_state';
    assert not v_public ? 'setup_code_hash', 'the code hash must never be returned';
    assert v_public::text not like '%' || encode(sha256(convert_to('correct horse', 'UTF8')), 'hex') || '%';
    assert v_public->>'setup_state' = 'open';
    assert pg_temp.raises('select setup_code_hash from workspace.engine_settings', '42501'),
        'kb_engine must not read setup_code_hash';
    assert pg_temp.raises('select * from workspace.engine_settings', '42501');
    assert pg_temp.raises('update workspace.engine_settings set setup_state = ''complete''', '42501');

    assert workspace.engine_setup_complete('wrong code', v_access) is false;
    assert workspace.engine_setup_complete('', v_access) is false;
    assert workspace.engine_setup_complete(null, v_access) is false;
    assert workspace.engine_settings_public()->>'setup_state' = 'open',
        'a wrong code must leave the window open';
    assert workspace.engine_settings_public()->'access' = 'null'::jsonb,
        'a wrong code must not store access settings';

    -- The right code with unusable settings: refused, and the code is not spent.
    assert pg_temp.raises(
        $q$select workspace.engine_setup_complete('correct horse', '{"aud": "only"}')$q$, '22023');
    assert pg_temp.raises(format(
        'select workspace.engine_setup_complete(%L, %L::jsonb)', 'correct horse',
        v_access || '{"team_domain": "https://keys.attacker.example"}'), '22023');
    assert pg_temp.raises(format(
        'select workspace.engine_setup_complete(%L, %L::jsonb)', 'correct horse',
        v_access || '{"team_domain": "http://acme.cloudflareaccess.com"}'), '22023');
    assert pg_temp.raises(format(
        'select workspace.engine_setup_complete(%L, %L::jsonb)', 'correct horse',
        v_access || '{"host": "https://engine.example.com/path"}'), '22023');
    assert workspace.engine_settings_public()->>'setup_state' = 'open';
    assert workspace.engine_settings_public()->'access' = 'null'::jsonb;

    assert workspace.engine_setup_complete('correct horse', v_access) is true;
    assert workspace.engine_settings_public()->>'setup_state' = 'complete';
    assert workspace.engine_settings_public() #>> '{access,aud}' = 'aud-1';
    assert workspace.engine_setup_complete('correct horse', v_access) is false,
        'the code works once';
end $$;
reset role;

do $$
begin
    assert (select setup_code_hash from workspace.engine_settings) is null,
        'a spent code hash is erased';
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0;
end $$;

rollback;
