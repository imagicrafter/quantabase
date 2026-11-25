-- source_tags_test.sql -- checks for migration 0060 (topics from source tags).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
-- WHAT IS UNDER TEST
--   * source_tags is closed (RLS, no grants); the app functions are kb_engine only
--   * the free-text topic add is gone from the service (app_topic_add revoked)
--   * record_source_item notes the tags it is handed (switched off), refuses
--     `topics`, and stamps topics ONLY from the owner's switched-on tags
--   * a person lists and switches only their own tags; switching on previews
--     first, then makes (or reuses) the topic and grants it to the owner
--   * switching off stops new items getting the topic
--   * a config apply never removes a topic a source tag uses

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
    ('st-shared', 'Shared', false)
on conflict (domain) do nothing;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('st-ann', 'Ann Owner', 'reader', 'st-ann@example.com', true, 'sub-st-ann', 'tok-st-ann'),
    ('st-eve', 'Eve Peer',  'reader', 'st-eve@example.com', true, 'sub-st-eve', 'tok-st-eve');

insert into workspace.access_grants (principal_id, domain)
select p.id, 'st-shared' from workspace.principals p where p.handle = 'st-eve';

-- 1. Privileges ---------------------------------------------------------------
do $$
begin
    assert (select relrowsecurity from pg_class where oid = 'workspace.source_tags'::regclass), 'source_tags RLS';
    assert not has_table_privilege('kb_engine', 'workspace.source_tags', 'select'), 'kb_engine table';
    assert not has_table_privilege('anon', 'workspace.source_tags', 'select'), 'anon table';
    assert not has_table_privilege('authenticated', 'workspace.source_tags', 'select'), 'authenticated table';
    assert has_function_privilege('kb_engine', 'workspace.app_source_tags_list(text)', 'execute'), 'kb_engine list';
    assert not has_function_privilege('anon', 'workspace.app_source_tags_list(text)', 'execute'), 'anon list';
    assert not has_function_privilege('authenticated', 'workspace.app_source_tags_list(text)', 'execute'), 'authenticated list';
    assert not has_function_privilege('kb_ingest', 'workspace.app_source_tags_list(text)', 'execute'), 'kb_ingest list';
    -- 0063: topics are made by administrators only; the switch is no longer the service's.
    assert not has_function_privilege('kb_engine', 'workspace.app_source_tag_set(text, uuid, boolean, boolean)', 'execute'), 'kb_engine set';
    assert not has_function_privilege('anon', 'workspace.app_source_tag_set(text, uuid, boolean, boolean)', 'execute'), 'anon set';
    assert not has_function_privilege('authenticated', 'workspace.app_source_tag_set(text, uuid, boolean, boolean)', 'execute'), 'authenticated set';
    assert not has_function_privilege('kb_ingest', 'workspace.app_source_tag_set(text, uuid, boolean, boolean)', 'execute'), 'kb_ingest set';
    assert not has_function_privilege('kb_engine', 'workspace._source_tags_note(uuid, text, jsonb)', 'execute'), 'helper hidden';
    assert not has_function_privilege('kb_engine', 'workspace._topic_slug(text, text)', 'execute'), 'slug hidden';
    -- 0063: the administrators' topic add is the service's again (it checks the caller is an administrator).
    assert has_function_privilege('kb_engine', 'workspace.app_topic_add(text, text, text, boolean)', 'execute'), 'admin topic add';
    assert has_function_privilege('kb_engine', 'workspace.source_item_record(text, jsonb)', 'execute'), 'kb_engine record';
end $$;

-- 2. Slugs ----------------------------------------------------------------------
do $$
begin
    assert workspace._topic_slug('Clients/Acme', 'x') = 'clients-acme', workspace._topic_slug('Clients/Acme', 'x');
    assert workspace._topic_slug('  2026 Board!! ', 'x') = 't-2026-board', workspace._topic_slug('  2026 Board!! ', 'x');
    assert workspace._topic_slug('kx/consulting', 'x') = 'kx-consulting';
    assert workspace._topic_slug('Unclassified', 'x') = 'unclassified-tag';
    assert workspace._topic_slug('日本', 'abc') ~ '^tag-[0-9a-f]{8}$';
    assert length(workspace._topic_slug(repeat('a', 90), 'x')) = 40;
end $$;

-- 3. Recording notes tags, switched off; topics are refused -------------------
set local role kb_engine;
do $$
declare
    r jsonb;
    v_item record;
