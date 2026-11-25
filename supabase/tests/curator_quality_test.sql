-- curator_quality_test.sql -- checks for migration 0067 (curator quality).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.

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
        raise exception 'expected SQLSTATE % but got % (%) for: %', p_state, sqlstate, sqlerrm, p_sql;
    end if;
    return true;
end;
$$;

-- A unit vector along one axis (384 dimensions), for embedding checks.
create or replace function pg_temp.axis(p_i integer, p_j integer default null)
returns vector
language sql
as $$
    select (array(select case when g = p_i then 1.0 when g = p_j then 0.25 else 0.0 end
                  from generate_series(1, 384) g))::real[]::vector;
$$;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('cq-ann', 'Ann', 'reader', 'cq-ann@example.com', true, 'sub-cq-ann', 'tok-cq-ann'),
    ('cq-eve', 'Eve', 'reader', 'cq-eve@example.com', true, 'sub-cq-eve', 'tok-cq-eve');

-- Ann's private pages (topics {}), made through the save core.
do $$
declare
    v_ann uuid := (select id from workspace.principals where handle = 'cq-ann');
    v_eve uuid := (select id from workspace.principals where handle = 'cq-eve');
begin
    perform workspace._page_save_as(v_ann, array[]::text[], jsonb_build_object(
        'drawer', 'people', 'key', 'pat@northwind.example', 'title', 'Pat Rivera',
        'fields', jsonb_build_object('organisation', 'northwind.example',
                                     'emails', jsonb_build_array('pat.rivera@gmail.example')),
        'body', E'# Pat Rivera\n\n## Summary\nCOO.\n'), null);
    perform workspace._page_save_as(v_ann, array[]::text[], jsonb_build_object(
        'drawer', 'organisations', 'key', 'northwind.example', 'title', 'Northwind Logistics',
        'fields', jsonb_build_object('domains', jsonb_build_array('northwind-logistics.example')),
        'body', E'# Northwind Logistics\n\n## Summary\nA client.\n'), null);
    perform workspace._page_save_as(v_ann, array[]::text[], jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:route-density', 'title', 'Route Density',
        'aliases', jsonb_build_array('Stops per mile'),
        'description', 'How tightly stops cluster on a route.',
        'body', E'# Route Density\n\n## Summary\nStops per mile.\n\n## How it works\n- Count stops.\n'), null);
    perform workspace._page_save_as(v_ann, array[]::text[], jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:stop-clustering', 'title', 'Stop Clustering',
        'body', E'# Stop Clustering\n\n## Summary\nGrouping stops.\n\n## Related\n- [[concept:route-density]]\n'), null);
    perform workspace._page_save_as(v_ann, array[]::text[], jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:fuel-cards', 'title', 'Fuel Cards',
        'related', jsonb_build_array('concept:stop-clustering'),
        'body', E'# Fuel Cards\n\n## Summary\nCards.\n'), null);
    -- Eve's page with the same name: never matched for Ann.
    perform workspace._page_save_as(v_eve, array[]::text[], jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:route-density', 'title', 'Route Density',
        'body', E'# Route Density\n'), null);
    update workspace.pages set embedding = pg_temp.axis(1) where key = 'concept:route-density';
    update workspace.pages set embedding = pg_temp.axis(1, 2) where key = 'concept:stop-clustering';
    update workspace.pages set embedding = pg_temp.axis(5) where key = 'concept:fuel-cards';
end $$;

