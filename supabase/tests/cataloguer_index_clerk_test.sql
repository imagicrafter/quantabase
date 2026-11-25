-- cataloguer_index_clerk_test.sql -- checks for migration 0075.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * summary_length: default standard, owner-only, fixed list, logged, read by the curator
--   * app_pipeline_get counts: summaries waiting, in the index, done and failed last run
--   * summary_failed / index_failed: faults on the Cataloguer / Index clerk cards
--   * app_ledger: the Cataloguer's cost is its own line, not the Author's
--   * app_index_search: the same rows as the MCP search, for what that person may see
--     (a sensitive topic stays hidden from an administrator without a grant)
--   * redo: preview for administrators, the action for the owner alone; it only re-queues
--   * grants: kb_engine only; nothing to anon or authenticated

begin;

-- Nobody else may count as the owner inside this transaction.
update workspace.principals set active = false where role = 'administrator';
update workspace.engine_settings set config = null where id;

insert into workspace.domains (domain, label, sensitive) values ('ci-clients', 'Clients', false), ('ci-private', 'Private', true)
on conflict (domain) do nothing;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash, created_at) values
    ('ci-owner', 'Owner',       'administrator', 'ci-owner@example.com', true, 'sub-ci-owner', 'tok-ci-owner', now() - interval '2 days'),
    ('ci-admin', 'Other Admin', 'administrator', 'ci-admin@example.com', true, 'sub-ci-admin', 'tok-ci-admin', now() - interval '1 day'),
    ('ci-ann',   'Ann',         'reader',        'ci-ann@example.com',   true, 'sub-ci-ann',   'tok-ci-ann',   now());

insert into workspace.access_grants (principal_id, domain)
select p.id, 'ci-clients' from workspace.principals p where p.handle in ('ci-owner', 'ci-admin');

do $$
declare
    v        jsonb;
    v_denied boolean;
    v_owner  uuid := (select id from workspace.principals where handle = 'ci-owner');
    v_emb    vector(384) := array_fill(0.01::real, array[384])::vector;
    v_n      integer;
