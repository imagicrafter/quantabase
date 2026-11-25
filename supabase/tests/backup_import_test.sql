-- backup_import_test.sql -- checks for migration 0056 (Step F: backup, import).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
-- WHAT IS UNDER TEST
--   * the backup functions are kb_engine only; page_import is granted to
--     nobody; helpers have no grant
--   * the Backup screen is the Engine owner's alone (not other administrators)
--   * the backup cannot be switched on without a repository and a token
--   * backup_claim: due once, not again within the window, not while running
--   * backup_finish records the result; a bad commit id is not stored
--   * backup_pages pages through every live page with owner and links
--   * backup_log lists history newest first, titles only
--   * page_import: creates once, never overwrites, topics limited to grants

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
    ('bk-clients', 'Clients', false),
    ('bk-money', 'Money', false)
on conflict (domain) do nothing;

-- Nobody else may count as the owner inside this transaction.
update workspace.principals set active = false where role = 'administrator';
update workspace.engine_settings set config = null where id;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash, created_at) values
    ('bk-owner', 'Owner',      'administrator', 'bk-owner@example.com', true, 'sub-bk-owner', 'tok-bk-owner', now() - interval '2 days'),
    ('bk-admin', 'Other Admin','administrator', 'bk-admin@example.com', true, 'sub-bk-admin', 'tok-bk-admin', now() - interval '1 day'),
    ('bk-ann',   'Ann',        'reader',        'bk-ann@example.com',   true, 'sub-bk-ann',   'tok-bk-ann',   now());

insert into workspace.access_grants (principal_id, domain)
select p.id, 'bk-clients' from workspace.principals p where p.handle in ('bk-ann', 'bk-owner');