-- 1. Settings and privileges ------------------------------------------------
do $$
begin
    assert workspace.curator_consensus_get()->>'strong_model' = 'deepseek-v4.1-flash',
        workspace.curator_consensus_get()::text;
    assert pg_temp.raises($q$update workspace.curator_settings set strong_model = 'tiny-model'$q$, '23514');
    update workspace.curator_settings set strong_model = 'deepseek-v4-pro';
    update workspace.curator_settings set strong_model = 'deepseek-v4.1-flash';
    assert (select relrowsecurity from pg_class where oid = 'workspace.page_duplicates'::regclass);
    assert not has_table_privilege('kb_engine', 'workspace.page_duplicates', 'select');
    assert not has_table_privilege('kb_engine', 'workspace.page_key_redirects', 'select');
    assert has_function_privilege('kb_engine', 'workspace.curator_page_index(uuid, text[], text, vector, integer)', 'execute');
    assert not has_function_privilege('anon', 'workspace.curator_page_index(uuid, text[], text, vector, integer)', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.curator_name_match(uuid, text, text[], vector, integer)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.curator_name_match(uuid, text, text[], vector, integer)', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.curator_duplicates_scan(real, jsonb, boolean)', 'execute');
    assert not has_function_privilege('anon', 'workspace.app_page_merge(text, uuid, uuid, text, text, text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.page_import(text, jsonb)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace._page_names(text, text[], text)', 'execute');
    assert workspace._name_norm('  Pat  RIVERA-Jones! ') = 'pat rivera jones';
end $$;

-- 2. Identities, index and name match (as the service) -----------------------
set local role kb_engine;
do $$
declare
    v_item uuid;
    v_n integer;
