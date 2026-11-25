-- knowledge_ui_test.sql -- checks for migration 0058 (Knowledge and Indexing screens).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * every new function is kb_engine only
--   * the tree counts by drawer, lists recent and pinned; own pages only
--   * a drawer list is paged, sorted, searched and filtered by topic, with a total
--   * pins: own pages only
--   * page view and links: own pages only; backlinks found
--   * indexing, reindex and rerun: administrators only

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

insert into workspace.domains (domain, label, sensitive) values
    ('ku-clients', 'Clients', false), ('ku-team', 'Team', false)
on conflict (domain) do nothing;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('ku-boss', 'Boss', 'administrator', 'ku-boss@example.com', true, 'sub-ku-boss', 'tok-ku-boss'),
    ('ku-ann',  'Ann',  'reader',        'ku-ann@example.com',  true, 'sub-ku-ann',  'tok-ku-ann'),
    ('ku-eve',  'Eve',  'reviewer',      'ku-eve@example.com',  true, 'sub-ku-eve',  'tok-ku-eve');

insert into workspace.access_grants (principal_id, domain)
select p.id, d from workspace.principals p, unnest(array['ku-clients', 'ku-team']) d
where p.handle in ('ku-ann', 'ku-eve');

do $$
begin
    assert has_function_privilege('kb_engine', 'workspace.app_page_pin(text, uuid, boolean)', 'execute'), 'kb_engine workspace.app_page_pin';
    assert not has_function_privilege('anon', 'workspace.app_page_pin(text, uuid, boolean)', 'execute'), 'anon workspace.app_page_pin';
    assert not has_function_privilege('authenticated', 'workspace.app_page_pin(text, uuid, boolean)', 'execute'), 'authenticated workspace.app_page_pin';
    assert not has_function_privilege('kb_ingest', 'workspace.app_page_pin(text, uuid, boolean)', 'execute'), 'kb_ingest workspace.app_page_pin';
    assert has_function_privilege('kb_engine', 'workspace.app_knowledge_tree(text)', 'execute'), 'kb_engine workspace.app_knowledge_tree';
    assert not has_function_privilege('anon', 'workspace.app_knowledge_tree(text)', 'execute'), 'anon workspace.app_knowledge_tree';
    assert not has_function_privilege('authenticated', 'workspace.app_knowledge_tree(text)', 'execute'), 'authenticated workspace.app_knowledge_tree';
    assert not has_function_privilege('kb_ingest', 'workspace.app_knowledge_tree(text)', 'execute'), 'kb_ingest workspace.app_knowledge_tree';
    assert has_function_privilege('kb_engine', 'workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer)', 'execute'), 'kb_engine workspace.app_drawer_pages';
    assert not has_function_privilege('anon', 'workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer)', 'execute'), 'anon workspace.app_drawer_pages';
    assert not has_function_privilege('authenticated', 'workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer)', 'execute'), 'authenticated workspace.app_drawer_pages';
    assert not has_function_privilege('kb_ingest', 'workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer)', 'execute'), 'kb_ingest workspace.app_drawer_pages';
    assert has_function_privilege('kb_engine', 'workspace.app_page_view(text, uuid)', 'execute'), 'kb_engine workspace.app_page_view';
    assert not has_function_privilege('anon', 'workspace.app_page_view(text, uuid)', 'execute'), 'anon workspace.app_page_view';
    assert not has_function_privilege('authenticated', 'workspace.app_page_view(text, uuid)', 'execute'), 'authenticated workspace.app_page_view';
    assert not has_function_privilege('kb_ingest', 'workspace.app_page_view(text, uuid)', 'execute'), 'kb_ingest workspace.app_page_view';
    assert has_function_privilege('kb_engine', 'workspace.app_page_links(text, uuid)', 'execute'), 'kb_engine workspace.app_page_links';
    assert not has_function_privilege('anon', 'workspace.app_page_links(text, uuid)', 'execute'), 'anon workspace.app_page_links';
    assert not has_function_privilege('authenticated', 'workspace.app_page_links(text, uuid)', 'execute'), 'authenticated workspace.app_page_links';
    assert not has_function_privilege('kb_ingest', 'workspace.app_page_links(text, uuid)', 'execute'), 'kb_ingest workspace.app_page_links';
    assert has_function_privilege('kb_engine', 'workspace.app_page_mark_reviewed(text, uuid)', 'execute'), 'kb_engine workspace.app_page_mark_reviewed';
    assert not has_function_privilege('anon', 'workspace.app_page_mark_reviewed(text, uuid)', 'execute'), 'anon workspace.app_page_mark_reviewed';
    assert not has_function_privilege('authenticated', 'workspace.app_page_mark_reviewed(text, uuid)', 'execute'), 'authenticated workspace.app_page_mark_reviewed';
    assert not has_function_privilege('kb_ingest', 'workspace.app_page_mark_reviewed(text, uuid)', 'execute'), 'kb_ingest workspace.app_page_mark_reviewed';
    assert has_function_privilege('kb_engine', 'workspace.app_indexing(text)', 'execute'), 'kb_engine workspace.app_indexing';
    assert not has_function_privilege('anon', 'workspace.app_indexing(text)', 'execute'), 'anon workspace.app_indexing';
    assert not has_function_privilege('authenticated', 'workspace.app_indexing(text)', 'execute'), 'authenticated workspace.app_indexing';
    assert not has_function_privilege('kb_ingest', 'workspace.app_indexing(text)', 'execute'), 'kb_ingest workspace.app_indexing';
    assert has_function_privilege('kb_engine', 'workspace.app_page_reindex(text, uuid)', 'execute'), 'kb_engine workspace.app_page_reindex';
    assert not has_function_privilege('anon', 'workspace.app_page_reindex(text, uuid)', 'execute'), 'anon workspace.app_page_reindex';
    assert not has_function_privilege('authenticated', 'workspace.app_page_reindex(text, uuid)', 'execute'), 'authenticated workspace.app_page_reindex';
    assert not has_function_privilege('kb_ingest', 'workspace.app_page_reindex(text, uuid)', 'execute'), 'kb_ingest workspace.app_page_reindex';
    assert has_function_privilege('kb_engine', 'workspace.app_summaries_rerun(text)', 'execute'), 'kb_engine workspace.app_summaries_rerun';
    assert not has_function_privilege('anon', 'workspace.app_summaries_rerun(text)', 'execute'), 'anon workspace.app_summaries_rerun';
    assert not has_function_privilege('authenticated', 'workspace.app_summaries_rerun(text)', 'execute'), 'authenticated workspace.app_summaries_rerun';
    assert not has_function_privilege('kb_ingest', 'workspace.app_summaries_rerun(text)', 'execute'), 'kb_ingest workspace.app_summaries_rerun';
    assert not has_table_privilege('kb_engine', 'workspace.page_pins', 'select'), 'no table grant';