-- 1. Privileges ---------------------------------------------------------------
do $$
begin
    assert has_function_privilege('kb_engine', 'workspace.app_backup_get(text)', 'execute'), 'kb_engine app_backup_get';
    assert not has_function_privilege('anon', 'workspace.app_backup_get(text)', 'execute'), 'anon app_backup_get';
    assert not has_function_privilege('authenticated', 'workspace.app_backup_get(text)', 'execute'), 'authenticated app_backup_get';
    assert not has_function_privilege('kb_ingest', 'workspace.app_backup_get(text)', 'execute'), 'kb_ingest app_backup_get';
    assert has_function_privilege('kb_engine', 'workspace.app_backup_set(text, text, text, boolean)', 'execute'), 'kb_engine app_backup_set';
    assert not has_function_privilege('anon', 'workspace.app_backup_set(text, text, text, boolean)', 'execute'), 'anon app_backup_set';
    assert not has_function_privilege('authenticated', 'workspace.app_backup_set(text, text, text, boolean)', 'execute'), 'authenticated app_backup_set';
    assert not has_function_privilege('kb_ingest', 'workspace.app_backup_set(text, text, text, boolean)', 'execute'), 'kb_ingest app_backup_set';
    assert has_function_privilege('kb_engine', 'workspace.app_backup_request(text)', 'execute'), 'kb_engine app_backup_request';
    assert not has_function_privilege('anon', 'workspace.app_backup_request(text)', 'execute'), 'anon app_backup_request';
    assert not has_function_privilege('authenticated', 'workspace.app_backup_request(text)', 'execute'), 'authenticated app_backup_request';
    assert not has_function_privilege('kb_ingest', 'workspace.app_backup_request(text)', 'execute'), 'kb_ingest app_backup_request';
    assert has_function_privilege('kb_engine', 'workspace.backup_claim(integer)', 'execute'), 'kb_engine backup_claim';
    assert not has_function_privilege('anon', 'workspace.backup_claim(integer)', 'execute'), 'anon backup_claim';
    assert not has_function_privilege('authenticated', 'workspace.backup_claim(integer)', 'execute'), 'authenticated backup_claim';
    assert not has_function_privilege('kb_ingest', 'workspace.backup_claim(integer)', 'execute'), 'kb_ingest backup_claim';
    assert has_function_privilege('kb_engine', 'workspace.backup_finish(boolean, text, text, integer, text)', 'execute'), 'kb_engine backup_finish';
    assert not has_function_privilege('anon', 'workspace.backup_finish(boolean, text, text, integer, text)', 'execute'), 'anon backup_finish';
    assert not has_function_privilege('authenticated', 'workspace.backup_finish(boolean, text, text, integer, text)', 'execute'), 'authenticated backup_finish';
    assert not has_function_privilege('kb_ingest', 'workspace.backup_finish(boolean, text, text, integer, text)', 'execute'), 'kb_ingest backup_finish';
    assert has_function_privilege('kb_engine', 'workspace.backup_token()', 'execute'), 'kb_engine backup_token';
    assert not has_function_privilege('anon', 'workspace.backup_token()', 'execute'), 'anon backup_token';
    assert not has_function_privilege('authenticated', 'workspace.backup_token()', 'execute'), 'authenticated backup_token';
    assert not has_function_privilege('kb_ingest', 'workspace.backup_token()', 'execute'), 'kb_ingest backup_token';
    assert has_function_privilege('kb_engine', 'workspace.backup_pages(uuid, integer)', 'execute'), 'kb_engine backup_pages';
    assert not has_function_privilege('anon', 'workspace.backup_pages(uuid, integer)', 'execute'), 'anon backup_pages';
    assert not has_function_privilege('authenticated', 'workspace.backup_pages(uuid, integer)', 'execute'), 'authenticated backup_pages';
    assert not has_function_privilege('kb_ingest', 'workspace.backup_pages(uuid, integer)', 'execute'), 'kb_ingest backup_pages';
    assert has_function_privilege('kb_engine', 'workspace.backup_log(integer)', 'execute'), 'kb_engine backup_log';
    assert not has_function_privilege('anon', 'workspace.backup_log(integer)', 'execute'), 'anon backup_log';
    assert not has_function_privilege('authenticated', 'workspace.backup_log(integer)', 'execute'), 'authenticated backup_log';
    assert not has_function_privilege('kb_ingest', 'workspace.backup_log(integer)', 'execute'), 'kb_ingest backup_log';
    assert has_function_privilege('kb_engine', 'workspace.app_secret_set(text, text, text)', 'execute'), 'kb_engine app_secret_set';
    assert not has_function_privilege('anon', 'workspace.app_secret_set(text, text, text)', 'execute'), 'anon app_secret_set';
    assert not has_function_privilege('authenticated', 'workspace.app_secret_set(text, text, text)', 'execute'), 'authenticated app_secret_set';
    assert not has_function_privilege('kb_ingest', 'workspace.app_secret_set(text, text, text)', 'execute'), 'kb_ingest app_secret_set';
    assert not has_function_privilege('kb_engine', 'workspace.page_import(text, jsonb)', 'execute'), 'kb_engine page_import';
    assert not has_function_privilege('anon', 'workspace.page_import(text, jsonb)', 'execute'), 'anon page_import';
    assert not has_function_privilege('authenticated', 'workspace.page_import(text, jsonb)', 'execute'), 'authenticated page_import';
    assert not has_function_privilege('kb_ingest', 'workspace.page_import(text, jsonb)', 'execute'), 'kb_ingest page_import';
    assert not has_function_privilege('kb_engine', 'workspace._engine_owner_email()', 'execute'), 'kb_engine _engine_owner_email';
    assert not has_function_privilege('anon', 'workspace._engine_owner_email()', 'execute'), 'anon _engine_owner_email';
    assert not has_function_privilege('authenticated', 'workspace._engine_owner_email()', 'execute'), 'authenticated _engine_owner_email';
    assert not has_function_privilege('kb_ingest', 'workspace._engine_owner_email()', 'execute'), 'kb_ingest _engine_owner_email';
    assert not has_function_privilege('kb_engine', 'workspace._engine_owner_require(text)', 'execute'), 'kb_engine _engine_owner_require';
    assert not has_function_privilege('anon', 'workspace._engine_owner_require(text)', 'execute'), 'anon _engine_owner_require';
    assert not has_function_privilege('authenticated', 'workspace._engine_owner_require(text)', 'execute'), 'authenticated _engine_owner_require';
    assert not has_function_privilege('kb_ingest', 'workspace._engine_owner_require(text)', 'execute'), 'kb_ingest _engine_owner_require';
    assert not has_function_privilege('kb_engine', 'workspace._backup_state()', 'execute'), 'kb_engine _backup_state';
    assert not has_function_privilege('anon', 'workspace._backup_state()', 'execute'), 'anon _backup_state';
    assert not has_function_privilege('authenticated', 'workspace._backup_state()', 'execute'), 'authenticated _backup_state';
    assert not has_function_privilege('kb_ingest', 'workspace._backup_state()', 'execute'), 'kb_ingest _backup_state';
    assert (select relrowsecurity from pg_class where oid = 'workspace.backup_settings'::regclass), 'rls on';
    assert not has_table_privilege('kb_engine', 'workspace.backup_settings', 'select'), 'no table read';
