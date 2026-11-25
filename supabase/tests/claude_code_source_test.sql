-- claude_code_source_test.sql -- checks for migration 0076 (Claude Code session notes).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
-- WHAT IS UNDER TEST
--   * record_source_item takes source 'claude-code'; other new names are refused
--   * a session's project tag is noted switched off: the session stays with its
--     owner (no topic), and a claimed topic or owner is ignored
--   * the same note is 'unchanged'; a changed note is a new version of the
--     same id (the session id); another session is its own item; the parsed
--     note in metadata is kept
--   * a switched-on project tag files sessions under its topic, like Drive
--   * app_source_summary counts only the caller's own items, never text, and
--     is the service's only

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
    ('cc-projects', 'Projects', false)
on conflict (domain) do nothing;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('cc-ann', 'Ann Owner', 'reader', 'cc-ann@example.com', true, 'sub-cc-ann', 'tok-cc-ann'),
    ('cc-eve', 'Eve Peer',  'reader', 'cc-eve@example.com', true, 'sub-cc-eve', 'tok-cc-eve');

insert into workspace.access_grants (principal_id, domain)
select p.id, 'cc-projects' from workspace.principals p where p.handle = 'cc-ann';

-- 1. Privileges ---------------------------------------------------------------
do $$
begin
    assert has_function_privilege('kb_engine', 'workspace.app_source_summary(text, text)', 'execute'), 'kb_engine summary';
    assert not has_function_privilege('anon', 'workspace.app_source_summary(text, text)', 'execute'), 'anon summary';
    assert not has_function_privilege('authenticated', 'workspace.app_source_summary(text, text)', 'execute'), 'authenticated summary';
    assert not has_function_privilege('kb_ingest', 'workspace.app_source_summary(text, text)', 'execute'), 'kb_ingest summary';
    assert has_function_privilege('kb_engine', 'workspace.source_item_record(text, jsonb)', 'execute'), 'kb_engine record';
    assert not has_function_privilege('anon', 'workspace.source_item_record(text, jsonb)', 'execute'), 'anon record';
end $$;

-- 2. Recording sessions --------------------------------------------------------
set local role kb_engine;
do $$
declare
    r      jsonb;
    r2     jsonb;
    v_item record;
    v_tag  jsonb := '[{"kind":"project","id":"demo-project","name":"Demo-Project"}]'::jsonb;
begin
    r := workspace.source_item_record('sub-cc-ann', jsonb_build_object(
        'source', 'claude-code', 'source_id', 'sess-1', 'title', 'Plan the release',
        'body', '# Session note: demo-project', 'tags', v_tag,
        'source_created_at', '2026-11-24T10:05:30Z', 'cursor', '2026-11-24T10:05:30Z',
        'topics', '["cc-projects"]'::jsonb, 'owner', 'cc-eve@example.com',
        'metadata', '{"note":{"session_id":"sess-1","items":[{"label":"decided"}]}}'::jsonb));
    assert r->>'status' = 'new' and (r->>'version')::int = 1, r::text;
    select * into v_item from workspace.source_item_get('sub-cc-ann', (r->>'id')::uuid);
    assert v_item.source = 'claude-code', v_item.source;
    assert v_item.topics = '{}'::text[], 'a session stays with its owner: claimed topic ignored';
    assert v_item.metadata->'source_tags' = '["demo-project"]'::jsonb, v_item.metadata::text;
    assert v_item.metadata->'note'->>'session_id' = 'sess-1', 'the parsed note is kept';

    -- Sent again unchanged: nothing new.
    r2 := workspace.source_item_record('sub-cc-ann', jsonb_build_object(
        'source', 'claude-code', 'source_id', 'sess-1',
        'body', '# Session note: demo-project', 'tags', v_tag));
    assert r2->>'status' = 'unchanged' and r2->>'id' = r->>'id', r2::text;

    -- Sent again after more work: a new version, not a copy.
    r2 := workspace.source_item_record('sub-cc-ann', jsonb_build_object(
        'source', 'claude-code', 'source_id', 'sess-1',
        'body', '# Session note: demo-project (one more item)', 'tags', v_tag));
    assert r2->>'status' = 'new_version' and (r2->>'version')::int = 2, r2::text;

    -- Another session is its own item.
    r2 := workspace.source_item_record('sub-cc-ann', jsonb_build_object(
        'source', 'claude-code', 'source_id', 'sess-3', 'body', 'another note', 'tags', v_tag));
    assert r2->>'status' = 'new', r2::text;

    -- Eve's session is hers.
    perform workspace.source_item_record('sub-cc-eve', jsonb_build_object(
        'source', 'claude-code', 'source_id', 'sess-9', 'body', 'eve session', 'tags', v_tag));

    -- Only the names the Engine knows.
    assert pg_temp.raises($q$select workspace.source_item_record('sub-cc-ann',
        '{"source":"claude-ai","source_id":"x","body":"x"}'::jsonb)$q$, '22023');
    assert pg_temp.raises($q$select workspace.source_item_record('sub-cc-ann',
        '{"source":"claude","source_id":"x","body":"x"}'::jsonb)$q$, '22023');
end $$;
reset role;

do $$
begin
    assert (select count(*) from workspace.source_tags t join workspace.principals p on p.id = t.owner_principal_id
            where p.handle = 'cc-ann' and t.source = 'claude-code' and t.tag_id = 'demo-project'
              and t.kind = 'project' and not t.enabled) = 1, 'project tag noted, switched off';
end $$;

-- 3. A switched-on project files new sessions under its topic -----------------
update workspace.source_tags t set enabled = true, topic = 'cc-projects'
from workspace.principals p
where p.id = t.owner_principal_id and p.handle = 'cc-ann' and t.source = 'claude-code';

set local role kb_engine;
do $$
declare
    r      jsonb;
    v_item record;
begin
    r := workspace.source_item_record('sub-cc-ann', jsonb_build_object(
        'source', 'claude-code', 'source_id', 'sess-2', 'body', 'filed session',
        'tags', '[{"kind":"project","id":"demo-project","name":"Demo-Project"}]'::jsonb));
    select * into v_item from workspace.source_item_get('sub-cc-ann', (r->>'id')::uuid);
    assert v_item.topics = array['cc-projects'], v_item.topics::text;
end $$;

-- 4. The Subscriptions summary: own items, counts only ------------------------
set local role kb_engine;
do $$
declare
    s jsonb;
begin
    s := workspace.app_source_summary('cc-ann@example.com', 'claude-code');
    assert (s->>'items')::int = 3, s::text;          -- sess-1, sess-3, sess-2
    assert (s->>'versions')::int = 4, s::text;       -- sess-1 has two versions
    assert s->>'last_received_at' is not null, s::text;
    assert s ?& array['source', 'items', 'versions', 'last_received_at'] and (select count(*) from jsonb_object_keys(s)) = 4,
        'counts only, no text';
    s := workspace.app_source_summary('cc-eve@example.com', 'CLAUDE-CODE');
    assert (s->>'items')::int = 1, s::text;
    s := workspace.app_source_summary('cc-eve@example.com', 'gmail');
    assert (s->>'items')::int = 0 and s->>'last_received_at' is null, s::text;
    assert pg_temp.raises($q$select workspace.app_source_summary('cc-ann@example.com', 'drop table; --')$q$, '22023');
    assert pg_temp.raises($q$select workspace.app_source_summary('nobody@example.com', 'claude-code')$q$, '42501');
end $$;
reset role;

rollback;
