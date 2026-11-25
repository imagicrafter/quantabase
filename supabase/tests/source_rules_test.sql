-- source_rules_test.sql -- checks for migration 0063 (source inclusion rules).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
-- WHAT IS UNDER TEST
--   * the rule tables are closed (RLS, no grants); functions are kb_engine only
--   * default-deny: an item no rule includes is not stored (counted only)
--   * the topic comes from the rule; a topic or owner the plugin claims is ignored
--   * exclude rules always win; include rules are first-match in order
--   * a label is matched by id: renaming it is safe; a deleted label makes the
--     rule broken and it ingests nothing
--   * a rule maps only to a topic its author holds (or private)
--   * private rule => owner-only item
--   * a person reads and edits only their own accounts and rules; an
--     administrator sees only their own rules and a count for others
--   * narrowing a rule re-files existing items owner-only and flags their pages
--   * rule sets are append-only versions with an audit trail
--   * one page per topic: an item never writes into a page of another topic

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
    ('sr-acme', 'Acme', false),
    ('sr-board', 'Board', false),
    ('sr-other', 'Other', false)
on conflict (domain) do nothing;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('sr-ann', 'Ann Owner', 'reader', 'sr-ann@example.com', true, 'sub-sr-ann', 'tok-sr-ann'),
    ('sr-eve', 'Eve Peer',  'reader', 'sr-eve@example.com', true, 'sub-sr-eve', 'tok-sr-eve'),
    ('sr-adm', 'Ada Admin', 'administrator', 'sr-adm@example.com', true, 'sub-sr-adm', 'tok-sr-adm');

insert into workspace.access_grants (principal_id, domain)
select p.id, d from workspace.principals p, unnest(array['sr-acme', 'sr-board']) d where p.handle = 'sr-ann';
insert into workspace.access_grants (principal_id, domain)
select p.id, 'sr-other' from workspace.principals p where p.handle = 'sr-eve';

-- 1. Privileges ---------------------------------------------------------------
do $$
begin
    assert (select relrowsecurity from pg_class where oid = 'workspace.source_accounts'::regclass), 'source_accounts RLS';
    assert not has_table_privilege('kb_engine', 'workspace.source_accounts', 'select'), 'source_accounts kb_engine';
    assert not has_table_privilege('anon', 'workspace.source_accounts', 'select'), 'source_accounts anon';
    assert not has_table_privilege('authenticated', 'workspace.source_accounts', 'select'), 'source_accounts authenticated';
    assert (select relrowsecurity from pg_class where oid = 'workspace.source_account_labels'::regclass), 'source_account_labels RLS';
    assert not has_table_privilege('kb_engine', 'workspace.source_account_labels', 'select'), 'source_account_labels kb_engine';
    assert not has_table_privilege('anon', 'workspace.source_account_labels', 'select'), 'source_account_labels anon';
    assert not has_table_privilege('authenticated', 'workspace.source_account_labels', 'select'), 'source_account_labels authenticated';
    assert (select relrowsecurity from pg_class where oid = 'workspace.source_rule_sets'::regclass), 'source_rule_sets RLS';
    assert not has_table_privilege('kb_engine', 'workspace.source_rule_sets', 'select'), 'source_rule_sets kb_engine';
    assert not has_table_privilege('anon', 'workspace.source_rule_sets', 'select'), 'source_rule_sets anon';
    assert not has_table_privilege('authenticated', 'workspace.source_rule_sets', 'select'), 'source_rule_sets authenticated';
    assert (select relrowsecurity from pg_class where oid = 'workspace.source_rule_audit'::regclass), 'source_rule_audit RLS';
    assert not has_table_privilege('kb_engine', 'workspace.source_rule_audit', 'select'), 'source_rule_audit kb_engine';
    assert not has_table_privilege('anon', 'workspace.source_rule_audit', 'select'), 'source_rule_audit anon';
    assert not has_table_privilege('authenticated', 'workspace.source_rule_audit', 'select'), 'source_rule_audit authenticated';
    assert (select relrowsecurity from pg_class where oid = 'workspace.source_candidates'::regclass), 'source_candidates RLS';
    assert not has_table_privilege('kb_engine', 'workspace.source_candidates', 'select'), 'source_candidates kb_engine';
    assert not has_table_privilege('anon', 'workspace.source_candidates', 'select'), 'source_candidates anon';
    assert not has_table_privilege('authenticated', 'workspace.source_candidates', 'select'), 'source_candidates authenticated';
    assert has_function_privilege('kb_engine', 'workspace.source_ingest_plan(text, text, text)', 'execute'), 'plan';
    assert has_function_privilege('kb_engine', 'workspace.source_candidates_report(text, text, text, jsonb, jsonb, boolean)', 'execute'), 'report';
    assert has_function_privilege('kb_engine', 'workspace.app_source_rules_save(text, uuid, jsonb, integer)', 'execute'), 'save';
    assert not has_function_privilege('anon', 'workspace.app_source_rules_save(text, uuid, jsonb, integer)', 'execute'), 'anon save';
    assert not has_function_privilege('kb_ingest', 'workspace.app_source_rules_save(text, uuid, jsonb, integer)', 'execute'), 'ingest save';
    assert not has_function_privilege('kb_engine', 'workspace._source_rules_eval(text, jsonb, jsonb, text[], text[])', 'execute'), 'eval hidden';
    -- topics are made by administrators only: the tag switch is gone, the admin add is back
    assert not has_function_privilege('kb_engine', 'workspace.app_source_tag_set(text, uuid, boolean, boolean)', 'execute'), 'tag switch gone';
    assert has_function_privilege('kb_engine', 'workspace.app_topic_add(text, text, text, boolean)', 'execute'), 'admin topic add';
