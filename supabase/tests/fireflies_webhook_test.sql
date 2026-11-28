-- fireflies_webhook_test.sql -- checks for migration 0081 (Fireflies by webhook).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
-- WHAT IS UNDER TEST
--   * the two tables are closed (RLS, no grants); every function is kb_engine only
--   * source_item_record still answers as 0076 did (it now wraps
--     _source_item_record_for)
--   * fireflies_hook_record stores through the same body: the owner's rules
--     decide (kept vs not_included, default deny), the same text is unchanged
--   * delivery bookkeeping: begin/skip for repeats, re-sends, backfill, retry;
--     failed and stale pending rows are the missed list
--   * a person reads only their own account; another person is refused
--   * source_webhook_connected is true only for the caller's connected account
--   * with Supabase Vault: connect stores the key and secret there, never in a
--     table; lookup returns the secret; disconnect removes both

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

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('ff-ann', 'Ann Owner', 'reader', 'ff-ann@example.com', true, 'sub-ff-ann', 'tok-ff-ann'),
    ('ff-bob', 'Bob Other', 'administrator', 'ff-bob@example.com', true, 'sub-ff-bob', 'tok-ff-bob'),
    ('ff-web', 'Web Only', 'reader', 'ff-web@example.com', true, null, 'tok-ff-web');

