-- indexing_failed_items_test.sql -- checks for migration 0066 (Indexing lists
-- failed items with their last error). One transaction, rolled back.

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('fi-boss', 'Boss', 'administrator', 'fi-boss@example.com', true, 'sub-fi-boss', 'tok-fi-boss'),
    ('fi-ann',  'Ann',  'reader',        'fi-ann@example.com',  true, 'sub-fi-ann',  'tok-fi-ann');

set local role kb_engine;
do $$
declare
    v_item uuid;
    v_ok   uuid;
    v jsonb;
begin
    v_item := (workspace.source_item_record('sub-fi-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'fi-1', 'title', 'Pilot SOW', 'body', 'x'))->>'id')::uuid;
    v_ok := (workspace.source_item_record('sub-fi-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'fi-2', 'title', 'Fine', 'body', 'y'))->>'id')::uuid;
    perform workspace.curator_item_done(v_item, 'failed', array[]::uuid[],
        'could not apply: the page has changed since it was read; read it again');
    perform workspace.curator_item_done(v_ok, 'no_change', array[]::uuid[]);

    v := workspace.app_indexing('fi-boss@example.com');
    assert jsonb_array_length(v->'failed_items') = 1, v::text;
    assert v->'failed_items'->0->>'title' = 'Pilot SOW', v::text;
    assert v->'failed_items'->0->>'source' = 'drive', v::text;
    assert v->'failed_items'->0->>'error' like '%page has changed%', v::text;
    assert (v->>'items_failed')::int = 1, v::text;
end $$;

rollback;