begin
    -- 0063: a claimed topic is ignored (never used), not refused.
    r := workspace.source_item_record('sub-st-ann', '{"source":"drive","source_id":"m0","body":"x","topics":["st-shared"]}'::jsonb);
    select * into v_item from workspace.source_item_get('sub-st-ann', (r->>'id')::uuid);
    assert v_item.topics = '{}'::text[], 'claimed topic ignored';
    assert pg_temp.raises($q$select workspace.source_item_record('sub-st-ann',
        '{"source":"drive","source_id":"m0","body":"x","tags":"Label_1"}'::jsonb)$q$, '22023');
    assert pg_temp.raises($q$select workspace.source_item_record('sub-st-ann',
        '{"source":"drive","source_id":"m0","body":"x","tags":[{"id":"","name":"A","kind":"folder"}]}'::jsonb)$q$, '22023');

    r := workspace.source_item_record('sub-st-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'm1', 'body', 'hello',
        'tags', jsonb_build_array(
            jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme', 'kind', 'folder'),
            jsonb_build_object('id', 'Label_2', 'name', 'St Shared', 'kind', 'folder'))));
    select * into v_item from workspace.source_item_get('sub-st-ann', (r->>'id')::uuid);
    assert v_item.topics = '{}'::text[], 'a tag nobody switched on gives no topic';
    assert v_item.metadata->'source_tags' = '["Label_1", "Label_2"]'::jsonb, v_item.metadata::text;

    -- Seen again: counted, not duplicated; a rename updates the name.
    perform workspace.source_item_record('sub-st-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'm2', 'body', 'again',
        'tags', jsonb_build_array(jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme Inc', 'kind', 'folder'))));

    -- Eve's own label with the same id is hers, not Ann's.
    perform workspace.source_item_record('sub-st-eve', jsonb_build_object(
        'source', 'drive', 'source_id', 'e1', 'body', 'eve',
        'tags', jsonb_build_array(jsonb_build_object('id', 'Label_1', 'name', 'Eve stuff', 'kind', 'folder'))));
end $$;
reset role;

do $$
begin
    assert (select count(*) from workspace.source_tags) = 3, 'three tags noted';
    assert (select seen_count from workspace.source_tags t join workspace.principals p on p.id = t.owner_principal_id
            where p.handle = 'st-ann' and t.tag_id = 'Label_1') = 2, 'seen twice';
    assert (select t.display_name from workspace.source_tags t join workspace.principals p on p.id = t.owner_principal_id
            where p.handle = 'st-ann' and t.tag_id = 'Label_1') = 'Clients/Acme Inc', 'renamed';
    assert not exists (select 1 from workspace.source_tags where enabled), 'all off by default';
end $$;

-- 4. Listing and switching: own tags only, preview first ----------------------
-- (0063: no longer callable by the service; checked as the function owner so
-- the tags already switched on keep working for Drive.)
do $$
declare
    v_list  jsonb;
    v_acme  uuid;
    v_share uuid;
    v_eves  uuid;
    r       jsonb;
begin
    v_list := workspace.app_source_tags_list('st-ann@example.com');
    assert jsonb_array_length(v_list) = 2, v_list::text;
    select (e->>'id')::uuid into v_acme from jsonb_array_elements(v_list) e where e->>'tag_id' = 'Label_1';
    select (e->>'id')::uuid into v_share from jsonb_array_elements(v_list) e where e->>'tag_id' = 'Label_2';
    select (e->>'id')::uuid into v_eves from jsonb_array_elements(workspace.app_source_tags_list('st-eve@example.com')) e;
    assert v_acme is not null and v_share is not null and v_eves is not null;

    assert pg_temp.raises(format($q$select workspace.app_source_tags_list(%L)$q$, 'nobody@example.com'), '42501');
    -- Eve cannot switch Ann's tag.
    assert pg_temp.raises(format($q$select workspace.app_source_tag_set('st-eve@example.com', %L, true, true)$q$, v_acme), '42501');

    -- Preview changes nothing.
    r := workspace.app_source_tag_set('st-ann@example.com', v_acme, true, false);
    assert r->>'status' = 'preview' and r->>'topic' = 'clients-acme-inc' and (r->>'topic_exists')::boolean = false, r::text;
    r := workspace.app_source_tag_set('st-ann@example.com', v_acme, true, false);
    assert (r->>'topic_exists')::boolean = false, 'preview made no topic';

    -- Confirmed: the topic is made, labelled with the tag's name, granted to Ann.
    r := workspace.app_source_tag_set('st-ann@example.com', v_acme, true, true);
    assert r->>'status' = 'on' and r->>'topic' = 'clients-acme-inc', r::text;

    -- A tag whose name is an existing topic reuses it, and says who holds it.
    r := workspace.app_source_tag_set('st-ann@example.com', v_share, true, false);
    assert (r->>'topic_exists')::boolean and (r->>'people')::int = 1, r::text;
end $$;
reset role;

do $$
begin
    assert (select label from workspace.domains where domain = 'clients-acme-inc') = 'Clients/Acme Inc';
    assert not (select sensitive from workspace.domains where domain = 'clients-acme-inc');
    assert exists (select 1 from workspace.access_grants g join workspace.principals p on p.id = g.principal_id
                   where p.handle = 'st-ann' and g.domain = 'clients-acme-inc'), 'owner holds it';
    assert (select count(*) from workspace.access_grants where domain = 'clients-acme-inc') = 1, 'nobody else';
end $$;

-- 5. Stamping uses only the mapping -------------------------------------------
set local role kb_engine;
do $$
declare
    r jsonb;
    v_item record;
    v_acme uuid;
begin
    r := workspace.source_item_record('sub-st-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'm3', 'body', 'new acme mail',
        'tags', jsonb_build_array(
            jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme Inc', 'kind', 'folder'),
            jsonb_build_object('id', 'Label_9', 'name', 'Other', 'kind', 'folder'))));
    select * into v_item from workspace.source_item_get('sub-st-ann', (r->>'id')::uuid);
    assert v_item.topics = array['clients-acme-inc'], v_item.topics::text;

    -- Same tag id from another source is a different tag.
    r := workspace.source_item_record('sub-st-ann', jsonb_build_object(
        'source', 'calendar', 'source_id', 'f1', 'body', 'file',
        'tags', jsonb_build_array(jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme Inc', 'kind', 'event_tag'))));
    select * into v_item from workspace.source_item_get('sub-st-ann', (r->>'id')::uuid);
    assert v_item.topics = '{}'::text[], 'other source, other tag';

    -- Eve's label with the same id stamps nothing for Eve.
    r := workspace.source_item_record('sub-st-eve', jsonb_build_object(
        'source', 'drive', 'source_id', 'e2', 'body', 'eve 2',
        'tags', jsonb_build_array(jsonb_build_object('id', 'Label_1', 'name', 'Eve stuff', 'kind', 'folder'))));
    select * into v_item from workspace.source_item_get('sub-st-eve', (r->>'id')::uuid);
    assert v_item.topics = '{}'::text[], 'Eve''s tag is off';

end $$;
reset role;

do $$
declare
    r jsonb;
    v_acme uuid;
begin
    -- Switched off: new items no longer get the topic.
    select (e->>'id')::uuid into v_acme
    from jsonb_array_elements(workspace.app_source_tags_list('st-ann@example.com')) e where e->>'tag_id' = 'Label_1';
    r := workspace.app_source_tag_set('st-ann@example.com', v_acme, false, true);
    assert r->>'status' = 'off', r::text;
end $$;

set local role kb_engine;
do $$
declare
    r jsonb;
    v_item record;
begin
    r := workspace.source_item_record('sub-st-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'm4', 'body', 'later acme mail',
        'tags', jsonb_build_array(jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme Inc', 'kind', 'folder'))));
    select * into v_item from workspace.source_item_get('sub-st-ann', (r->>'id')::uuid);
    assert v_item.topics = '{}'::text[], 'off means no topic';
end $$;
reset role;

-- 6. A config apply leaves source-tag topics alone ----------------------------
do $$
declare
    v_keep jsonb;
begin
    select coalesce(jsonb_agg(jsonb_build_object('id', d.domain, 'label', d.label, 'sensitive', d.sensitive)), '[]'::jsonb)
    into v_keep
    from workspace.domains d
    where d.domain <> 'unclassified'
      and not exists (select 1 from workspace.source_tags t where t.topic = d.domain);
    perform workspace.domains_apply(v_keep);
    assert exists (select 1 from workspace.domains where domain = 'clients-acme-inc'), 'kept';
end $$;

rollback;