-- 1. Privileges ---------------------------------------------------------------
do $$
begin
    assert (select relrowsecurity from pg_class where oid = 'workspace.fireflies_hooks'::regclass), 'RLS hooks';
    assert (select relrowsecurity from pg_class where oid = 'workspace.fireflies_deliveries'::regclass), 'RLS deliveries';
    assert not has_table_privilege('kb_engine', 'workspace.fireflies_hooks', 'select'), 'kb_engine table fireflies_hooks';
    assert not has_table_privilege('anon', 'workspace.fireflies_hooks', 'select'), 'anon table fireflies_hooks';
    assert not has_table_privilege('authenticated', 'workspace.fireflies_hooks', 'select'), 'authenticated table fireflies_hooks';
    assert not has_table_privilege('kb_engine', 'workspace.fireflies_deliveries', 'select'), 'kb_engine table fireflies_deliveries';
    assert not has_table_privilege('anon', 'workspace.fireflies_deliveries', 'select'), 'anon table fireflies_deliveries';
    assert not has_table_privilege('authenticated', 'workspace.fireflies_deliveries', 'select'), 'authenticated table fireflies_deliveries';
    assert has_function_privilege('kb_engine', 'workspace.app_fireflies_connect(text, text, text, text, text)', 'execute'), 'kb_engine app_fireflies_connect';
    assert not has_function_privilege('anon', 'workspace.app_fireflies_connect(text, text, text, text, text)', 'execute'), 'anon app_fireflies_connect';
    assert not has_function_privilege('authenticated', 'workspace.app_fireflies_connect(text, text, text, text, text)', 'execute'), 'authenticated app_fireflies_connect';
    assert has_function_privilege('kb_engine', 'workspace.app_fireflies_get(text, uuid)', 'execute'), 'kb_engine app_fireflies_get';
    assert not has_function_privilege('anon', 'workspace.app_fireflies_get(text, uuid)', 'execute'), 'anon app_fireflies_get';
    assert not has_function_privilege('authenticated', 'workspace.app_fireflies_get(text, uuid)', 'execute'), 'authenticated app_fireflies_get';
    assert has_function_privilege('kb_engine', 'workspace.app_fireflies_missed(text, uuid)', 'execute'), 'kb_engine app_fireflies_missed';
    assert not has_function_privilege('anon', 'workspace.app_fireflies_missed(text, uuid)', 'execute'), 'anon app_fireflies_missed';
    assert not has_function_privilege('authenticated', 'workspace.app_fireflies_missed(text, uuid)', 'execute'), 'authenticated app_fireflies_missed';
    assert has_function_privilege('kb_engine', 'workspace.app_fireflies_disconnect(text, uuid)', 'execute'), 'kb_engine app_fireflies_disconnect';
    assert not has_function_privilege('anon', 'workspace.app_fireflies_disconnect(text, uuid)', 'execute'), 'anon app_fireflies_disconnect';
    assert not has_function_privilege('authenticated', 'workspace.app_fireflies_disconnect(text, uuid)', 'execute'), 'authenticated app_fireflies_disconnect';
    assert has_function_privilege('kb_engine', 'workspace.fireflies_hook_lookup(text)', 'execute'), 'kb_engine fireflies_hook_lookup';
    assert not has_function_privilege('anon', 'workspace.fireflies_hook_lookup(text)', 'execute'), 'anon fireflies_hook_lookup';
    assert not has_function_privilege('authenticated', 'workspace.fireflies_hook_lookup(text)', 'execute'), 'authenticated fireflies_hook_lookup';
    assert has_function_privilege('kb_engine', 'workspace.fireflies_hook_seen(uuid, text)', 'execute'), 'kb_engine fireflies_hook_seen';
    assert not has_function_privilege('anon', 'workspace.fireflies_hook_seen(uuid, text)', 'execute'), 'anon fireflies_hook_seen';
    assert not has_function_privilege('authenticated', 'workspace.fireflies_hook_seen(uuid, text)', 'execute'), 'authenticated fireflies_hook_seen';
    assert has_function_privilege('kb_engine', 'workspace.fireflies_delivery_begin(uuid, text, text, bigint)', 'execute'), 'kb_engine fireflies_delivery_begin';
    assert not has_function_privilege('anon', 'workspace.fireflies_delivery_begin(uuid, text, text, bigint)', 'execute'), 'anon fireflies_delivery_begin';
    assert not has_function_privilege('authenticated', 'workspace.fireflies_delivery_begin(uuid, text, text, bigint)', 'execute'), 'authenticated fireflies_delivery_begin';
    assert has_function_privilege('kb_engine', 'workspace.fireflies_delivery_end(uuid, text, text, text, text, integer)', 'execute'), 'kb_engine fireflies_delivery_end';
    assert not has_function_privilege('anon', 'workspace.fireflies_delivery_end(uuid, text, text, text, text, integer)', 'execute'), 'anon fireflies_delivery_end';
    assert not has_function_privilege('authenticated', 'workspace.fireflies_delivery_end(uuid, text, text, text, text, integer)', 'execute'), 'authenticated fireflies_delivery_end';
    assert has_function_privilege('kb_engine', 'workspace.fireflies_hook_api_key(uuid)', 'execute'), 'kb_engine fireflies_hook_api_key';
    assert not has_function_privilege('anon', 'workspace.fireflies_hook_api_key(uuid)', 'execute'), 'anon fireflies_hook_api_key';
    assert not has_function_privilege('authenticated', 'workspace.fireflies_hook_api_key(uuid)', 'execute'), 'authenticated fireflies_hook_api_key';
    assert has_function_privilege('kb_engine', 'workspace.fireflies_hook_record(uuid, jsonb)', 'execute'), 'kb_engine fireflies_hook_record';
    assert not has_function_privilege('anon', 'workspace.fireflies_hook_record(uuid, jsonb)', 'execute'), 'anon fireflies_hook_record';
    assert not has_function_privilege('authenticated', 'workspace.fireflies_hook_record(uuid, jsonb)', 'execute'), 'authenticated fireflies_hook_record';
    assert has_function_privilege('kb_engine', 'workspace.source_webhook_connected(text, text, text)', 'execute'), 'kb_engine source_webhook_connected';
    assert not has_function_privilege('anon', 'workspace.source_webhook_connected(text, text, text)', 'execute'), 'anon source_webhook_connected';
    assert not has_function_privilege('authenticated', 'workspace.source_webhook_connected(text, text, text)', 'execute'), 'authenticated source_webhook_connected';
    assert has_function_privilege('kb_engine', 'workspace.source_item_record(text, jsonb)', 'execute'), 'kb_engine source_item_record';
    assert not has_function_privilege('anon', 'workspace.source_item_record(text, jsonb)', 'execute'), 'anon source_item_record';
    assert not has_function_privilege('authenticated', 'workspace.source_item_record(text, jsonb)', 'execute'), 'authenticated source_item_record';
    assert not has_function_privilege('kb_engine', 'workspace._source_item_record_for(uuid, jsonb)', 'execute'), 'inner body closed';
    assert not has_function_privilege('anon', 'workspace._source_item_record_for(uuid, jsonb)', 'execute'), 'inner body anon';
end $$;

-- 2. A hook row made by hand (no Vault needed): Ann's Fireflies account ------------
do $$
declare
    v_acct uuid;
begin
    v_acct := (workspace.source_ingest_plan('sub-ff-ann', 'fireflies', 'ann@meet.example')->>'account_id')::uuid;
    insert into workspace.fireflies_hooks (account_id, hook_id, fireflies_email, key_last4)
    values (v_acct, 'hookhookhookhookhookhookhookhook', 'ann@meet.example', 'WXYZ');
    perform set_config('ff.acct', v_acct::text, true);
    -- Only meetings with someone from acme.example are kept, and only for Ann.
    perform workspace.app_source_rules_save('ff-ann@example.com', v_acct,
        '[{"kind":"include","name":"Acme","match":{"participants":["@acme.example"]},"private":true}]', 0);