end $$;

-- 2. Accounts, labels and the plan --------------------------------------------
set local role kb_engine;
do $$
declare
    p jsonb;
    r jsonb;
begin
    p := workspace.source_ingest_plan('sub-sr-ann', 'gmail', 'Ann@Work.example');
    assert p->>'account' = 'ann@work.example', p::text;
    assert jsonb_array_length(p->'rules') = 0, 'no rules yet';
    assert (p->>'sample_requested')::boolean, 'a new account asks for a metadata sample';

    -- The run reports the account's labels and a metadata sample.
    r := workspace.source_candidates_report('sub-sr-ann', 'gmail', 'ann@work.example',
        jsonb_build_array(
            jsonb_build_object('message_id', 'm-c1', 'thread_id', 't-c1', 'from', 'Bob <bob@acme.com>',
                               'to', jsonb_build_array('ann@work.example'), 'label_ids', jsonb_build_array('Label_1'),
                               'date', (now() - interval '1 day')::text),
            jsonb_build_object('message_id', 'm-c2', 'thread_id', 't-c2', 'from', 'news@shop.example',
                               'to', jsonb_build_array('ann@work.example'), 'label_ids', jsonb_build_array('Label_9'),
                               'date', (now() - interval '2 day')::text)),
        jsonb_build_array(
            jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme'),
            jsonb_build_object('id', 'Label_2', 'name', 'Board'),
            jsonb_build_object('id', 'Label_9', 'name', 'Personal'),
            jsonb_build_object('id', 'INBOX', 'name', 'INBOX')),
        true);
    assert (r->>'candidates')::int = 2, r::text;
    assert (r->>'labels')::int = 3, 'system labels dropped: ' || r::text;

    -- Another person's report of the same address is their own account.
    p := workspace.source_ingest_plan('sub-sr-eve', 'gmail', 'ann@work.example');
    assert jsonb_array_length(p->'rules') = 0;
end $$;
reset role;

do $$
begin
    perform set_config('sr.acct', (select a.id from workspace.source_accounts a join workspace.principals p on p.id = a.owner_principal_id
                                   where p.handle = 'sr-ann' and a.account = 'ann@work.example')::text, true);
    perform set_config('sr.items', (select count(*) from workspace.source_items)::text, true);
end $$;

-- 3. Rules: validation, topic held, default excludes ---------------------------
set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('sr.acct')::uuid;
    r jsonb;
