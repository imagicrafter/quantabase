-- app_screens_test.sql -- checks for migration 0054 (Step D, the app screens).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
-- WHAT IS UNDER TEST
--   * every app_* function is kb_engine only; helpers have no grant
--   * the OAuth-subject decide/release/list functions are gone (approvals
--     only through the app)
--   * owner screens see and change the caller's own rows only; an unknown or
--     inactive email is refused
--   * settings functions are administrators only
--   * templates live in engine_templates and curator_settings_get reads them
--   * a page edit through the app needs the current hash and writes history;
--     restore writes a new version
--   * flagged items: release and discard, owner only, once
--   * secrets: only kbe_model_key, value never returned

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
    ('as-clients', 'Clients', false)
on conflict (domain) do nothing;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('as-boss', 'Boss Admin', 'administrator', 'as-boss@example.com', true, 'sub-as-boss', 'tok-as-boss'),
    ('as-ann',  'Ann Owner',  'reader',        'as-ann@example.com',  true, 'sub-as-ann',  'tok-as-ann'),
    ('as-eve',  'Eve Peer',   'reader',        'as-eve@example.com',  true, 'sub-as-eve',  'tok-as-eve'),
    ('as-old',  'Old Gone',   'reader',        'as-old@example.com',  false, 'sub-as-old', 'tok-as-old');

insert into workspace.access_grants (principal_id, domain)
select p.id, 'as-clients' from workspace.principals p where p.handle in ('as-ann', 'as-eve');