end;
$$;

-- 2. Owner only -----------------------------------------------------------------
do $$
declare
    v jsonb;
begin
    assert workspace._engine_owner_email() = 'bk-owner@example.com', 'first administrator is the owner';
    v := workspace.app_backup_get('bk-owner@example.com');
    assert v->>'enabled' = 'false' and v->>'branch' = 'main', 'defaults';
    assert v ? 'has_token' and not (v ? 'token'), 'token never returned';
    assert pg_temp.raises($q$select workspace.app_backup_get('bk-admin@example.com')$q$, '42501'), 'other admin refused';
    assert pg_temp.raises($q$select workspace.app_backup_get('bk-ann@example.com')$q$, '42501'), 'reader refused';
    assert pg_temp.raises($q$select workspace.app_backup_set('bk-admin@example.com', 'acme/kb', 'main', false)$q$, '42501'), 'other admin cannot set';
    assert pg_temp.raises($q$select workspace.app_secret_set('bk-admin@example.com', 'kbe_backup_token', 'ghp_aaaaaaaaaaaaaaaa')$q$, '42501'), 'other admin cannot set the token';

    -- The config's owner wins over the first administrator.
    insert into workspace.engine_settings (id, config) values (true, '{"engine":{"owner":{"email":"bk-admin@example.com"}}}')
    on conflict (id) do update set config = excluded.config;
    assert workspace._engine_owner_email() = 'bk-admin@example.com', 'config owner';
    assert pg_temp.raises($q$select workspace.app_backup_get('bk-owner@example.com')$q$, '42501'), 'not the owner now';
    update workspace.engine_settings set config = null where id;

    -- Shapes.
    assert pg_temp.raises($q$select workspace.app_backup_set('bk-owner@example.com', 'not a repo', 'main', false)$q$, '22023'), 'repo shape';
    assert pg_temp.raises($q$select workspace.app_backup_set('bk-owner@example.com', 'acme/kb', '../x', false)$q$, '22023'), 'branch shape';
    assert pg_temp.raises($q$select workspace.app_backup_set('bk-owner@example.com', null, 'main', true)$q$, '22023'), 'on needs a repo';
    v := workspace.app_backup_set('bk-owner@example.com', 'acme/kb-backup', '', false);
    assert v->>'repo' = 'acme/kb-backup' and v->>'branch' = 'main', 'saved';
    assert pg_temp.raises($q$select workspace.app_secret_set('bk-owner@example.com', 'kbe_other', 'ghp_aaaaaaaaaaaaaaaa')$q$, '22023'), 'other names refused';
end;
$$;

-- 3. Token, claim, finish (needs Vault) -------------------------------------------
do $$
declare
    v jsonb;