begin
    r := workspace.app_source_rules_get('sr-ann@example.com', v_acct);
    assert (r->>'version')::int = 0, r::text;
    assert jsonb_path_exists(r->'suggested_excludes', '$[*].match.labels[*] ? (@.name == "Personal")'), 'Personal suggested: ' || r::text;
    assert jsonb_path_exists(r->'topics', '$[*] ? (@ == "sr-acme")'), 'picker shows held topics';
    assert not jsonb_path_exists(r->'topics', '$[*] ? (@ == "sr-other")'), 'picker hides topics not held';

    -- A topic Ann does not hold is refused.
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{"any_address":["@acme.com"]},"topic":"sr-other"}]', 0)$q$, v_acct), '42501');
    -- An include needs a topic or private, not both.
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{"any_address":["@acme.com"]}}]', 0)$q$, v_acct), '22023');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{"any_address":["@acme.com"]},"topic":"sr-acme","private":true}]', 0)$q$, v_acct), '22023');
    -- An empty match, an unknown field and an unknown label are refused.
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{},"topic":"sr-acme"}]', 0)$q$, v_acct), '22023');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{"subject":["x"]},"topic":"sr-acme"}]', 0)$q$, v_acct), '22023');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{"labels":[{"id":"Label_404"}]},"topic":"sr-acme"}]', 0)$q$, v_acct), '22023');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{"channels":[{"id":"c"}]},"topic":"sr-acme"}]', 0)$q$, v_acct), '22023');
    -- A bad address is refused.
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L,
        '[{"kind":"include","match":{"from":["not an address"]},"topic":"sr-acme"}]', 0)$q$, v_acct), '22023');

    -- The real set: exclude Personal; Board label -> sr-board; acme.com -> sr-acme;
    -- a private rule for bob@acme.com placed AFTER acme (first match wins).
    r := workspace.app_source_rules_save('sr-ann@example.com', v_acct, jsonb_build_array(
        jsonb_build_object('kind', 'exclude', 'name', 'Personal', 'match', jsonb_build_object('labels', jsonb_build_array(jsonb_build_object('id', 'Label_9')))),
        jsonb_build_object('kind', 'include', 'name', 'Board', 'match', jsonb_build_object('labels', jsonb_build_array(jsonb_build_object('id', 'Label_2'))), 'topic', 'sr-board'),
        jsonb_build_object('kind', 'include', 'name', 'Acme', 'match', jsonb_build_object('any_address', jsonb_build_array('@ACME.com')), 'topic', 'sr-acme'),
        jsonb_build_object('kind', 'include', 'name', 'Bob', 'match', jsonb_build_object('from', jsonb_build_array('bob@acme.com')), 'private', true),
        jsonb_build_object('kind', 'include', 'name', 'Jo', 'match', jsonb_build_object('from', jsonb_build_array('jo@solo.example')), 'private', true)
    ), 0);
    assert (r->>'version')::int = 1, r::text;

    -- A stale expected version is refused.
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-ann@example.com', %L, '[]', 0)$q$, v_acct), '40001');

    r := workspace.app_source_rules_get('sr-ann@example.com', v_acct);
    assert jsonb_array_length(r->'rules') = 5;
    assert r->'rules'->2->'match'->'any_address'->>0 = '@acme.com', 'domain normalised';
    assert r->'rules'->1->'match'->'labels'->0->>'name' = 'Board', 'label name from the picker';
end $$;
reset role;

-- 4. record_source_item: default-deny, first match, exclude wins, claims ignored
set local role kb_engine;
do $$
declare
    r jsonb;
begin
    -- Mail under a source name the Engine does not know: refused (it would skip the rules).
    assert pg_temp.raises($q$select workspace.source_item_record('sub-sr-ann',
        '{"source":"mail","source_id":"m-x","body":"x"}')$q$, '22023');
    -- No account: refused (an old plugin must update rather than drop mail silently).
    assert pg_temp.raises($q$select workspace.source_item_record('sub-sr-ann',
        '{"source":"gmail","source_id":"m-x","body":"x"}')$q$, '22023');

    -- Matches nothing: not stored, body kept nowhere.
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-none', 'body', 'NOT-KEPT-BODY',
        'provider', jsonb_build_object('message_id', 'm-none', 'thread_id', 't-9', 'from', 'x@nowhere.example',
                                       'to', jsonb_build_array('ann@work.example'))));
    assert r->>'status' = 'not_included', r::text;
    assert r->>'id' is null;

    -- Acme mail: topic from the rule; the claimed topic and owner are ignored.
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-acme', 'body', 'hello from acme',
        'topics', jsonb_build_array('sr-other'), 'owner', 'sr-eve@example.com',
        'provider', jsonb_build_object('message_id', 'm-acme', 'thread_id', 't-1', 'from', 'Carol <carol@sales.acme.com>',
                                       'to', jsonb_build_array('ann@work.example'))));
    assert r->>'status' = 'new', r::text;

    -- bob@acme.com also matches the private rule, but Acme comes first: first match wins.
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-bob', 'body', 'bob here',
        'provider', jsonb_build_object('message_id', 'm-bob', 'from', 'bob@acme.com')));

    -- Private rule: owner-only.
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-jo', 'body', 'jo here',
        'provider', jsonb_build_object('message_id', 'm-jo', 'from', 'jo@solo.example')));
    assert r->>'status' = 'new', r::text;

    -- Acme mail carrying the Personal label: exclude wins over every include.
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-personal', 'body', 'PERSONAL-BODY',
        'provider', jsonb_build_object('message_id', 'm-personal', 'from', 'carol@acme.com',
                                       'label_ids', jsonb_build_array('Label_9', 'Label_2'))));
    assert r->>'status' = 'not_included' and r->>'reason' = 'excluded', r::text;

    -- Board label by id.
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-board', 'body', 'board pack',
        'provider', jsonb_build_object('message_id', 'm-board', 'from', 'chair@else.example',
                                       'label_ids', jsonb_build_array('Label_2'))));
    assert r->>'status' = 'new', r::text;

    -- Eve's account at the same address has no rules: her copy is not kept.
    r := workspace.source_item_record('sub-sr-eve', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-acme', 'body', 'hello from acme',
        'provider', jsonb_build_object('message_id', 'm-acme', 'from', 'carol@acme.com')));
    assert r->>'status' = 'not_included', 'rules are per person';