begin
    -- grants
    assert has_function_privilege('kb_engine', 'workspace.app_index_search(text, text, vector, integer)', 'execute'), 'kb_engine search';
    assert has_function_privilege('kb_engine', 'workspace.app_summaries_redo(text)', 'execute'), 'kb_engine redo';
    assert has_function_privilege('kb_engine', 'workspace.app_summaries_redo_preview(text)', 'execute'), 'kb_engine preview';
    assert not has_function_privilege('anon', 'workspace.app_index_search(text, text, vector, integer)', 'execute'), 'anon search';
    assert not has_function_privilege('authenticated', 'workspace.app_summaries_redo(text)', 'execute'), 'authenticated redo';
    assert not has_function_privilege('kb_engine', 'workspace._pages_search_core(uuid, text[], text, vector, integer)', 'execute'), 'core internal';
    assert has_function_privilege('kb_engine', 'workspace.pages_search_by_oauth_subject(text, text, vector, integer)', 'execute'), 'mcp search kept';

    -- summary_length
    v := workspace.app_pipeline_get('ci-owner@example.com');
    assert v->'settings'->>'summary_length' = 'standard', 'default standard';
    assert (workspace.curator_pipeline_get())->>'summary_length' = 'standard', 'curator reads it';
    v_denied := false;
    begin
        perform workspace.app_pipeline_set('ci-admin@example.com', 'summary_length', 'short');
    exception when sqlstate '42501' then v_denied := true;
    end;
    assert v_denied, 'another administrator cannot change it';
    v_denied := false;
    begin
        perform workspace.app_pipeline_set('ci-owner@example.com', 'summary_length', 'long');
    exception when sqlstate '22023' then v_denied := true;
    end;
    assert v_denied, 'only short or standard';
    v := workspace.app_pipeline_set('ci-owner@example.com', 'summary_length', 'short');
    assert (v->>'changed')::boolean, 'changed';
    assert (workspace.curator_pipeline_get())->>'summary_length' = 'short', 'curator sees short';
    assert exists (select 1 from workspace.pipeline_settings_log
                   where setting = 'summary_length' and old_value = 'standard' and new_value = 'short'
                     and changed_by = 'ci-owner@example.com'), 'logged';

    -- pages: two indexed, one waiting, one in a private topic the admin does not hold
    delete from workspace.pipeline_tickets;
    delete from workspace.curator_runs;
    insert into workspace.pages (owner_principal_id, drawer, key, title, body, topics, content_hash, distillation, embedding, summary_queued_at)
    values
        (v_owner, 'organisations', 'ci-northwind', 'Northwind Fixture', 'Northwind ordered widgets.', array['ci-clients'], 'ci-h1', 'Northwind is a client.', v_emb, null),
        (v_owner, 'organisations', 'ci-contoso',   'Contoso Fixture',   'Contoso widgets are blue.',  array['ci-clients'], 'ci-h2', 'Contoso is a client.',   v_emb, null),
        (v_owner, 'projects',      'ci-waiting',   'Waiting Fixture',   'A widget project.',          array['ci-clients'], 'ci-h3', null, null, now()),
        (v_owner, 'projects',      'ci-secret',    'Secret Fixture',    'Secret widgets.',            array['ci-private'], 'ci-h4', 'Secret.', v_emb, null);

    insert into workspace.curator_runs (mode, status, started_at, finished_at, stats)
    values ('tick', 'ok', now() - interval '1 hour', now() - interval '59 minutes',
            jsonb_build_object('summaries', 6, 'summary_failed', 2, 'index_failed', 1,
                               'usd', 1.5, 'usd_summaries', 0.25, 'summary_model', 'openai-gpt-oss-120b',
                               'writer_model', 'anthropic-claude-sonnet-5.5', 'usd:anthropic-claude-sonnet-5.5', 1.0));

    v := workspace.app_pipeline_get('ci-owner@example.com');
    assert (v->>'summaries_pending')::int >= 1, 'waiting counted';
    assert (v->>'pages_indexed')::int >= 3, 'indexed counted';
    assert (v->'summary_run'->>'summaries')::int = 6, 'done last run';
    assert (v->'summary_run'->>'summary_failed')::int = 2, 'failed last run';
    assert (v->'summary_run'->>'index_failed')::int = 1, 'index failed last run';
    assert v->>'summary_model' = 'openai-gpt-oss-120b', 'summary model';
    assert (v->>'summary_usd_30d')::numeric = 0.25, 'cost last 30 days';

    -- faults on their own cards; only a person closes them
    perform workspace.curator_tickets_sync();
    assert (select step from workspace.pipeline_tickets where kind = 'summary_failed' and status = 'open') = 'cataloguer', 'cataloguer fault';
    assert (select step from workspace.pipeline_tickets where kind = 'index_failed' and status = 'open') = 'index_clerk', 'index clerk fault';
    insert into workspace.curator_runs (mode, status, started_at, finished_at, stats)
    values ('tick', 'ok', now() - interval '5 minutes', now() - interval '4 minutes', jsonb_build_object('summaries', 3));
    perform workspace.curator_tickets_sync();
    assert (select status from workspace.pipeline_tickets where kind = 'summary_failed') = 'open', 'fault stays open';
    assert (select cleared_at from workspace.pipeline_tickets where kind = 'summary_failed') is not null, 'looks fixed';
    assert (select cleared_at from workspace.pipeline_tickets where kind = 'index_failed') is not null, 'index looks fixed';
    -- once no page waits, a fault looks fixed even without a new run
    delete from workspace.pipeline_tickets;
    insert into workspace.curator_runs (mode, status, started_at, finished_at, stats)
    values ('tick', 'ok', now() - interval '2 minutes', now() - interval '1 minute', jsonb_build_object('summary_failed', 1));
    perform workspace.curator_tickets_sync();
    assert (select cleared_at from workspace.pipeline_tickets where kind = 'summary_failed') is null, 'fault raised again';
    update workspace.pages set summary_queued_at = null where summary_queued_at is not null;
    perform workspace.curator_tickets_sync();
    assert (select cleared_at from workspace.pipeline_tickets where kind = 'summary_failed') is not null, 'nothing waits: looks fixed';
    update workspace.pages set summary_queued_at = now() where key = 'ci-waiting';
    -- a big backlog alone is not a fault
    assert not exists (select 1 from workspace.pipeline_tickets where kind not in ('summary_failed', 'index_failed')
                       and step in ('cataloguer', 'index_clerk')), 'no backlog ticket';

    -- the ledger: the Cataloguer is its own line, taken out of the rest
    v := workspace.app_ledger('ci-owner@example.com');
    assert (v->>'cataloguer_usd')::numeric = 0.25, 'cataloguer month total';
    assert (v->'days'->0->>'cataloguer_usd')::numeric = 0.25, 'cataloguer per day';
    assert (v->'days'->0->>'author_usd')::numeric = 1.0, 'author unchanged';
    assert (v->'days'->0->>'other_usd')::numeric = 0.25, 'other is the rest';

    -- search: the same rows as the MCP search, for what that person may see
    select count(*) into v_n
      from workspace.app_index_search('ci-admin@example.com', 'widgets', v_emb, 10) s
     where s.key like 'ci-%';
    assert v_n = (select count(*) from workspace.pages_search_by_oauth_subject('sub-ci-admin', 'widgets', v_emb, 10) s
                  where s.key like 'ci-%'), 'same as the MCP search';
    assert not exists (select 1 from workspace.app_index_search('ci-admin@example.com', 'widgets', v_emb, 10) s
                       where s.key = 'ci-secret'), 'private topic not shown to the admin';
    assert exists (select 1 from workspace.app_index_search('ci-owner@example.com', 'secret', v_emb, 10) s
                   where s.key = 'ci-secret'), 'own page shown to its owner';
    v_denied := false;
    begin
        perform * from workspace.app_index_search('ci-ann@example.com', 'widgets', v_emb, 10);
    exception when sqlstate '42501' then v_denied := true;
    end;
    assert v_denied, 'readers cannot use the try-a-search box';

    -- redo: preview for administrators, the action for the owner alone
    v := workspace.app_summaries_redo_preview('ci-admin@example.com');
    assert (v->>'pages')::int >= 4, 'preview counts live pages';
    assert v->>'summary_model' is not null, 'preview names the model';
    v_denied := false;
    begin
        perform workspace.app_summaries_redo('ci-admin@example.com');
    exception when sqlstate '42501' then v_denied := true;
    end;
    assert v_denied, 'only the owner redoes';
    v_n := workspace.app_summaries_redo('ci-owner@example.com');
    assert v_n >= 4, 'every live page queued';
    assert not exists (select 1 from workspace.pages where key like 'ci-%' and deleted_at is null and summary_queued_at is null), 'all queued';
    assert (select distillation from workspace.pages where key = 'ci-northwind') = 'Northwind is a client.', 'old summary kept until rewritten';
    assert exists (select 1 from workspace.pipeline_settings_log where setting = 'redo_index'
                   and changed_by = 'ci-owner@example.com'), 'redo logged';

    -- tickets accept the new steps
    perform workspace._ticket_raise('ci-step', 'summary_failed', 'index_clerk', 't', 'w', 'd');
end;
$$;

rollback;