end $$;

-- 3. The webhook record path: rules decide, idempotent ----------------------------
set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('ff.acct')::uuid;
    r jsonb;
    item jsonb := jsonb_build_object(
        'source_id', 'MEET01', 'title', 'Weekly sync', 'body', 'Participants: pat@acme.example. Transcript: Pat: hello',
        'source_created_at', '2026-11-20T10:00:00Z', 'cursor', '2026-11-20T10:00:00Z',
        'provider', jsonb_build_object('meeting_id', 'MEET01', 'participants', jsonb_build_array('pat@acme.example'),
                                       'organizer_email', 'ann@meet.example', 'date', '2026-11-20T10:00:00Z'),
        -- A topic or owner a delivery claims is ignored; the source and account are the hook's.
        'topics', jsonb_build_array('anything'), 'owner', 'ff-bob@example.com',
        'source', 'gmail', 'account', 'someone@else.example');
begin
    r := workspace.fireflies_hook_record(v_acct, item);
    assert r->>'status' = 'new', 'kept: ' || r::text;
    r := workspace.fireflies_hook_record(v_acct, item);
    assert r->>'status' = 'unchanged', 'twice is stored once: ' || r::text;
    r := workspace.fireflies_hook_record(v_acct, jsonb_set(item, '{body}', '"Participants: pat@acme.example. Transcript: Pat: hello again"'));
    assert r->>'status' = 'new_version', 'changed text is a new version: ' || r::text;

    -- No rule includes a meeting without acme.example: nothing stored (default deny).
    r := workspace.fireflies_hook_record(v_acct, jsonb_set(jsonb_set(item, '{source_id}', '"MEET02"'),
        '{provider,participants}', '["lee@other.example"]'));
    assert r->>'status' = 'not_included', 'left out: ' || r::text;

    -- The plugin path (an OAuth subject) still answers as before.
    r := workspace.source_item_record('sub-ff-ann', jsonb_build_object('source', 'fireflies', 'account', 'ann@meet.example',
        'source_id', 'MEET01', 'body', 'Participants: pat@acme.example. Transcript: Pat: hello again',
        'provider', jsonb_build_object('meeting_id', 'MEET01', 'participants', jsonb_build_array('pat@acme.example'))));
    assert r->>'status' = 'unchanged', 'same item through record_source_item: ' || r::text;
    assert pg_temp.raises($q$select workspace.source_item_record('sub-nobody', '{"source":"drive","source_id":"x","body":"x"}')$q$, '42501'), 'unknown subject';

    -- Bad items and unknown accounts are refused.
    assert pg_temp.raises(format('select workspace.fireflies_hook_record(%L, %L)', gen_random_uuid(), item), '22023'), 'unknown account';
    assert pg_temp.raises(format('select workspace.fireflies_hook_record(%L, %L)', v_acct, '[]'), '22023'), 'not an object';
    assert pg_temp.raises(format('select workspace.fireflies_hook_record(%L, %L)', v_acct,
        jsonb_set(item, '{body}', to_jsonb(repeat('x', 500001)))), '22023'), 'over the limit is refused, never cut';
end $$;
reset role;

do $$
declare
    v_acct uuid := current_setting('ff.acct')::uuid;
begin
    assert (select count(*) from workspace.source_items s where s.account_id = v_acct and s.source = 'fireflies') = 2, 'two versions of one meeting';
    assert (select bool_and(s.owner_principal_id = a.owner_principal_id and s.topics = array[]::text[]
                            and (s.metadata->>'private')::boolean)
            from workspace.source_items s join workspace.source_accounts a on a.id = s.account_id
            where s.account_id = v_acct), 'owner and private topic from the rule, not the delivery';
    assert (select items_skipped from workspace.source_accounts where id = v_acct) = 1, 'the left-out meeting counted';
end $$;

-- 4. Delivery bookkeeping ---------------------------------------------------------
set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('ff.acct')::uuid;
    r jsonb;