begin
    if to_regclass('vault.secrets') is null then
        raise notice 'vault absent: backup token and claim checks skipped';
        return;
    end if;
    assert workspace.backup_claim(20) is null, 'not due while off';
    assert pg_temp.raises($q$select workspace.app_backup_set('bk-owner@example.com', 'acme/kb-backup', 'main', true)$q$, '22023'), 'on needs the token';
    perform workspace.app_secret_set('bk-owner@example.com', 'kbe_backup_token', 'ghp_testtokenvalue0000');
    assert workspace.backup_token() = 'ghp_testtokenvalue0000', 'token readable by the service function';
    assert (workspace.app_backup_get('bk-owner@example.com')->>'has_token')::boolean, 'has token';
    v := workspace.app_backup_set('bk-owner@example.com', 'acme/kb-backup', 'main', true);
    assert (v->>'enabled')::boolean, 'on';

    v := workspace.backup_claim(20);
    assert v->>'repo' = 'acme/kb-backup' and v->>'branch' = 'main', 'claimed';
    assert workspace.backup_claim(20) is null, 'not twice';
    assert pg_temp.raises($q$select workspace.app_backup_request('bk-ann@example.com')$q$, '42501'), 'reader cannot request';
    perform workspace.app_backup_request('bk-owner@example.com');
    assert workspace.backup_claim(20) is null, 'a request does not break into a running backup';

    perform workspace.backup_finish(true, 'done', 'not-a-sha', 12, null);
    v := workspace.app_backup_get('bk-owner@example.com');
    assert v->>'last_status' = 'done' and (v->>'last_files')::int = 12 and v->>'last_commit' is null, 'bad sha not kept';
    assert workspace.backup_claim(20) is null, 'not again within the window';
    perform workspace.app_backup_request('bk-owner@example.com');
    assert workspace.backup_claim(20) is not null, 'due after a request';
    perform workspace.backup_finish(false, null, null, null, repeat('x', 400));
    v := workspace.app_backup_get('bk-owner@example.com');
    assert v->>'last_status' = 'failed' and length(v->>'last_error') = 300, 'failure kept short';
    assert (v->>'last_files')::int = 12, 'failure keeps the last count';

    -- A run stuck for over an hour is taken over.
    update workspace.backup_settings set last_status = 'running', last_started_at = now() - interval '25 hours' where id;
    assert workspace.backup_claim(20) is not null, 'stale run taken over';
end;
$$;

-- 4. Import, then the backup reads ---------------------------------------------
do $$
declare
    v     jsonb;
    v_all jsonb;
begin
    assert pg_temp.raises($q$select workspace.page_import('nobody@example.com', '{"key":"x","drawer":"people","title":"X"}')$q$, '22023'), 'unknown owner';
    v := workspace.page_import('bk-ann@example.com', jsonb_build_object(
        'key', 'acme.com', 'drawer', 'organisations', 'title', 'Acme', 'aliases', jsonb_build_array('Acme Inc'),
        'topics', jsonb_build_array('bk-clients'), 'tags', jsonb_build_array('client'),
        'related', jsonb_build_array('Bob Smith'), 'body', 'Works with [[Bob Smith]].'));
    assert v->>'status' = 'created' and v->>'key' = 'acme.com', 'created';
    v := workspace.page_import('bk-ann@example.com', jsonb_build_object(
        'key', 'ACME.com', 'drawer', 'organisations', 'title', 'Acme changed'));
    assert v->>'status' = 'exists', 'never overwrites';
    assert (select title from workspace.pages where key = 'acme.com') = 'Acme', 'unchanged';
    assert pg_temp.raises($q$select workspace.page_import('bk-ann@example.com', '{"key":"m","drawer":"concepts","title":"M","topics":["bk-money"]}')$q$, '22023'), 'topic not held';
    v := workspace.page_import('bk-ann@example.com', jsonb_build_object(
        'key', 'bob@acme.com', 'drawer', 'people', 'title', 'Bob Smith'));
    assert v->>'status' = 'created', 'second page';
    assert (select count(*) from workspace.page_history h join workspace.pages p on p.id = h.page_id
            where p.key in ('acme.com', 'bob@acme.com')) = 2, 'history written';

    v_all := workspace.backup_pages(null, 500);
    assert jsonb_array_length(v_all) >= 2, 'pages listed';
    v := (select e from jsonb_array_elements(v_all) e where e->>'key' = 'acme.com');
    assert v->>'owner' = 'bk-ann@example.com', 'owner email';
    assert v->'links' @> '[{"target_key":"bob@acme.com","reason":"wikilink"}]'::jsonb, 'links point at the key once the page exists';
    assert jsonb_array_length(workspace.backup_pages(null, 1)) = 1, 'limit';
    assert jsonb_array_length(workspace.backup_pages((workspace.backup_pages(null, 1)->0->>'id')::uuid, 500))
         = jsonb_array_length(v_all) - 1, 'paging by id';

    v := workspace.backup_log(10);
    assert jsonb_array_length(v) >= 2, 'log rows';
    assert (v->0->>'saved_at')::timestamptz >= (v->1->>'saved_at')::timestamptz, 'newest first';
    assert not (v->0 ? 'body') and not (v->0 ? 'snapshot'), 'no text in the log';
end;
$$;

rollback;
