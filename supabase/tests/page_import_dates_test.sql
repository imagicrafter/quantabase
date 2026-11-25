-- page_import_dates_test.sql -- checks for migration 0074.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * page_import is still granted to no API role
--   * created/updated become created_at/updated_at and the history saved_at
--   * bad, future or backwards dates are refused
--   * attendees: email first, then one name or alias; else fields.attendees

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
        raise exception 'expected SQLSTATE % but got % (%) for: %', p_state, sqlstate, sqlerrm, p_sql;
    end if;
    return true;
end;
$$;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('pi-ann', 'Ann', 'reader', 'pi-ann@example.com', true, 'sub-pi-ann', 'tok-pi-ann');

do $$
declare
    v jsonb;
    v_page workspace.pages%rowtype;
begin
    assert not has_function_privilege('kb_engine', 'workspace.page_import(text, jsonb)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.page_import(text, jsonb)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace._import_attendee_key(uuid, text)', 'execute');

    -- dates kept
    v := workspace.page_import('pi-ann@example.com', jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:old-note', 'title', 'Old note', 'body', 'x',
        'created', '2024-03-01', 'updated', '2025-01-15T10:00:00Z'));
    assert v->>'status' = 'created', v::text;
    select * into v_page from workspace.pages where key = 'concept:old-note';
    assert v_page.created_at = '2024-03-01'::timestamptz, v_page.created_at::text;
    assert v_page.updated_at = '2025-01-15T10:00:00Z'::timestamptz, v_page.updated_at::text;
    assert (select saved_at from workspace.page_history where page_id = v_page.id)
           = '2025-01-15T10:00:00Z'::timestamptz;
    assert not (v_page.fields ? 'created');

    -- one date stands for both
    perform workspace.page_import('pi-ann@example.com', jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:one-date', 'title', 'One date', 'body', 'x',
        'updated', '2023-06-01'));
    select * into v_page from workspace.pages where key = 'concept:one-date';
    assert v_page.created_at = '2023-06-01'::timestamptz and v_page.updated_at = v_page.created_at;

    -- no dates: today, as before
    perform workspace.page_import('pi-ann@example.com', jsonb_build_object(
        'drawer', 'concepts', 'key', 'concept:no-date', 'title', 'No date', 'body', 'x'));
    assert (select updated_at from workspace.pages where key = 'concept:no-date') = now();

    -- refused
    assert pg_temp.raises($q$select workspace.page_import('pi-ann@example.com', '{"drawer":"concepts","key":"concept:a","title":"A","created":"soon"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.page_import('pi-ann@example.com', '{"drawer":"concepts","key":"concept:b","title":"B","updated":"2999-01-01"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.page_import('pi-ann@example.com', '{"drawer":"concepts","key":"concept:c","title":"C","created":"2025-02-01","updated":"2025-01-01"}')$q$, '22023');
    assert pg_temp.raises($q$select workspace.page_import('pi-ann@example.com', '{"drawer":"meetings","key":"meeting:d","title":"D","attendees":"Ann"}')$q$, '22023');

    -- attendees
    perform workspace.page_import('pi-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'pat@northwind.example', 'title', 'Pat Rivera',
        'fields', jsonb_build_object('emails', jsonb_build_array('pat.r@mail.example')), 'body', 'p'));
    perform workspace.page_import('pi-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'person:sam-lee', 'title', 'Sam Lee', 'aliases', jsonb_build_array('Sammy'),
        'body', 's'));
    perform workspace.page_import('pi-ann@example.com', jsonb_build_object(
        'drawer', 'people', 'key', 'person:jo-a', 'title', 'Jo', 'body', 'j'));
    -- a second "Jo" (page_import itself would call it the same person)
    perform workspace._page_save_as(v_page.owner_principal_id, array[]::text[], jsonb_build_object(
        'drawer', 'people', 'key', 'person:jo-b', 'title', 'Jo B', 'aliases', jsonb_build_array('Jo'), 'body', 'j'), null);

    v := workspace.page_import('pi-ann@example.com', jsonb_build_object(
        'drawer', 'meetings', 'key', 'meeting:m1', 'title', 'Kickoff', 'body', 'notes',
        'related', jsonb_build_array('Northwind'),
        'attendees', jsonb_build_array('PAT.R@mail.example', 'Sammy', 'Jo', 'pi-ann@example.com', 'Sammy')));
    assert v->'linked' = '["pat@northwind.example", "person:sam-lee"]'::jsonb, v::text;
    assert v->'kept' = '["Jo", "pi-ann@example.com"]'::jsonb, v::text;
    select * into v_page from workspace.pages where key = 'meeting:m1';
    assert v_page.related = array['Northwind', 'pat@northwind.example', 'person:sam-lee'], v_page.related::text;
    assert v_page.fields->'attendees' = '["Jo", "pi-ann@example.com"]'::jsonb, v_page.fields::text;
    assert exists (select 1 from workspace.page_links l
                   where l.page_id = v_page.id and l.target_key = 'person:sam-lee' and l.reason = 'related');
    assert (select count(*) from workspace.pages where drawer = 'people'
              and owner_principal_id = v_page.owner_principal_id) = 4, 'no person page made';
end $$;

rollback;