begin
    v_item := (workspace.source_item_record('sub-cq-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'cq-1', 'title', 'Route density notes', 'body', 'x'))->>'id')::uuid;

    -- b. a known second address finds the person page; a known domain the organisation.
    assert (select c.key from workspace.curator_candidates(v_item, array['pat.rivera@gmail.example'], '', 8) c
            where c.matched_on = 'identity') = 'pat@northwind.example', 'email identity';
    assert (select c.key from workspace.curator_candidates(v_item, array['northwind-logistics.example'], '', 8) c
            where c.matched_on = 'identity') = 'northwind.example', 'domain identity';

    -- index: key matches first with score 2, then by words and embedding; Ann's pages only.
    assert (select i.key from workspace.curator_page_index(v_item, array['northwind.example'], 'route density',
                                                           pg_temp.axis(1), 60) i limit 1) = 'northwind.example';
    assert (select i.score from workspace.curator_page_index(v_item, array['northwind.example'], '', null, 60) i
            where i.key = 'northwind.example') = 2;
    select count(*) into v_n from workspace.curator_page_index(v_item, array[]::text[], 'route density', pg_temp.axis(1), 60);
    assert v_n = 5, format('all five of Ann''s pages, got %s', v_n);
    assert (select i.key from workspace.curator_page_index(v_item, array[]::text[], '', pg_temp.axis(1), 60) i
            limit 1) = 'concept:route-density', 'closest embedding first';
    assert (select i.identities from workspace.curator_page_index(v_item, array[]::text[], '', null, 60) i
            where i.key = 'pat@northwind.example') = array['pat.rivera@gmail.example'];
    assert (select count(*) from workspace.curator_page_index(v_item, array[]::text[], '', null, 2)) = 2, 'limit';

    -- c. name match: alias, title, slug name; same drawer only; embedding score.
    assert (select m.key from workspace.curator_name_match(v_item, 'concepts', array['stops per mile'], null, 3) m
            where m.how = 'name') = 'concept:route-density', 'alias';
    assert (select m.score from workspace.curator_name_match(v_item, 'concepts', array['ROUTE density'], null, 3) m
            limit 1) = 1, 'title';
    assert not exists (select 1 from workspace.curator_name_match(v_item, 'people', array['Route Density'], null, 3)),
        'drawer';
    assert (select m.key from workspace.curator_name_match(v_item, 'concepts', array['Delivery Hops'],
                                                           pg_temp.axis(1, 2), 3) m limit 1) = 'concept:stop-clustering';
    assert (select m.how from workspace.curator_name_match(v_item, 'concepts', array['Delivery Hops'],
                                                           pg_temp.axis(1, 2), 3) m limit 1) = 'embedding';
    assert not exists (select 1 from workspace.curator_name_match(v_item, 'concepts', array['Nothing Alike'], null, 3)),
        'no match';

    -- d. look-alike scan: similar embeddings above the threshold, once a day unless forced.
    v_n := workspace.curator_duplicates_scan(0.9, '{}'::jsonb, true);
    assert v_n = 1, format('one pair (route density / stop clustering), got %s', v_n);
    assert workspace.curator_duplicates_scan(0.9, '{}'::jsonb, false) = -1, 'not due';
    assert workspace.curator_duplicates_scan(0.99, '{"concepts": 0.5}'::jsonb, true) = 0, 'pair already listed';
end $$;
reset role;

do $$
declare
    v_ann uuid := (select id from workspace.principals where handle = 'cq-ann');
begin
    assert (select count(*) from workspace.page_duplicates) = 1;
    assert (select d.reason from workspace.page_duplicates d) = 'similar';
    assert (select d.owner_principal_id from workspace.page_duplicates d) = v_ann;
    -- shared name across drawers is never a pair; Eve's same-titled page is never paired with Ann's.
    assert not exists (select 1 from workspace.page_duplicates d
                       join workspace.pages p on p.id in (d.page_a, d.page_b)
                       where p.owner_principal_id <> v_ann);
end $$;

-- 3. The owner merges (as the service, for the signed-in person) -------------
set local role kb_engine;
do $$
declare
    v_list jsonb;
    v_pair jsonb;
    v_keep uuid;
    v_hk   text;
    v_hd   text;
    v_out  jsonb;
begin
    assert workspace.app_duplicates_list('cq-eve@example.com') = '[]'::jsonb, 'Eve sees none of Ann''s';
    v_list := workspace.app_duplicates_list('cq-ann@example.com');
    assert jsonb_array_length(v_list) = 1, v_list::text;
    assert workspace.app_duplicate_get('cq-eve@example.com', (v_list->0->>'id')::uuid) is null;
    v_pair := workspace.app_duplicate_get('cq-ann@example.com', (v_list->0->>'id')::uuid);
    assert v_pair->'a'->>'body' is not null;
    v_keep := (select (x->>'id')::uuid from jsonb_array_elements(jsonb_build_array(v_pair->'a', v_pair->'b')) x
               where x->>'key' = 'concept:route-density');
    v_hk := (select x->>'content_hash' from jsonb_array_elements(jsonb_build_array(v_pair->'a', v_pair->'b')) x
             where x->>'key' = 'concept:route-density');
    v_hd := (select x->>'content_hash' from jsonb_array_elements(jsonb_build_array(v_pair->'a', v_pair->'b')) x
             where x->>'key' = 'concept:stop-clustering');

    assert pg_temp.raises(format($q$select workspace.app_page_merge('cq-eve@example.com', %L, %L, 'x', %L, %L)$q$,
                                 v_list->0->>'id', v_keep, v_hk, v_hd), '22023'), 'not Eve''s pair';
    assert pg_temp.raises(format($q$select workspace.app_page_merge('cq-ann@example.com', %L, %L, 'x', 'stale', %L)$q$,
                                 v_list->0->>'id', v_keep, v_hd), '22023'), 'stale hash';
    assert pg_temp.raises(format($q$select workspace.app_page_merge('cq-ann@example.com', %L, %L, 'x', %L, %L)$q$,
                                 v_list->0->>'id', gen_random_uuid(), v_hk, v_hd), '22023'), 'keep not in pair';

    v_out := workspace.app_page_merge('cq-ann@example.com', (v_list->0->>'id')::uuid, v_keep,
        E'# Route Density\n\n## Summary\nStops per mile.\nGrouping stops.\n', v_hk, v_hd);
    assert v_out->>'merged' = 'concept:stop-clustering', v_out::text;
    assert workspace.app_duplicates_list('cq-ann@example.com') = '[]'::jsonb;
end $$;
reset role;

do $$
declare
    v_ann uuid := (select id from workspace.principals where handle = 'cq-ann');
    v_keep workspace.pages%rowtype;
begin
    select * into v_keep from workspace.pages
    where owner_principal_id = v_ann and key = 'concept:route-density' and deleted_at is null;
    assert 'Stop Clustering' = any(v_keep.aliases), v_keep.aliases::text;
    assert 'Stops per mile' = any(v_keep.aliases);
    assert v_keep.body like '%Grouping stops.%';
    assert (select deleted_at is not null from workspace.pages
            where owner_principal_id = v_ann and key = 'concept:stop-clustering'), 'other page deleted';
    assert (select count(*) from workspace.page_history where page_id = v_keep.id) = 2, 'history kept';
    assert (select new_key from workspace.page_key_redirects
            where owner_principal_id = v_ann and old_key = 'concept:stop-clustering') = 'concept:route-density';
    assert (select related from workspace.pages where owner_principal_id = v_ann and key = 'concept:fuel-cards')
           = array['concept:route-density'], 'related redirected';
    assert exists (select 1 from workspace.page_links l join workspace.pages p on p.id = l.page_id
                   where p.key = 'concept:fuel-cards' and p.owner_principal_id = v_ann
                     and l.target_key = 'concept:route-density'), 'links redirected';
    assert (select status from workspace.page_duplicates) = 'merged';
end $$;

-- 4. Merge of a person page keeps the dropped address as an identity ----------
do $$
declare
    v_ann uuid := (select id from workspace.principals where handle = 'cq-ann');
    v_dup uuid;
    v_keep workspace.pages%rowtype;
    v_drop workspace.pages%rowtype;
begin
    perform workspace._page_save_as(v_ann, array[]::text[], jsonb_build_object(
        'drawer', 'people', 'key', 'person:pat-rivera', 'title', 'Pat Rivera',
        'body', E'# Pat Rivera\n\n## Notes\n- Likes maps.\n'), null);
    assert workspace.curator_duplicates_scan(0.9, '{}'::jsonb, true) = 1;
    select * into v_keep from workspace.pages where owner_principal_id = v_ann and key = 'person:pat-rivera';
    select * into v_drop from workspace.pages where owner_principal_id = v_ann and key = 'pat@northwind.example';
    select id into v_dup from workspace.page_duplicates where status = 'open';
    assert (select reason from workspace.page_duplicates where id = v_dup) = 'same name';
    perform workspace.app_page_merge('cq-ann@example.com', v_dup, v_keep.id, E'# Pat Rivera\n',
                                     v_keep.content_hash, v_drop.content_hash);
    select * into v_keep from workspace.pages where id = v_keep.id;
    assert workspace._jsonb_lower_list(v_keep.fields->'emails')
           = array['pat.rivera@gmail.example', 'pat@northwind.example'], v_keep.fields::text;
    assert v_keep.fields->>'organisation' = 'northwind.example';
end $$;

-- 5. Import uses the same matching -------------------------------------------
do $$
declare
    v jsonb;
begin
    v := workspace.page_import('cq-ann@example.com', jsonb_build_object(
        'drawer', 'organisations', 'key', 'org:northwind', 'title', 'Northwind Logistics', 'body', '# N'));
    assert v->>'status' = 'matched' and v->>'key' = 'northwind.example' and v->>'how' = 'name', v::text;
    v := workspace.page_import('cq-ann@example.com', jsonb_build_object(
        'drawer', 'organisations', 'key', 'northwind-logistics.example', 'title', 'NWL', 'body', '# N'));
    assert v->>'status' = 'matched' and v->>'how' = 'email or domain', v::text;
    v := workspace.page_import('cq-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'person:p-rivera', 'title', 'P. Rivera',
        'fields', jsonb_build_object('emails', jsonb_build_array('PAT@northwind.example')), 'body', '# P'));
    assert v->>'status' = 'matched' and v->>'key' = 'person:pat-rivera', v::text;
    v := workspace.page_import('cq-ann@example.com', jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:fuel-cards', 'title', 'Fuel Cards', 'body', '# F'));
    assert v->>'status' = 'exists', v::text;
    v := workspace.page_import('cq-ann@example.com', jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:depot-hours', 'title', 'Depot Hours', 'body', '# D'));
    assert v->>'status' = 'created', v::text;
end $$;

rollback;
