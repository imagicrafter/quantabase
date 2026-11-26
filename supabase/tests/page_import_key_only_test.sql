-- page_import_key_only_test.sql -- checks for migration 0079.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * page_import is still granted to no API role
--   * every answer says whether it ran key-only
--   * key_only: true files a recurring meeting (same title, another meeting
--     id; or a date-slug key one day later) as its own page
--   * key_only never overwrites a key the person holds ("exists")
--   * re-running an import leaves the pages already there alone and files
--     the meeting an earlier, name-matching import dropped
--   * without the flag, name matching is unchanged (people by name)
--   * the flag is not stored on the page or in its history

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('ko-ann', 'Ann', 'reader', 'ko-ann@example.com', true, 'sub-ko-ann', 'tok-ko-ann');

do $$
declare
    v jsonb;
    v_page workspace.pages%rowtype;
    v_count integer;
begin
    assert not has_function_privilege('kb_engine', 'workspace.page_import(text, jsonb)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.page_import(text, jsonb)', 'execute');

    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:01ab', 'title', 'Pat / Sam sync-up', 'body', 'week one',
        'key_only', true));
    assert v->>'status' = 'created' and v->'key_only' = 'true'::jsonb, v::text;

    -- an older import (no flag) matched the next week's meeting by title
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:01cd', 'title', 'Pat / Sam sync-up', 'body', 'week two'));
    assert v->>'status' = 'matched' and v->>'key' = 'meeting:01ab' and v->'key_only' = 'false'::jsonb, v::text;
    assert not exists (select 1 from workspace.pages where key = 'meeting:01cd');

    -- the re-run: the first meeting is already there, the dropped one is made
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:01ab', 'title', 'Pat / Sam sync-up', 'body', 'changed',
        'key_only', true));
    assert v->>'status' = 'exists' and v->'key_only' = 'true'::jsonb, v::text;
    assert (select body from workspace.pages where key = 'meeting:01ab') = 'week one';
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:01cd', 'title', 'Pat / Sam sync-up', 'body', 'week two',
        'key_only', true, 'created', '2025-06-10', 'updated', '2025-06-10'));
    assert v->>'status' = 'created' and v->>'key' = 'meeting:01cd', v::text;
    select * into v_page from workspace.pages where key = 'meeting:01cd';
    assert v_page.body = 'week two';
    assert v_page.created_at = '2025-06-10'::timestamptz, v_page.created_at::text;
    assert not (v_page.fields ? 'key_only');
    assert not exists (select 1 from workspace.page_history h
                       where h.page_id = v_page.id and h.snapshot ? 'key_only');

    -- date-slug keys one day apart, same title: two meetings
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:2025-06-17-pat-sam-sync-up', 'title', 'Pat / Sam sync-up',
        'body', 'x', 'key_only', true));
    assert v->>'status' = 'created', v::text;
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:2025-06-18-pat-sam-sync-up', 'title', 'Pat / Sam sync-up',
        'body', 'y', 'key_only', true));
    assert v->>'status' = 'created', v::text;
    select count(*) into v_count from workspace.pages
    where owner_principal_id = (select id from workspace.principals where handle = 'ko-ann')
      and drawer = 'meetings' and deleted_at is null;
    assert v_count = 4, v_count::text;

    -- people still match by name without the flag
    perform workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'pat@example.com', 'title', 'Pat', 'body', 'x'));
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'person:pat', 'title', 'Pat', 'body', 'y'));
    assert v->>'status' = 'matched' and v->>'key' = 'pat@example.com' and v->'key_only' = 'false'::jsonb, v::text;

    -- a non-boolean flag is not key-only
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:01ef', 'title', 'Pat / Sam sync-up', 'body', 'z', 'key_only', 'yes'));
    assert v->>'status' = 'matched' and v->'key_only' = 'false'::jsonb, v::text;

    -- restore still answers as before, and now says key_only too
    v := workspace.page_import('ko-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:01ef', 'title', 'Pat / Sam sync-up', 'body', 'z', 'restore', true));
    assert v->>'status' = 'created' and v->'restore' = 'true'::jsonb and v->'key_only' = 'false'::jsonb, v::text;
end;
$$;

rollback;
