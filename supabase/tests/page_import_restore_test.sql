-- page_import_restore_test.sql -- checks for migration 0078.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * page_import is still granted to no API role
--   * every answer says whether it ran as a restore
--   * restore: true files a page that shares a name (or an address) with
--     another of the owner's pages; without it the page is "matched"
--   * restore never overwrites a key the person holds
--   * the flag is not stored on the page or in its history

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('pr-ann', 'Ann', 'reader', 'pr-ann@example.com', true, 'sub-pr-ann', 'tok-pr-ann');

do $$
declare
    v jsonb;
    v_page workspace.pages%rowtype;
begin
    assert not has_function_privilege('kb_engine', 'workspace.page_import(text, jsonb)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.page_import(text, jsonb)', 'execute');

    v := workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:ff-1', 'title', 'Weekly sync', 'body', 'one'));
    assert v->>'status' = 'created' and v->'restore' = 'false'::jsonb, v::text;

    -- the same name, no restore: matched to the first, nothing made
    v := workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:ff-2', 'title', 'Weekly sync', 'body', 'two'));
    assert v->>'status' = 'matched' and v->>'key' = 'meeting:ff-1' and v->'restore' = 'false'::jsonb, v::text;
    assert not exists (select 1 from workspace.pages where key = 'meeting:ff-2');

    -- the same name as a restore: filed under its own key
    v := workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:ff-2', 'title', 'Weekly sync', 'body', 'two', 'restore', true,
        'created', '2026-01-02', 'updated', '2026-01-03'));
    assert v->>'status' = 'created' and v->>'key' = 'meeting:ff-2' and v->'restore' = 'true'::jsonb, v::text;
    select * into v_page from workspace.pages where key = 'meeting:ff-2';
    assert v_page.body = 'two';
    assert v_page.created_at = '2026-01-02'::timestamptz, v_page.created_at::text;
    assert not (v_page.fields ? 'restore');
    assert not exists (select 1 from workspace.page_history h
                       where h.page_id = v_page.id and h.snapshot ? 'restore');

    -- a person page whose address another page already lists: filed as a restore
    perform workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'bo@example.com', 'title', 'Bo', 'body', 'x',
        'fields', jsonb_build_object('emails', jsonb_build_array('bo@work.example'))));
    v := workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'bo@work.example', 'title', 'Bo at work', 'body', 'y'));
    assert v->>'status' = 'matched', v::text;
    v := workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'bo@work.example', 'title', 'Bo at work', 'body', 'y', 'restore', true));
    assert v->>'status' = 'created', v::text;

    -- a key the person holds is never overwritten, restore or not
    v := workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:ff-1', 'title', 'Changed', 'body', 'changed', 'restore', true));
    assert v->>'status' = 'exists' and v->'restore' = 'true'::jsonb, v::text;
    assert (select body from workspace.pages where key = 'meeting:ff-1') = 'one';

    -- a non-boolean flag is not a restore
    v := workspace.page_import('pr-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:ff-3', 'title', 'Weekly sync', 'body', 'three', 'restore', 'yes'));
    assert v->>'status' = 'matched' and v->'restore' = 'false'::jsonb, v::text;
end;
$$;

rollback;