begin
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET01', 'meeting.summarized', null) = 'fetch', 'first delivery fetches';
    perform workspace.fireflies_delivery_end(v_acct, 'MEET01', 'meeting.summarized', 'done', null, 1);
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET01', 'meeting.summarized', null) = 'skip', 'a repeat is skipped';
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET01', 'backfill', null) = 'skip', 'backfill skips what is done';
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET01', 'meeting.summarized', 1700000000000) = 'fetch', 'a newer re-send fetches';
    perform workspace.fireflies_delivery_end(v_acct, 'MEET01', 'meeting.summarized', 'done', null, 1);
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET01', 'meeting.summarized', 1700000000000) = 'skip', 'the same re-send is skipped';
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET01', 'meeting.transcribed', null) = 'fetch', 'another event fetches';
    perform workspace.fireflies_delivery_end(v_acct, 'MEET01', 'meeting.transcribed', 'done', null, 2);
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET01', 'retry', null) = 'fetch', 'retry always fetches';
    perform workspace.fireflies_delivery_end(v_acct, 'MEET01', 'retry', 'done', null, 2);

    -- A failed fetch is missed (with a reason code, never text); a test id Fireflies does not know is not.
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET03', 'meeting.summarized', null) = 'fetch';
    perform workspace.fireflies_delivery_end(v_acct, 'MEET03', 'meeting.summarized', 'failed', 'Some Error Text!', null);
    assert workspace.fireflies_delivery_begin(v_acct, 'TEST01', 'meeting.summarized', null) = 'fetch';
    perform workspace.fireflies_delivery_end(v_acct, 'TEST01', 'meeting.summarized', 'not_found', null, null);
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET04', 'meeting.summarized', null) = 'fetch';
    assert workspace.fireflies_delivery_begin(v_acct, 'MEET04', 'meeting.summarized', null) = 'skip', 'a retried delivery waits for the fetch running';

    assert pg_temp.raises(format('select workspace.fireflies_delivery_begin(%L, %L, %L, null)', v_acct, 'bad id!', 'x'), '22023'), 'bad meeting id';
    assert pg_temp.raises(format('select workspace.fireflies_delivery_begin(%L, %L, %L, null)', gen_random_uuid(), 'M1', 'x'), '22023'), 'not connected';
    assert pg_temp.raises(format('select workspace.fireflies_delivery_end(%L, %L, %L, %L, null, null)', v_acct, 'M1', 'x', 'odd'), '22023'), 'bad status';
end $$;
reset role;

do $$
declare
    v_acct uuid := current_setting('ff.acct')::uuid;
begin
    assert (select reason from workspace.fireflies_deliveries where meeting_id = 'MEET03') = 'failed', 'free text never stored as a reason';
    assert (select parts from workspace.fireflies_deliveries where meeting_id = 'MEET01') = 2, 'parts kept';
    -- MEET04 has been pending for an hour: the process stopped mid-fetch.
    update workspace.fireflies_deliveries set updated_at = now() - interval '1 hour' where meeting_id = 'MEET04';
end $$;

set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('ff.acct')::uuid;
    r jsonb;
begin
    r := workspace.app_fireflies_missed('ff-ann@example.com', v_acct);
    assert r = '["MEET03", "MEET04"]'::jsonb, 'failed and stale pending are missed: ' || r::text;

    r := workspace.app_fireflies_get('ff-ann@example.com', v_acct);
    assert (r->>'connected')::boolean and r->>'key_last4' = 'WXYZ' and r->>'hook_id' = 'hookhookhookhookhookhookhookhook', r::text;
    assert (r->>'missed')::int = 2 and (r->>'done')::int = 1, 'counts: ' || r::text;
    assert r->>'first_delivery_at' is null, 'no delivery yet';
    assert not (r ? 'api_key') and not (r::text like '%kbe_ff_key%'), 'the key never comes back';

    perform workspace.fireflies_hook_seen(v_acct, 'meeting.summarized');
    r := workspace.app_fireflies_get('ff-ann@example.com', v_acct);
    assert r->>'first_delivery_at' is not null and r->>'last_event' = 'meeting.summarized', 'webhook working: ' || r::text;

    -- Another person, an administrator included, is refused.
    assert pg_temp.raises(format('select workspace.app_fireflies_get(%L, %L)', 'ff-bob@example.com', v_acct), '42501'), 'admin get';
    assert pg_temp.raises(format('select workspace.app_fireflies_missed(%L, %L)', 'ff-bob@example.com', v_acct), '42501'), 'admin missed';
    assert pg_temp.raises(format('select workspace.app_fireflies_disconnect(%L, %L)', 'ff-bob@example.com', v_acct), '42501'), 'admin disconnect';

    -- The ingest plan's skip signal.
    assert workspace.source_webhook_connected('sub-ff-ann', 'fireflies', 'Ann@Meet.example'), 'connected';
    assert not workspace.source_webhook_connected('sub-ff-bob', 'fireflies', 'ann@meet.example'), 'not Bob''s';
    assert not workspace.source_webhook_connected('sub-ff-ann', 'gmail', 'ann@meet.example'), 'gmail never';
    assert not workspace.source_webhook_connected('sub-ff-ann', 'fireflies', 'other@meet.example'), 'other account';

    -- Unknown and malformed webhook ids find nothing.
    assert workspace.fireflies_hook_lookup('nope') is null, 'malformed';
    assert workspace.fireflies_hook_lookup('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz') is null, 'unknown';