-- 1. Privileges ---------------------------------------------------------------
do $$
begin
    assert has_function_privilege('kb_engine', 'workspace.app_whoami(text)', 'execute'), 'kb_engine app_whoami';
    assert not has_function_privilege('anon', 'workspace.app_whoami(text)', 'execute'), 'anon app_whoami';
    assert not has_function_privilege('authenticated', 'workspace.app_whoami(text)', 'execute'), 'authenticated app_whoami';
    assert not has_function_privilege('kb_ingest', 'workspace.app_whoami(text)', 'execute'), 'kb_ingest app_whoami';
    assert has_function_privilege('kb_engine', 'workspace.app_templates_set(text, text[])', 'execute'), 'kb_engine app_templates_set';
    assert not has_function_privilege('anon', 'workspace.app_templates_set(text, text[])', 'execute'), 'anon app_templates_set';
    assert not has_function_privilege('authenticated', 'workspace.app_templates_set(text, text[])', 'execute'), 'authenticated app_templates_set';
    assert not has_function_privilege('kb_ingest', 'workspace.app_templates_set(text, text[])', 'execute'), 'kb_ingest app_templates_set';
    -- 0060: topics come from source tags; the service can no longer add one by name.
    -- 0063: administrators make topics; the service may call the (admin-checked) add.
    assert has_function_privilege('kb_engine', 'workspace.app_topic_add(text, text, text, boolean)', 'execute'), 'kb_engine app_topic_add';
    assert not has_function_privilege('anon', 'workspace.app_topic_add(text, text, text, boolean)', 'execute'), 'anon app_topic_add';
    assert not has_function_privilege('authenticated', 'workspace.app_topic_add(text, text, text, boolean)', 'execute'), 'authenticated app_topic_add';
    assert not has_function_privilege('kb_ingest', 'workspace.app_topic_add(text, text, text, boolean)', 'execute'), 'kb_ingest app_topic_add';
    assert has_function_privilege('kb_engine', 'workspace.app_secret_set(text, text, text)', 'execute'), 'kb_engine app_secret_set';
    assert not has_function_privilege('anon', 'workspace.app_secret_set(text, text, text)', 'execute'), 'anon app_secret_set';
    assert not has_function_privilege('authenticated', 'workspace.app_secret_set(text, text, text)', 'execute'), 'authenticated app_secret_set';
    assert not has_function_privilege('kb_ingest', 'workspace.app_secret_set(text, text, text)', 'execute'), 'kb_ingest app_secret_set';
    assert has_function_privilege('kb_engine', 'workspace.app_timer_set(text, text, boolean)', 'execute'), 'kb_engine app_timer_set';
    assert not has_function_privilege('anon', 'workspace.app_timer_set(text, text, boolean)', 'execute'), 'anon app_timer_set';
    assert not has_function_privilege('authenticated', 'workspace.app_timer_set(text, text, boolean)', 'execute'), 'authenticated app_timer_set';
    assert not has_function_privilege('kb_ingest', 'workspace.app_timer_set(text, text, boolean)', 'execute'), 'kb_ingest app_timer_set';
    assert has_function_privilege('kb_engine', 'workspace.app_health(text)', 'execute'), 'kb_engine app_health';
    assert not has_function_privilege('anon', 'workspace.app_health(text)', 'execute'), 'anon app_health';
    assert not has_function_privilege('authenticated', 'workspace.app_health(text)', 'execute'), 'authenticated app_health';
    assert not has_function_privilege('kb_ingest', 'workspace.app_health(text)', 'execute'), 'kb_ingest app_health';
    assert has_function_privilege('kb_engine', 'workspace.app_review_decide(text, uuid, boolean)', 'execute'), 'kb_engine app_review_decide';
    assert not has_function_privilege('anon', 'workspace.app_review_decide(text, uuid, boolean)', 'execute'), 'anon app_review_decide';
    assert not has_function_privilege('authenticated', 'workspace.app_review_decide(text, uuid, boolean)', 'execute'), 'authenticated app_review_decide';
    assert not has_function_privilege('kb_ingest', 'workspace.app_review_decide(text, uuid, boolean)', 'execute'), 'kb_ingest app_review_decide';
    assert has_function_privilege('kb_engine', 'workspace.app_flagged_discard(text, uuid)', 'execute'), 'kb_engine app_flagged_discard';
    assert not has_function_privilege('anon', 'workspace.app_flagged_discard(text, uuid)', 'execute'), 'anon app_flagged_discard';
    assert not has_function_privilege('authenticated', 'workspace.app_flagged_discard(text, uuid)', 'execute'), 'authenticated app_flagged_discard';
    assert not has_function_privilege('kb_ingest', 'workspace.app_flagged_discard(text, uuid)', 'execute'), 'kb_ingest app_flagged_discard';
    assert has_function_privilege('kb_engine', 'workspace.app_page_save(text, jsonb, text)', 'execute'), 'kb_engine app_page_save';
    assert not has_function_privilege('anon', 'workspace.app_page_save(text, jsonb, text)', 'execute'), 'anon app_page_save';
    assert not has_function_privilege('authenticated', 'workspace.app_page_save(text, jsonb, text)', 'execute'), 'authenticated app_page_save';
    assert not has_function_privilege('kb_ingest', 'workspace.app_page_save(text, jsonb, text)', 'execute'), 'kb_ingest app_page_save';
    assert has_function_privilege('kb_engine', 'workspace.app_page_restore(text, uuid, text)', 'execute'), 'kb_engine app_page_restore';
    assert not has_function_privilege('anon', 'workspace.app_page_restore(text, uuid, text)', 'execute'), 'anon app_page_restore';
    assert not has_function_privilege('authenticated', 'workspace.app_page_restore(text, uuid, text)', 'execute'), 'authenticated app_page_restore';
    assert not has_function_privilege('kb_ingest', 'workspace.app_page_restore(text, uuid, text)', 'execute'), 'kb_ingest app_page_restore';
    assert has_function_privilege('kb_engine', 'workspace.engine_embed_token()', 'execute'), 'kb_engine engine_embed_token';
    assert not has_function_privilege('anon', 'workspace.engine_embed_token()', 'execute'), 'anon engine_embed_token';
    assert not has_function_privilege('authenticated', 'workspace.engine_embed_token()', 'execute'), 'authenticated engine_embed_token';
    assert not has_function_privilege('kb_ingest', 'workspace.engine_embed_token()', 'execute'), 'kb_ingest engine_embed_token';
    assert has_function_privilege('kb_engine', 'workspace.engine_templates_get()', 'execute'), 'kb_engine engine_templates_get';
    assert not has_function_privilege('anon', 'workspace.engine_templates_get()', 'execute'), 'anon engine_templates_get';
    assert not has_function_privilege('authenticated', 'workspace.engine_templates_get()', 'execute'), 'authenticated engine_templates_get';
    assert not has_function_privilege('kb_ingest', 'workspace.engine_templates_get()', 'execute'), 'kb_ingest engine_templates_get';
    assert not has_function_privilege('kb_engine', 'workspace._app_person(text)', 'execute'), 'helper hidden';
    assert not has_function_privilege('kb_engine', 'workspace._app_timer_state()', 'execute'), 'timer helper hidden';
    assert to_regprocedure('workspace.curator_review_decide(text, uuid, boolean)') is null, 'oauth decide gone';
    assert to_regprocedure('workspace.source_item_release(text, uuid)') is null, 'oauth release gone';
    assert to_regprocedure('workspace.curator_review_list(text, text)') is null, 'oauth list gone';
    assert not has_table_privilege('kb_engine', 'workspace.engine_templates', 'select'), 'no table grant';
    assert (select relrowsecurity from pg_class where oid = 'workspace.engine_templates'::regclass), 'templates RLS';
    assert not exists (select 1 from information_schema.columns
                       where table_schema = 'workspace' and table_name = 'curator_settings'
                         and column_name = 'templates'), 'stopgap column dropped';
