-- mail_contacts_test.sql -- checks for migration 0080 (suggested rules from mail).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
-- WHAT IS UNDER TEST
--   * the suggestions table is closed (RLS, no grants); the two functions are
--     kb_engine only
--   * a report is stored for the caller's OWN Gmail account (made on first
--     use), counts only; a new report replaces the old one
--   * Fireflies accounts, bad values, bad counts and oversize reports are refused
--   * free-mail domains are never stored as a domain
--   * a person reads only their own account's suggestions; another person
--     (an administrator included) is refused
--   * the owner's picks from Claude (chosen) are kept as true / false / null
--   * the report is in the account's audit

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
    ('mc-ann', 'Ann Owner', 'reader', 'mc-ann@example.com', true, 'sub-mc-ann', 'tok-mc-ann'),
    ('mc-adm', 'Ada Admin', 'administrator', 'mc-adm@example.com', true, 'sub-mc-adm', 'tok-mc-adm');

-- 1. Privileges ---------------------------------------------------------------
do $$
begin
    assert (select relrowsecurity from pg_class where oid = 'workspace.source_contact_suggestions'::regclass), 'RLS on';
    assert not has_table_privilege('kb_engine', 'workspace.source_contact_suggestions', 'select'), 'kb_engine table';
    assert not has_table_privilege('anon', 'workspace.source_contact_suggestions', 'select'), 'anon table';
    assert not has_table_privilege('authenticated', 'workspace.source_contact_suggestions', 'select'), 'authenticated table';
    assert has_function_privilege('kb_engine', 'workspace.source_contacts_report(text, text, integer, integer, jsonb)', 'execute'), 'kb_engine report';
    assert not has_function_privilege('anon', 'workspace.source_contacts_report(text, text, integer, integer, jsonb)', 'execute'), 'anon report';
    assert not has_function_privilege('authenticated', 'workspace.source_contacts_report(text, text, integer, integer, jsonb)', 'execute'), 'authenticated report';
    assert has_function_privilege('kb_engine', 'workspace.app_source_contacts_get(text, uuid)', 'execute'), 'kb_engine get';
    assert not has_function_privilege('anon', 'workspace.app_source_contacts_get(text, uuid)', 'execute'), 'anon get';
    assert not has_function_privilege('authenticated', 'workspace.app_source_contacts_get(text, uuid)', 'execute'), 'authenticated get';
end $$;

-- 2. Reporting and reading -------------------------------------------------------
set local role kb_engine;
do $$
declare
    r     jsonb;
    v_acc uuid;
    rows  jsonb := '[
        {"kind": "address", "value": "bob@acme.example", "sent_to": 5, "received_from": 2, "threads": 3, "replied": 1, "people": 1, "free_mail": false, "chosen": true, "last_seen": "2026-11-20T10:00:00Z"},
        {"kind": "address", "value": "pat@gmail.com", "sent_to": 1, "received_from": 0, "threads": 1, "replied": 0, "people": 1, "free_mail": true, "last_seen": null},
        {"kind": "domain", "value": "acme.example", "sent_to": 6, "received_from": 2, "threads": 4, "replied": 1, "people": 2, "free_mail": false, "chosen": false, "last_seen": "2026-11-20T10:00:00Z"},
        {"kind": "domain", "value": "gmail.com", "sent_to": 1, "received_from": 0, "threads": 1, "replied": 0, "people": 1, "free_mail": false, "last_seen": null}
    ]';