end $$;
reset role;

-- 5. With Supabase Vault: connect, lookup, disconnect --------------------------------
do $$
declare
    r      jsonb;
    v_acct uuid;
    v_key  text := 'ff-test-key-' || repeat('a', 20) || 'LAST';
begin
    if to_regclass('vault.secrets') is null then
        raise notice 'vault absent: Fireflies connect checks skipped';
        assert pg_temp.raises(format('select workspace.app_fireflies_connect(%L, %L, %L, %L, %L)',
            'ff-web@example.com', 'web@meet.example', v_key, repeat('h', 32), repeat('s', 32)), '55000'), 'needs vault';
        return;
    end if;
    -- A person who never connected Claude (no OAuth subject) can still connect.
    r := workspace.app_fireflies_connect('ff-web@example.com', 'Web@Meet.example', v_key, repeat('h', 32), repeat('s', 32));
    v_acct := (r->>'account_id')::uuid;
    assert r->>'account' = 'web@meet.example' and (r->>'new')::boolean, r::text;
    assert (select key_last4 from workspace.fireflies_hooks where account_id = v_acct) = 'LAST', 'last 4 only';
    assert not exists (select 1 from workspace.fireflies_hooks h where row_to_json(h)::text like '%' || v_key || '%'), 'no key in the table';
    assert workspace.fireflies_hook_api_key(v_acct) = v_key, 'key in the vault';
    r := workspace.fireflies_hook_lookup(repeat('h', 32));
    assert r->>'account_id' = v_acct::text and r->>'secret' = repeat('s', 32), 'lookup: ' || r::text;
    assert (workspace.app_fireflies_get('ff-web@example.com', v_acct)->>'secret') = repeat('s', 32), 'owner sees the secret';

    -- Reconnecting replaces the key and keeps the URL and the secret Fireflies holds.
    r := workspace.app_fireflies_connect('ff-web@example.com', 'web@meet.example', v_key || 'NEW1', repeat('k', 32), repeat('t', 32));
    assert not (r->>'new')::boolean, 'same account';
    assert (select hook_id from workspace.fireflies_hooks where account_id = v_acct) = repeat('h', 32), 'url kept';
    assert (workspace.fireflies_hook_lookup(repeat('h', 32))->>'secret') = repeat('s', 32), 'secret kept';
    assert workspace.fireflies_hook_api_key(v_acct) = v_key || 'NEW1', 'key replaced';

    -- The owner (no OAuth subject) gets the delivered meeting through the same path.
    perform workspace.app_source_rules_save('ff-web@example.com', v_acct,
        '[{"kind":"include","name":"All","match":{"participants":["@acme.example"]},"private":true}]', 0);
    r := workspace.fireflies_hook_record(v_acct, '{"source_id":"W1","body":"x","provider":{"meeting_id":"W1","participants":["a@acme.example"]}}');
    assert r->>'status' = 'new', 'web-only owner: ' || r::text;

    assert pg_temp.raises(format('select workspace.app_fireflies_connect(%L, %L, %L, %L, %L)',
        'ff-web@example.com', 'web@meet.example', 'has space key', repeat('h', 32), repeat('s', 32)), '22023'), 'bad key';
    assert pg_temp.raises(format('select workspace.app_fireflies_connect(%L, %L, %L, %L, %L)',
        'ff-web@example.com', 'web@meet.example', v_key, 'short', repeat('s', 32)), '22023'), 'bad hook id';
    assert pg_temp.raises(format('select workspace.app_fireflies_connect(%L, %L, %L, %L, %L)',
        'ff-web@example.com', 'web@meet.example', v_key, repeat('h', 32), 'short'), '22023'), 'bad secret';

    assert workspace.app_fireflies_disconnect('ff-web@example.com', v_acct), 'disconnected';
    assert workspace.fireflies_hook_lookup(repeat('h', 32)) is null, 'the url stops working';
    assert (select count(*) from vault.secrets where name in ('kbe_ff_key_' || v_acct, 'kbe_ff_sig_' || v_acct)) = 0, 'vault cleared';
    assert exists (select 1 from workspace.source_accounts where id = v_acct), 'the account stays';
    assert (select count(*) from workspace.source_rule_audit where account_id = v_acct and action = 'webhook') = 3, 'audited';
end $$;

rollback;