end;
$$;

do $$
declare
    v jsonb;
    i integer;
    v_org uuid;
    v_pat uuid;
begin
    -- 30 people pages and one organisation for Ann; one page for Eve.
    for i in 1..30 loop
        perform * from workspace.app_page_save('ku-ann@example.com', jsonb_build_object(
            'drawer', 'people', 'key', format('p%s@acme-ku.com', lpad(i::text, 2, '0')),
            'title', format('Person %s', lpad(i::text, 2, '0')),
            'topics', case when i % 2 = 0 then jsonb_build_array('ku-team') else jsonb_build_array('ku-clients') end,
            'related', jsonb_build_array('acme-ku.com'),
            'body', 'Works on the harbour project.'), null);
    end loop;
    select id into v_org from workspace.app_page_save('ku-ann@example.com', jsonb_build_object(
        'drawer', 'organisations', 'key', 'acme-ku.com', 'title', 'Acme KU',
        'topics', jsonb_build_array('ku-clients'), 'related', jsonb_build_array('p01@acme-ku.com', 'ghost:none'),
        'body', 'A client.'), null);
    perform * from workspace.app_page_save('ku-eve@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'eve-only@acme-ku.com', 'title', 'Eve only',
        'topics', jsonb_build_array('ku-team'), 'body', 'x'), null);

    -- whoami: roles and owner flag
    assert workspace.app_whoami('ku-eve@example.com')->>'role' = 'reviewer', 'role reviewer';
    assert (workspace.app_whoami('ku-ann@example.com')->>'is_owner')::boolean is false, 'ann not owner';

    -- tree
    v := workspace.app_knowledge_tree('ku-ann@example.com');
    assert (v->'counts'->>'people')::int = 30, 'people count';
    assert (v->'counts'->>'organisations')::int = 1, 'org count';
    assert jsonb_array_length(v->'recent') = 8, 'recent capped at 8';
    assert jsonb_array_length(v->'pinned') = 0, 'nothing pinned';
    assert (workspace.app_knowledge_tree('ku-eve@example.com')->'counts'->>'people')::int = 1, 'eve sees her own count';
    assert pg_temp.raises($q$select workspace.app_knowledge_tree('nobody@example.com')$q$, '42501');

    -- paging and sorting
    v := workspace.app_drawer_pages('ku-ann@example.com', 'people', null, null, 'title', false, 0, 10);
    assert (v->>'total')::int = 30, 'total 30';
    assert jsonb_array_length(v->'rows') = 10, 'page of 10';
    assert v->'rows'->0->>'title' = 'Person 01', 'title asc first';
    v := workspace.app_drawer_pages('ku-ann@example.com', 'people', null, null, 'title', true, 10, 10);
    assert v->'rows'->0->>'title' = 'Person 20', 'title desc, second page';
    -- topic filter and chips
    v := workspace.app_drawer_pages('ku-ann@example.com', 'people', null, 'ku-team', 'updated', true, 0, 50);
    assert (v->>'total')::int = 15, 'topic filter';
    assert v->'topics' = '["ku-clients", "ku-team"]'::jsonb, 'topic chips';
    -- search: key match and full text
    assert (workspace.app_drawer_pages('ku-ann@example.com', 'people', 'p07@', null)->>'total')::int = 1, 'key search';
    assert (workspace.app_drawer_pages('ku-ann@example.com', 'people', 'harbour', null)->>'total')::int = 30, 'text search';
    assert (workspace.app_drawer_pages('ku-eve@example.com', 'people', 'person', null)->>'total')::int = 0, 'eve sees none of ann''s';
    assert pg_temp.raises($q$select workspace.app_drawer_pages('ku-ann@example.com', 'Bad Drawer')$q$, '22023');
    -- the limit is capped
    assert (workspace.app_drawer_pages('ku-ann@example.com', 'people', null, null, 'updated', true, 0, 100000)->>'limit')::int = 200, 'limit cap';

    -- pins
    select (r->>'id')::uuid into v_pat
    from jsonb_array_elements(workspace.app_drawer_pages('ku-ann@example.com', 'people', 'p01@', null)->'rows') r;
    assert workspace.app_page_pin('ku-ann@example.com', v_pat, true), 'pin';
    assert not workspace.app_page_pin('ku-eve@example.com', v_pat, true), 'eve cannot pin ann''s';
    assert jsonb_array_length(workspace.app_knowledge_tree('ku-ann@example.com')->'pinned') = 1, 'pinned listed';
    assert (workspace.app_page_view('ku-ann@example.com', v_pat)->>'pinned')::boolean, 'view says pinned';
    assert workspace.app_page_pin('ku-ann@example.com', v_pat, false), 'unpin';
    assert jsonb_array_length(workspace.app_knowledge_tree('ku-ann@example.com')->'pinned') = 0, 'unpinned';

    -- view and links
    v := workspace.app_page_view('ku-ann@example.com', v_org);
    assert v->>'owner' = 'ku-ann@example.com' and v ? 'created_at', 'view fields';
    assert workspace.app_page_view('ku-eve@example.com', v_org) is null, 'eve cannot view';
    v := workspace.app_page_links('ku-ann@example.com', v_org);
    assert jsonb_array_length(v->'in') = 30, 'backlinks from 30 people';
    assert exists (select 1 from jsonb_array_elements(v->'out') o
                   where o->>'key' = 'ghost:none' and o->'id' = 'null'::jsonb), 'missing target kept, no id';
    assert exists (select 1 from jsonb_array_elements(v->'out') o
                   where o->>'key' = 'p01@acme-ku.com' and o->>'id' = v_pat::text), 'out link resolved';
    assert workspace.app_page_links('ku-eve@example.com', v_org) is null, 'eve gets no links';

    assert not workspace.app_page_mark_reviewed('ku-eve@example.com', v_org), 'eve cannot mark ann''s';
    assert workspace.app_page_mark_reviewed('ku-ann@example.com', v_org), 'mark reviewed';
    assert (select reviewed is not null and status = 'current' from workspace.pages where id = v_org), 'reviewed set';

    -- indexing: administrators only
    assert pg_temp.raises($q$select workspace.app_indexing('ku-ann@example.com')$q$, '42501');
    assert pg_temp.raises($q$select workspace.app_summaries_rerun('ku-ann@example.com')$q$, '42501');
    v := workspace.app_indexing('ku-boss@example.com');
    assert (v->>'pages')::int >= 32, 'page total';
    assert (v->>'summaries_pending')::int >= 32, 'every new page waits for a summary';
    assert v ? 'last_run' and v ? 'curator' and v ? 'backup', 'indexing keys';
    update workspace.pages set summary_queued_at = null where id = v_org;
    assert pg_temp.raises(format($q$select workspace.app_page_reindex('ku-ann@example.com', %L)$q$, v_org), '42501');
    assert workspace.app_page_reindex('ku-boss@example.com', v_org), 'reindex';
    assert (select summary_queued_at is not null from workspace.pages where id = v_org), 'queued again';
    assert workspace.app_summaries_rerun('ku-boss@example.com') >= 32, 'rerun counts';
end;
$$;

rollback;