begin
    r := workspace.source_contacts_report('sub-mc-ann', 'MC-Ann@Work.example', 90, 40, rows);
    assert (r->>'addresses')::int = 2, 'two people stored: ' || r::text;
    assert (r->>'domains')::int = 1, 'free-mail domain never stored: ' || r::text;

    -- The account was made on first use; the plan names its id.
    v_acc := (workspace.source_ingest_plan('sub-mc-ann', 'gmail', 'mc-ann@work.example')->>'account_id')::uuid;
    assert v_acc is not null, 'the account was made on first use';

    r := workspace.app_source_contacts_get('mc-ann@example.com', v_acc);
    assert (r->>'days')::int = 90 and (r->>'messages')::int = 40, 'window and count: ' || r::text;
    assert r->>'reported_at' is not null, 'reported_at';
    assert jsonb_array_length(r->'contacts') = 3, 'three rows';
    assert r->'contacts'->0->>'value' = 'acme.example', 'strongest first: ' || (r->'contacts')::text;
    assert (r->'contacts'->1->>'sent_to')::int = 5, 'counts kept';
    assert not exists (select 1 from jsonb_array_elements(r->'contacts') c
                       where c ? 'subject' or c ? 'name' or c ? 'message_id'), 'counts only';
    assert (r->'contacts'->0->>'chosen')::boolean = false, 'acme left unpicked: ' || (r->'contacts')::text;
    assert (r->'contacts'->1->>'chosen')::boolean = true, 'bob picked';
    assert r->'contacts'->2->'chosen' = 'null'::jsonb, 'no choice made: null';

    -- A new report replaces the old one.
    r := workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 30, 5,
        '[{"kind": "domain", "value": "beta.example", "sent_to": 1, "received_from": 1, "threads": 1, "replied": 0, "people": 1}]');
    r := workspace.app_source_contacts_get('mc-ann@example.com', v_acc);
    assert jsonb_array_length(r->'contacts') = 1 and r->'contacts'->0->>'value' = 'beta.example', 'replaced: ' || r::text;
    assert (r->>'days')::int = 30, 'new window';

    -- An empty report clears the suggestions.
    r := workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 30, 0, '[]');
    r := workspace.app_source_contacts_get('mc-ann@example.com', v_acc);
    assert jsonb_array_length(r->'contacts') = 0, 'cleared';
end $$;

-- 3. Refusals --------------------------------------------------------------------
do $$
declare
    v_acc  uuid;
    v_many jsonb;
begin
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-nobody', 'x@work.example', 90, 1, '[]')$q$, '42501'), 'unknown subject';
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-mc-ann', 'not an address', 90, 1, '[]')$q$, '22023'), 'bad account';
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 0, 1, '[]')$q$, '22023'), 'days 0';
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 90, 1, '{}')$q$, '22023'), 'not a list';
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 90, 1,
        '[{"kind": "address", "value": "Bob Smith", "sent_to": 1, "received_from": 0, "threads": 1, "replied": 0}]')$q$, '22023'), 'bad address';
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 90, 1,
        '[{"kind": "label", "value": "x.example", "sent_to": 1, "received_from": 0, "threads": 1, "replied": 0}]')$q$, '22023'), 'bad kind';
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 90, 1,
        '[{"kind": "domain", "value": "x.example", "sent_to": -1, "received_from": 0, "threads": 1, "replied": 0}]')$q$, '22023'), 'negative count';
    assert pg_temp.raises($q$select workspace.source_contacts_report('sub-mc-ann', 'mc-ann@work.example', 90, 1,
        '[{"kind": "domain", "value": "x.example", "sent_to": 1, "received_from": 0, "threads": 1, "replied": 0, "chosen": "yes"}]')$q$, '22023'), 'chosen not a boolean';
    select jsonb_agg(jsonb_build_object('kind', 'address', 'value', 'p' || g || '@acme.example',
                                        'sent_to', 1, 'received_from', 0, 'threads', 1, 'replied', 0))
      into v_many from generate_series(1, 801) g;
    assert pg_temp.raises(format('select workspace.source_contacts_report(%L, %L, 90, 1, %L)',
        'sub-mc-ann', 'mc-ann@work.example', v_many), '22023'), 'too many rows';

    -- Fireflies accounts have no mail to suggest from.
    v_acc := (workspace.source_ingest_plan('sub-mc-ann', 'fireflies', 'mc-ann@work.example')->>'account_id')::uuid;
    assert pg_temp.raises(format('select workspace.app_source_contacts_get(%L, %L)', 'mc-ann@example.com', v_acc), '22023'), 'fireflies get';

    -- Another person, an administrator included, cannot read Ann's suggestions.
    v_acc := (workspace.source_ingest_plan('sub-mc-ann', 'gmail', 'mc-ann@work.example')->>'account_id')::uuid;
    assert pg_temp.raises(format('select workspace.app_source_contacts_get(%L, %L)', 'mc-adm@example.com', v_acc), '42501'), 'admin refused';
    assert pg_temp.raises(format('select workspace.app_source_contacts_get(%L, %L)', 'nobody@example.com', v_acc), '42501'), 'stranger refused';
end $$;

-- 4. Audit ------------------------------------------------------------------------
reset role;
do $$
begin
    assert (select count(*) from workspace.source_rule_audit au
            join workspace.source_accounts a on a.id = au.account_id
            join workspace.principals p on p.id = a.owner_principal_id
            where p.handle = 'mc-ann' and au.action = 'contacts_reported') = 3, 'three reports audited';
    assert not exists (select 1 from workspace.source_rule_audit au
                       where au.action = 'contacts_reported' and au.detail::text like '%acme%'), 'audit holds counts only';
end $$;

rollback;