end;
$$;

-- 2. Settings: administrators only --------------------------------------------
do $$
declare
    v jsonb;
begin
    assert pg_temp.raises($q$select workspace.app_templates_set('as-ann@example.com', array['consulting'])$q$, '42501');
    assert pg_temp.raises($q$select workspace.app_topic_add('as-ann@example.com', 'x', 'X', false)$q$, '42501');
    assert pg_temp.raises($q$select workspace.app_secret_set('as-ann@example.com', 'kbe_model_key', 'abcdefghijkl')$q$, '42501');
    assert pg_temp.raises($q$select workspace.app_timer_get('as-ann@example.com')$q$, '42501');
    assert pg_temp.raises($q$select workspace.app_health('nobody@example.com')$q$, '42501');

    -- Templates: order kept, duplicates and base dropped, read back by the curator.
    assert workspace.app_templates_set('as-boss@example.com', array['property', 'base', 'consulting', 'property'])
        = array['property', 'consulting'], 'templates set';
    assert (select templates from workspace.curator_settings_get()) = array['property', 'consulting'], 'curator reads them';
    assert workspace.engine_templates_get() = array['property', 'consulting'], 'get';
    assert pg_temp.raises($q$select workspace.app_templates_set('as-boss@example.com', array['Bad Name'])$q$, '22023');
    assert workspace.app_templates_set('as-boss@example.com', array[]::text[]) = array[]::text[], 'cleared';

    -- Topics: added once, never changed, unclassified refused.
    assert workspace.app_topic_add('as-boss@example.com', 'as-new', 'New', true), 'topic added';
    assert not workspace.app_topic_add('as-boss@example.com', 'as-new', 'Changed', false), 'not re-added';
    assert (select sensitive from workspace.domains where domain = 'as-new'), 'still sensitive';
    assert pg_temp.raises($q$select workspace.app_topic_add('as-boss@example.com', 'unclassified', 'U', false)$q$, '22023');
    assert pg_temp.raises($q$select workspace.app_topic_add('as-boss@example.com', 'Bad topic', 'B', false)$q$, '22023');
    v := workspace.app_topics_list('as-boss@example.com');
    assert jsonb_array_length(v) >= 2, 'topics listed';

    -- Secrets: only the model key name; bad values refused.
    assert pg_temp.raises($q$select workspace.app_secret_set('as-boss@example.com', 'kbe_tick_secret', 'abcdefghijkl')$q$, '22023');
    assert pg_temp.raises($q$select workspace.app_secret_set('as-boss@example.com', 'kbe_model_key', 'short')$q$, '22023');
    assert pg_temp.raises($q$select workspace.app_secret_set('as-boss@example.com', 'kbe_model_key', 'has a space in it')$q$, '22023');

    -- Timer: bad address refused; there is no interval to choose (0057).
    -- No stored Engine host yet: refused. Then only the stored host is taken,
    -- and the address is built inside the database.
    assert pg_temp.raises($q$select workspace.app_timer_set('as-boss@example.com', 'x.example.com', false)$q$, '22023');
    update workspace.engine_settings set access = coalesce(access, '{}'::jsonb) || '{"host":"x.example.com"}'::jsonb where id;
    assert pg_temp.raises($q$select workspace.app_timer_set('as-boss@example.com', 'evil.example.net', false)$q$, '22023'), 'foreign host';
    assert pg_temp.raises($q$select workspace.app_timer_set('as-boss@example.com', 'https://x.example.com/internal/curator/tick', false)$q$, '22023'), 'url not host';
    assert to_regprocedure('workspace.app_timer_set(text, text, integer, boolean)') is null, 'interval version gone';
    v := workspace.app_timer_set('as-boss@example.com', 'X.Example.com', false);
    assert (v->>'wake_on_new_items')::boolean, 'new items wake the curator';
    assert v->>'engine_url' = 'https://x.example.com/internal/curator/tick', 'address stored';
    assert (v->>'enabled')::boolean is false, 'off';

    v := workspace.app_health('as-boss@example.com');
    assert (v->>'administrators')::int >= 1, 'health counts admins';
    assert v ? 'timer', 'health has timer';