end $$;
reset role;

do $$
declare
    v_ann  uuid := (select id from workspace.principals where handle = 'sr-ann');
    v_item workspace.source_items%rowtype;
begin
    -- Nothing stored for the two items no rule kept (and Eve's copy).
    assert (select count(*) from workspace.source_items) = current_setting('sr.items')::bigint + 4, 'only included items stored';
    assert not exists (select 1 from workspace.source_items where body in ('NOT-KEPT-BODY', 'PERSONAL-BODY'));
    select * into v_item from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-acme';
    assert v_item.topics = array['sr-acme'], 'topic from the rule, claim ignored: ' || v_item.topics::text;
    assert v_item.rule_id is not null and v_item.rule_version = 1 and v_item.ruleset_version = 1, 'stamped';
    assert v_item.metadata->'provider'->>'thread_id' = 't-1', 'thread kept as context';
    assert not (v_item.metadata ? 'topics') and not (v_item.metadata ? 'owner');
    assert (select topics from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-bob') = array['sr-acme'], 'first match';
    select * into v_item from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-jo';
    assert v_item.topics = '{}'::text[] and (v_item.metadata->>'private')::boolean, 'private => owner only';
    assert (select topics from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-board') = array['sr-board'], 'label rule';
    assert not exists (select 1 from workspace.source_items s join workspace.principals p on p.id = s.owner_principal_id
                       where p.handle = 'sr-eve'), 'Eve kept nothing';
    -- Skips are counted on the account.
    assert (select a.items_skipped from workspace.source_accounts a where a.id = current_setting('sr.acct')::uuid) = 2, 'skipped counted';
end $$;

-- 5. Label rename is safe; a deleted label breaks its rule ----------------------
set local role kb_engine;
do $$
declare
    r jsonb;
    v_acct uuid := current_setting('sr.acct')::uuid;
begin
    -- Board renamed to "Board 2027": same id, the rule still matches.
    perform workspace.source_candidates_report('sub-sr-ann', 'gmail', 'ann@work.example', '[]'::jsonb,
        jsonb_build_array(jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme'),
                          jsonb_build_object('id', 'Label_2', 'name', 'Board 2027'),
                          jsonb_build_object('id', 'Label_9', 'name', 'Personal')), true);
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-board2', 'body', 'board pack 2',
        'provider', jsonb_build_object('message_id', 'm-board2', 'from', 'chair@else.example', 'label_ids', jsonb_build_array('Label_2'))));
    assert r->>'status' = 'new', 'rename safe: ' || r::text;
    r := workspace.app_source_rules_get('sr-ann@example.com', v_acct);
    assert r->'rules'->1->'match'->'labels'->0->>'name' = 'Board 2027', 'shows the new name';

    -- Board deleted (a complete label list without it): the rule is broken.
    perform workspace.source_candidates_report('sub-sr-ann', 'gmail', 'ann@work.example', '[]'::jsonb,
        jsonb_build_array(jsonb_build_object('id', 'Label_1', 'name', 'Clients/Acme'),
                          jsonb_build_object('id', 'Label_9', 'name', 'Personal')), true);
    r := workspace.source_item_record('sub-sr-ann', jsonb_build_object(
        'source', 'gmail', 'account', 'ann@work.example', 'source_id', 'm-board3', 'body', 'board pack 3',
        'provider', jsonb_build_object('message_id', 'm-board3', 'from', 'chair@else.example', 'label_ids', jsonb_build_array('Label_2'))));
    assert r->>'status' = 'not_included', 'broken rule ingests nothing: ' || r::text;
    r := workspace.app_source_rules_get('sr-ann@example.com', v_acct);
    assert (r->'rules'->1->>'broken')::boolean, 'marked broken';
    r := workspace.source_ingest_plan('sub-sr-ann', 'gmail', 'ann@work.example');
    assert (r->'rules'->1->>'broken')::boolean, 'plan says broken';
end $$;
reset role;

-- 6. Who sees whose rules -------------------------------------------------------
set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('sr.acct')::uuid;
    r jsonb;
begin
    assert pg_temp.raises(format($q$select workspace.app_source_rules_get('sr-eve@example.com', %L)$q$, v_acct), '42501');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-eve@example.com', %L, '[]', 1)$q$, v_acct), '42501');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_history('sr-eve@example.com', %L)$q$, v_acct), '42501');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_preview('sr-eve@example.com', %L, '[]')$q$, v_acct), '42501');
    -- An administrator cannot read or author another person's rules either.
    assert pg_temp.raises(format($q$select workspace.app_source_rules_get('sr-adm@example.com', %L)$q$, v_acct), '42501');
    assert pg_temp.raises(format($q$select workspace.app_source_rules_save('sr-adm@example.com', %L, '[]', 1)$q$, v_acct), '42501');

    -- Each list shows only the caller's own accounts.
    r := workspace.app_source_accounts_list('sr-eve@example.com');
    assert jsonb_array_length(r) = 1 and (r->0->>'rules')::int = 0, r::text;
    r := workspace.app_source_accounts_list('sr-ann@example.com');
    assert jsonb_array_length(r) = 1 and (r->0->>'rules')::int = 5, r::text;
    r := workspace.app_source_accounts_list('sr-adm@example.com');
    assert jsonb_array_length(r) = 0, 'admin has no accounts of their own';

    -- The administrator's people view: a count per person, never contents.
    r := workspace.app_people_rule_counts('sr-adm@example.com');
    assert (select (e->>'rules')::int from jsonb_array_elements(r) e where e->>'email' = 'sr-ann@example.com') = 5, r::text;
    assert not jsonb_path_exists(r, '$[*].match'), 'no rule contents';
    assert not jsonb_path_exists(r, '$[*].account'), 'no account names';
    assert pg_temp.raises($q$select workspace.app_people_rule_counts('sr-ann@example.com')$q$, '42501');
end $$;
reset role;

-- 7. Preview: metadata sample only, never stored --------------------------------
set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('sr.acct')::uuid;
    r jsonb;
begin
    r := workspace.app_source_rules_preview('sr-ann@example.com', v_acct,
        '[{"kind":"include","match":{"any_address":["@acme.com"]},"topic":"sr-acme"}]');
    assert (r->>'total')::int = 2, r::text;
    assert (r->>'included')::int = 1 and (r->>'not_included')::int = 1, r::text;
end $$;
reset role;

-- 8. Narrowing re-files and flags pages; widening is new items only ----------
do $$
declare
    v_ann  uuid := (select id from workspace.principals where handle = 'sr-ann');
    v_item uuid := (select id from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-acme');
    v_page uuid;
begin
    insert into workspace.pages (owner_principal_id, drawer, key, title, topics, body, content_hash)
    values (v_ann, 'organisations', 'acme.com', 'Acme', array['sr-acme'], '# Acme', 'h-acme')
    returning id into v_page;
    update workspace.source_items set curated_at = now(), curated_pages = array[v_page] where id = v_item;
end $$;

set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('sr.acct')::uuid;
    r jsonb;
    v_rules jsonb;
begin
    v_rules := workspace.app_source_rules_get('sr-ann@example.com', v_acct)->'rules';
    -- Move Acme from sr-acme to private: a narrowing.
    v_rules := jsonb_set(v_rules, '{2}', ((v_rules->2) - 'topic') || '{"private": true}');
    r := workspace.app_source_rules_save('sr-ann@example.com', v_acct, v_rules, 1);
    assert (r->>'version')::int = 2, r::text;
    assert (r->>'refiled')::int = 2, 'both acme items re-filed: ' || r::text;
    assert (r->>'pages_flagged')::int = 1, r::text;
end $$;
reset role;

do $$
declare
    v_ann uuid := (select id from workspace.principals where handle = 'sr-ann');
    v_item workspace.source_items%rowtype;
    v_hist jsonb;
begin
    select * into v_item from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-acme';
    assert v_item.topics = '{}'::text[], 'owner-only until re-checked';
    assert v_item.rule_state = 'recheck', v_item.rule_state;
    assert (select recheck_at is not null from workspace.pages where owner_principal_id = v_ann and key = 'acme.com'), 'page flagged';
    -- Board item untouched.
    assert (select topics from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-board') = array['sr-board'];
    -- Append-only versions and an audit line.
    assert (select count(*) from workspace.source_rule_sets s join workspace.source_accounts a on a.id = s.account_id
            where a.owner_principal_id = v_ann) = 2;
    assert pg_temp.raises($q$update workspace.source_rule_sets set rules = '[]'$q$), 'versions cannot be changed';
    assert pg_temp.raises($q$delete from workspace.source_rule_sets$q$), 'versions cannot be deleted';
end $$;

set local role kb_engine;
do $$
declare
    v_acct uuid := current_setting('sr.acct')::uuid;
    r jsonb;
    v_rules jsonb;
begin
    r := workspace.app_source_rules_history('sr-ann@example.com', v_acct);
    assert jsonb_array_length(r->'versions') = 2, r::text;
    assert jsonb_array_length(r->'audit') >= 2, r::text;

    -- Re-check files the item under its current rule (private) and clears the mark.
    r := workspace.app_source_recheck('sr-ann@example.com', v_acct);
    assert (r->>'refiled')::int = 2 and (r->>'removed')::int = 0, r::text;

    -- Widening (private -> sr-acme again) leaves existing items alone.
    v_rules := workspace.app_source_rules_get('sr-ann@example.com', v_acct)->'rules';
    v_rules := jsonb_set(v_rules, '{2}', ((v_rules->2) - 'private') || '{"topic": "sr-acme"}');
    r := workspace.app_source_rules_save('sr-ann@example.com', v_acct, v_rules, 2);
    assert (r->>'refiled')::int = 0, r::text;

    -- Backfill is the owner's choice and is audited.
    r := workspace.app_source_backfill('sr-ann@example.com', v_acct, now() - interval '30 days');
    r := workspace.source_ingest_plan('sub-sr-ann', 'gmail', 'ann@work.example');
    assert (r->>'backfill')::boolean, r::text;
end $$;
reset role;

do $$
declare
    v_ann uuid := (select id from workspace.principals where handle = 'sr-ann');
begin
    assert (select topics from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-acme') = '{}'::text[],
        'widening did not touch the existing item';
    assert (select rule_state from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-acme') is null, 'recheck done';
end $$;

-- 9. One topic per page: an item never writes into another topic's page -------
do $$
declare
    v_ann   uuid := (select id from workspace.principals where handle = 'sr-ann');
    v_board uuid := (select id from workspace.source_items where owner_principal_id = v_ann and source_id = 'm-board');
    r record;
begin
    -- acme.com exists in sr-acme; a Board item about acme.com gets its own page.
    select * into r from workspace.curator_page_save(v_board, jsonb_build_object(
        'drawer', 'organisations', 'key', 'acme.com', 'title', 'Acme', 'topics', jsonb_build_array('sr-board'),
        'body', '# Acme'), null);
    assert r.created, 'separate page in the other topic';
    assert (select count(*) from workspace.pages where owner_principal_id = v_ann and key = 'acme.com' and deleted_at is null) = 2;
    -- The candidates for the Board item never include the sr-acme page.
    assert not exists (select 1 from workspace.curator_candidates(v_board, array['acme.com'], 'acme', 8) c
                       where c.topics <> array['sr-board']), 'only same-topic pages offered';
    -- Nor an owner-only page.
    insert into workspace.pages (owner_principal_id, drawer, key, title, topics, body, content_hash)
    values (v_ann, 'organisations', 'private.example', 'Mine', '{}', '# Mine', 'h-mine');
    assert not exists (select 1 from workspace.curator_candidates(v_board, array['private.example'], 'mine', 8)), 'owner-only page not offered';
    -- And the Board item cannot write to the sr-acme page's topic.
    assert pg_temp.raises(format($q$select * from workspace.curator_page_save(%L,
        '{"drawer":"organisations","key":"x.example","title":"X","topics":["sr-acme"],"body":"# X"}')$q$, v_board), '22023');
end $$;

rollback;