end;
$$;

-- 3. Vault (only where the extension is present) ------------------------------
do $$
begin
    if to_regclass('vault.secrets') is null then
        raise notice 'vault absent: secret write checks skipped';
        return;
    end if;
    perform workspace.app_secret_set('as-boss@example.com', 'kbe_model_key', 'model-key-0001');
    assert (select has_model_key from workspace.curator_settings_get()), 'key present';
    assert workspace.curator_model_key() = 'model-key-0001', 'stored';
    perform workspace.app_secret_set('as-boss@example.com', 'kbe_model_key', 'model-key-0002');
    assert workspace.curator_model_key() = 'model-key-0002', 'replaced, not duplicated';
    assert (select count(*) from vault.secrets where name = 'kbe_model_key') = 1, 'one row';
end;
$$;

-- 3b. The timer, where pg_cron and pg_net can be switched on here ------------
do $$
declare
    v jsonb;
begin
    begin
        create extension if not exists pg_net;
        create extension if not exists pg_cron;
    exception when others then
        raise notice 'pg_cron/pg_net unavailable here (%): timer checks skipped', sqlerrm;
        return;
    end;
    if to_regclass('vault.secrets') is null then
        return;
    end if;
    v := workspace.app_timer_set('as-boss@example.com', 'x.example.com', true);
    assert v->'job'->>'schedule' = '0 * * * *', 'hourly safety tick: ' || coalesce(v::text, 'null');
    assert v->'wake_job'->>'schedule' = '* * * * *', 'minute wake check';
    assert (select command from cron.job where jobname = 'kbe-curator-wake') like '%curator_wake(true)%', 'wake command';
    assert (v->>'tick_secret_set')::boolean, 'tick secret made in the database';
    assert (select command from cron.job where jobname = 'kbe-curator-tick') like '%curator_tick_poke()%', 'command';
    assert (select command from cron.job where jobname = 'kbe-curator-tick')
        not like '%' || workspace._curator_vault_secret('kbe_tick_secret') || '%', 'secret not in the command';
    assert length(workspace._curator_vault_secret('kbe_tick_secret')) = 64, 'secret length';
    -- Saving again replaces the one job, and keeps the same secret.
    v := workspace.app_timer_set('as-boss@example.com', 'x.example.com', true);
    assert (select count(*) from cron.job where jobname = 'kbe-curator-tick') = 1, 'one job';
    assert (select count(*) from cron.job where jobname = 'kbe-curator-wake') = 1, 'one wake job';
    assert v->'job'->>'schedule' = '0 * * * *', 'hourly';
    assert (select count(*) from vault.secrets where name = 'kbe_tick_secret') = 1, 'one secret';
    assert workspace.app_timer_test('as-boss@example.com') is not null, 'test poke queued';
    -- Debounce: a wake now, then none inside 2 minutes.
    update workspace.curator_settings set last_wake_at = null where id;
    assert workspace.curator_wake(false) is not null, 'first wake pokes';
    assert workspace.curator_wake(false) is null, 'second wake inside 2 minutes does not';
    update workspace.curator_settings set last_wake_at = now() - interval '3 minutes' where id;
    assert workspace.curator_wake(true) is null, 'trailing check: nothing new waiting, no poke';
    -- Off removes both jobs, and a wake does nothing.
    v := workspace.app_timer_set('as-boss@example.com', 'x.example.com', false);
    assert not exists (select 1 from cron.job where jobname like 'kbe-curator-%'), 'jobs removed';
    update workspace.curator_settings set last_wake_at = null where id;
    assert workspace.curator_wake(false) is null, 'off: no wake';
end;
$$;

-- 4. Owner screens -------------------------------------------------------------
do $$
declare
    v_item    uuid;
    v_flag    uuid;
    v_flag2   uuid;
    v_review  uuid;
    r         record;
    v_page    jsonb;
    v_hist    uuid;
begin
    -- Unknown and inactive callers are refused.
    assert pg_temp.raises($q$select * from workspace.app_review_list('nobody@example.com', 'pending')$q$, '42501');
    assert pg_temp.raises($q$select * from workspace.app_pages_list('as-old@example.com')$q$, '42501');
    assert workspace.app_whoami('nobody@example.com') is null, 'whoami unknown';
    assert workspace.app_whoami('as-ann@example.com')->>'role' = 'reader', 'whoami ann';

    -- Ann's page, saved through the app.
    select * into r from workspace.app_page_save('as-ann@example.com', jsonb_build_object(
        'drawer', 'organisations', 'key', 'acme.com', 'title', 'Acme',
        'topics', jsonb_build_array('as-clients'), 'body', '## Notes' || chr(10) || '- first'), null);
    assert r.created and r.changed, 'created';
    -- A topic she does not hold is refused.
    assert pg_temp.raises($q$select * from workspace.app_page_save('as-ann@example.com',
        '{"drawer":"organisations","key":"other.com","title":"O","topics":["as-new"]}'::jsonb, null)$q$, '22023');
    -- Stale or missing hash refused.
    assert pg_temp.raises($q$select * from workspace.app_page_save('as-ann@example.com',
        '{"drawer":"organisations","key":"acme.com","title":"Acme 2","topics":["as-clients"]}'::jsonb, 'stale')$q$, '22023');
    assert pg_temp.raises($q$select * from workspace.app_page_save('as-ann@example.com',
        '{"drawer":"organisations","key":"acme.com","title":"Acme 2","topics":["as-clients"]}'::jsonb, null)$q$, '22023');

    v_page := workspace.app_page_get('as-ann@example.com', r.id);
    assert v_page->>'title' = 'Acme', 'ann reads hers';
    assert workspace.app_page_get('as-eve@example.com', r.id) is null, 'eve cannot read it here';
    assert (select count(*) from workspace.app_pages_list('as-eve@example.com')) = 0, 'eve lists none';
    assert (select count(*) from workspace.app_pages_list('as-ann@example.com', 'acm')) = 1, 'ann lists hers';

    -- Edit, then restore the first version.
    perform * from workspace.app_page_save('as-ann@example.com',
        (v_page - 'id' - 'content_hash' - 'updated_at') || jsonb_build_object('body', 'rewritten'),
        v_page->>'content_hash');
    assert (select count(*) from workspace.app_page_history('as-ann@example.com', r.id)) = 2, 'two versions';
    assert (select count(*) from workspace.app_page_history('as-eve@example.com', r.id)) = 0, 'eve sees no history';
    select h.id into v_hist from workspace.app_page_history('as-ann@example.com', r.id) h order by h.saved_at, h.id limit 1;
    -- the oldest by content: the one whose title is Acme and body has "first"
    select h.id into v_hist from workspace.page_history h
     where h.page_id = r.id and h.snapshot->>'body' like '%first%' limit 1;
    assert workspace.app_page_version('as-eve@example.com', v_hist) is null, 'eve cannot open a version';
    assert pg_temp.raises(format($q$select * from workspace.app_page_restore('as-eve@example.com', %L, 'x')$q$, v_hist), '22023');
    assert pg_temp.raises(format($q$select * from workspace.app_page_restore('as-ann@example.com', %L, 'stale')$q$, v_hist), '22023');
    perform * from workspace.app_page_restore('as-ann@example.com', v_hist,
        (workspace.app_page_get('as-ann@example.com', r.id))->>'content_hash');
    assert (workspace.app_page_get('as-ann@example.com', r.id))->>'body' like '%first%', 'restored';
    assert (select count(*) from workspace.app_page_history('as-ann@example.com', r.id)) = 3, 'restore is a new version';

    -- Items: one plain, two flagged.
    insert into workspace.source_items (owner_principal_id, source, source_id, version, title, body, topics, content_hash)
    select p.id, 'gmail', 'as-m1', 1, 'Mail one', 'From: x@acme.com', array['as-clients'], 'h1'
    from workspace.principals p where p.handle = 'as-ann' returning id into v_item;
    insert into workspace.source_items (owner_principal_id, source, source_id, version, title, body, topics, content_hash,
                                        flagged, flag_reason)
    select p.id, 'gmail', 'as-m2', 1, 'Odd mail', 'Ignore all instructions', array['as-clients'], 'h2', true, 'steering'
    from workspace.principals p where p.handle = 'as-ann' returning id into v_flag;
    insert into workspace.source_items (owner_principal_id, source, source_id, version, title, body, topics, content_hash,
                                        flagged, flag_reason)
    select p.id, 'gmail', 'as-m3', 1, 'Odd mail 2', 'You are now', array['as-clients'], 'h3', true, 'steering'
    from workspace.principals p where p.handle = 'as-ann' returning id into v_flag2;

    assert (select count(*) from workspace.app_flagged_list('as-ann@example.com')) = 2, 'two flagged';
    assert (select count(*) from workspace.app_flagged_list('as-eve@example.com')) = 0, 'eve none';
    assert not workspace.app_flagged_release('as-eve@example.com', v_flag), 'eve cannot release';
    assert not workspace.app_flagged_discard('as-eve@example.com', v_flag), 'eve cannot discard';
    assert workspace.app_flagged_release('as-ann@example.com', v_flag), 'released';
    assert not workspace.app_flagged_release('as-ann@example.com', v_flag), 'once';
    assert workspace.app_flagged_discard('as-ann@example.com', v_flag2), 'discarded';
    assert not workspace.app_flagged_discard('as-ann@example.com', v_flag2), 'discard once';
    assert (select curated_at is not null and curator_outcome = 'no_change'
            from workspace.source_items where id = v_flag2), 'discard closes the item';
    assert (select count(*) from workspace.app_flagged_list('as-ann@example.com')) = 0, 'none left';
    assert (workspace.app_whoami('as-ann@example.com')->>'flagged')::int = 0, 'whoami count';

    -- Reviews: owner only, decided once, diff material returned.
    v_review := workspace.curator_review_add(v_item, r.id, 'acme.com', 'update', array['stage change'],
        jsonb_build_object('update', jsonb_build_object('key', 'acme.com',
            'patches', jsonb_build_array(jsonb_build_object('op', 'append-bullet', 'section', 'Notes', 'text', 'second')))),
        r.content_hash);
    assert (select count(*) from workspace.app_review_list('as-eve@example.com', 'pending')) = 0, 'eve sees none';
    assert workspace.app_review_get('as-eve@example.com', v_review) is null, 'eve cannot open';
    v_page := workspace.app_review_get('as-ann@example.com', v_review);
    assert v_page->'page'->>'body' like '%first%', 'current body for the diff';
    assert v_page->'proposal' ? 'update', 'proposal';
    assert (workspace.app_whoami('as-ann@example.com')->>'pending_reviews')::int = 1, 'count';
    assert pg_temp.raises(format($q$select workspace.app_review_decide('as-ann@example.com', %L, null)$q$, v_review), '22023');
    assert not workspace.app_review_decide('as-eve@example.com', v_review, true), 'eve cannot decide';
    assert workspace.app_review_decide('as-ann@example.com', v_review, false), 'ann rejects';
    assert not workspace.app_review_decide('as-ann@example.com', v_review, true), 'decided once';
    assert (select status from workspace.curator_reviews where id = v_review) = 'rejected', 'rejected';
end;
$$;

rollback;
