-- admin_tools_test.sql -- checks for migration 0033.
-- Run by apply_local.sh against a throwaway database, as a superuser (it uses
-- `set role` to act as the service role). Any failed check raises and stops
-- the run. Everything happens in one transaction that is rolled back.

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

create temp table codes (k text primary key, v text not null);
grant all on codes to kb_engine;

insert into workspace.domains (domain, label, sensitive) values
    ('consulting', 'Consulting', false),
    ('private', 'Private', true);
insert into workspace.principals (handle, display_name, role, email, active) values
    ('admin-a', 'Admin A', 'administrator', 'admin-a@example.com', true),
    ('admin-b', 'Admin B', 'administrator', 'admin-b@example.com', true),
    ('rita', 'Rita Reader', 'reader', 'rita@example.com', true),
    ('old', 'Old Admin', 'administrator', 'old@example.com', false);

-- 1. Privileges: the service reaches only the public functions.
do $$
declare
    v_fn regprocedure;
    v_public integer := 0;
begin
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
    assert not has_table_privilege('kb_engine', 'workspace.admin_confirmations', 'select');
    assert not has_table_privilege('kb_ingest', 'workspace.admin_confirmations', 'select');
    assert not has_table_privilege('anon', 'workspace.admin_confirmations', 'select');
    for v_fn in
        select p.oid::regprocedure from pg_proc p
        where p.pronamespace = 'workspace'::regnamespace and p.proname like '\_admin\_%'
    loop
        assert not has_function_privilege('kb_engine', v_fn, 'execute'), v_fn::text;
        assert not has_function_privilege('kb_ingest', v_fn, 'execute'), v_fn::text;
        assert not has_function_privilege('anon', v_fn, 'execute'), v_fn::text;
    end loop;
    for v_fn in
        select p.oid::regprocedure from pg_proc p
        where p.pronamespace = 'workspace'::regnamespace and p.proname like 'admin\_%'
    loop
        v_public := v_public + 1;
        assert has_function_privilege('kb_engine', v_fn, 'execute'), v_fn::text;
        assert not has_function_privilege('kb_ingest', v_fn, 'execute'), v_fn::text;
        assert not has_function_privilege('anon', v_fn, 'execute'), v_fn::text;
        assert not has_function_privilege('authenticated', v_fn, 'execute'), v_fn::text;
    end loop;
    -- 12, plus the three ticket functions of 0072 (list, get, note; no close)
    assert v_public = 15, format('expected 15 public admin functions, found %s', v_public);
end $$;

set local role kb_engine;

-- 2. Anyone who is not an active administrator is refused by every function.
do $$
declare
    v_email text;
begin
    foreach v_email in array array[
        'rita@example.com', 'old@example.com', 'nobody@example.com', '']
    loop
        assert pg_temp.raises(format('select workspace.admin_people_list(%L)', v_email), '42501');
        assert pg_temp.raises(format('select workspace.admin_person_add_preview(%L, %L, %L, %L)',
            v_email, 'new@example.com', 'New Person', 'reader'), '42501');
        assert pg_temp.raises(format('select workspace.admin_person_add_apply(%L, %L, %L, %L, false, %L)',
            v_email, 'new@example.com', 'New Person', 'reader', 'x'), '42501');
        assert pg_temp.raises(format('select workspace.admin_grant_preview(%L, %L, %L)',
            v_email, 'rita@example.com', 'consulting'), '42501');
        assert pg_temp.raises(format('select workspace.admin_grant_apply(%L, %L, %L, false, %L)',
            v_email, 'rita@example.com', 'consulting', 'x'), '42501');
        assert pg_temp.raises(format('select workspace.admin_revoke_preview(%L, %L, %L)',
            v_email, 'rita@example.com', 'consulting'), '42501');
        assert pg_temp.raises(format('select workspace.admin_revoke_apply(%L, %L, %L, %L)',
            v_email, 'rita@example.com', 'consulting', 'x'), '42501');
        assert pg_temp.raises(format('select workspace.admin_person_deactivate_preview(%L, %L)',
            v_email, 'admin-b@example.com'), '42501');
        assert pg_temp.raises(format('select workspace.admin_person_deactivate_apply(%L, %L, %L)',
            v_email, 'admin-b@example.com', 'x'), '42501');
        assert not workspace.admin_is_administrator(v_email);
    end loop;
    assert pg_temp.raises('select workspace.admin_people_list(null)', '42501');
    assert workspace.admin_is_administrator(' Admin-A@Example.com ');
    assert pg_temp.raises('select * from workspace.principals', '42501');
    assert pg_temp.raises('select * from workspace.admin_confirmations', '42501');
    assert pg_temp.raises(
        'select workspace._admin_preview(''admin-a@example.com'', ''grant'', ''{}''::jsonb)', '42501');
end $$;

-- 3. A preview describes the change, hands out a code, and changes nothing.
do $$
declare
    v jsonb;
begin
    v := workspace.admin_grant_preview('admin-a@example.com', 'Rita@Example.com', 'consulting');
    assert v->>'preview' like 'Grant the topic "Consulting" (consulting) to Rita Reader%', v->>'preview';
    assert v->>'confirm_code' ~ '^[0-9a-f]{32}$';
    assert (v->>'expires_at')::timestamptz between now() + interval '9 minutes'
                                               and now() + interval '11 minutes';
    insert into codes values ('grant', v->>'confirm_code');
end $$;
reset role;
do $$
begin
    assert (select count(*) from workspace.access_grants) = 0, 'a preview must not change anything';
    assert (select count(*) from workspace.admin_confirmations) = 1;
    assert not exists (select 1 from workspace.admin_confirmations c, codes
                       where c.code_hash = codes.v), 'the code itself must never be stored';
    assert (select code_hash from workspace.admin_confirmations)
           = encode(sha256(convert_to((select v from codes where k = 'grant'), 'UTF8')), 'hex');
end $$;
set local role kb_engine;

-- 4. The code is bound to the caller and to the exact arguments, and works once.
do $$
declare
    v_code text := (select v from codes where k = 'grant');
    v jsonb;
begin
    assert pg_temp.raises(format(
        'select workspace.admin_grant_apply(''admin-a@example.com'', ''rita@example.com'', ''consulting'', false, %L)',
        repeat('0', 32)), 'KB002'), 'a made-up code must fail';
    assert pg_temp.raises(
        'select workspace.admin_grant_apply(''admin-a@example.com'', ''rita@example.com'', ''consulting'', false, null)',
        'KB002'), 'a missing code must fail';
    assert pg_temp.raises(format(
        'select workspace.admin_grant_apply(''admin-b@example.com'', ''rita@example.com'', ''consulting'', false, %L)',
        v_code), 'KB002'), 'a code issued to admin A must fail for admin B';
    assert pg_temp.raises(format(
        'select workspace.admin_grant_apply(''admin-a@example.com'', ''admin-b@example.com'', ''consulting'', false, %L)',
        v_code), 'KB002'), 'a different person must fail';
    assert pg_temp.raises(format(
        'select workspace.admin_grant_apply(''admin-a@example.com'', ''rita@example.com'', ''private'', false, %L)',
        v_code), 'KB002'), 'a different topic must fail';
    assert pg_temp.raises(format(
        'select workspace.admin_grant_apply(''admin-a@example.com'', ''rita@example.com'', ''consulting'', true, %L)',
        v_code), 'KB002'), 'a different acknowledgement must fail';
    assert pg_temp.raises(format(
        'select workspace.admin_revoke_apply(''admin-a@example.com'', ''rita@example.com'', ''consulting'', %L)',
        v_code), 'KB002'), 'a different action must fail';

    v := workspace.admin_grant_apply('admin-a@example.com', 'rita@example.com', 'consulting', false, v_code);
    assert (v->>'applied')::boolean and v->>'summary' like 'Grant the topic%';

    assert pg_temp.raises(format(
        'select workspace.admin_grant_apply(''admin-a@example.com'', ''rita@example.com'', ''consulting'', false, %L)',
        v_code), 'KB002'), 'a code cannot be reused';
end $$;
reset role;
do $$
declare
    v_event workspace.events%rowtype;
begin
    assert (select array_agg(g.domain) from workspace.access_grants g
            join workspace.principals p on p.id = g.principal_id
            where p.handle = 'rita') = array['consulting'];
    assert (select granted_by from workspace.access_grants) = 'admin-a';
    select * into v_event from workspace.events where component = 'admin';
    assert found and v_event.event = 'admin.grant' and v_event.status = 'ok';
    assert v_event.attrs = '{"actor": "admin-a", "target": "rita", "topic": "consulting", "sensitive": false}'::jsonb,
        v_event.attrs::text;
    assert position('@' in v_event.attrs::text) = 0, 'the audit row must hold no email address';
end $$;

-- 5. An expired code fails.
set local role kb_engine;
insert into codes
select 'revoke', workspace.admin_revoke_preview('admin-a@example.com', 'rita@example.com', 'consulting')->>'confirm_code';
reset role;
update workspace.admin_confirmations set expires_at = now() - interval '1 second' where used_at is null;
set local role kb_engine;
do $$
begin
    assert pg_temp.raises(format(
        'select workspace.admin_revoke_apply(''admin-a@example.com'', ''rita@example.com'', ''consulting'', %L)',
        (select v from codes where k = 'revoke')), 'KB002'), 'an expired code must fail';
end $$;

-- 6. Sensitive topics need the acknowledgement on BOTH steps; unclassified never.
do $$
declare
    v jsonb;
begin
    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''rita@example.com'', ''private'')', 'KB001');
    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''rita@example.com'', ''private'', false)', 'KB001');
    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''rita@example.com'', ''private'', null)', 'KB001');

    v := workspace.admin_grant_preview('admin-a@example.com', 'rita@example.com', 'private', true);
    assert v->>'preview' like '%SENSITIVE%';
    assert pg_temp.raises(format(
        'select workspace.admin_grant_apply(''admin-a@example.com'', ''rita@example.com'', ''private'', false, %L)',
        v->>'confirm_code'), 'KB002'), 'apply without the acknowledgement must fail';
    perform workspace.admin_grant_apply(
        'admin-a@example.com', 'rita@example.com', 'private', true, v->>'confirm_code');

    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''rita@example.com'', ''unclassified'')', 'KB001');
    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''rita@example.com'', ''unclassified'', true)', 'KB001');
    assert pg_temp.raises(
        'select workspace.admin_revoke_preview(''admin-a@example.com'', ''admin-a@example.com'', ''unclassified'')', 'KB001');
    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''rita@example.com'', ''no-such-topic'')', '22023');
    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''ghost@example.com'', ''consulting'')', '22023');
    assert pg_temp.raises(
        'select workspace.admin_grant_preview(''admin-a@example.com'', ''rita@example.com'', ''consulting'')', '22023'),
        'an existing grant is not granted twice';
end $$;

-- 7. Revoke.
do $$
declare
    v jsonb;
begin
    v := workspace.admin_revoke_preview('admin-a@example.com', 'rita@example.com', 'private');
    perform workspace.admin_revoke_apply('admin-a@example.com', 'rita@example.com', 'private', v->>'confirm_code');
    assert pg_temp.raises(
        'select workspace.admin_revoke_preview(''admin-a@example.com'', ''rita@example.com'', ''private'')', '22023');
    assert (workspace.admin_people_list('admin-a@example.com') @>
            '[{"handle": "rita", "topics": ["consulting"], "active": true}]'::jsonb);
end $$;

-- 8. Adding a person.
do $$
declare
    v jsonb;
begin
    assert pg_temp.raises(
        'select workspace.admin_person_add_preview(''admin-a@example.com'', ''not-an-email'', ''N'', ''reader'')', '22023');
    assert pg_temp.raises(
        'select workspace.admin_person_add_preview(''admin-a@example.com'', ''a b@example.com'', ''N'', ''reader'')', '22023');
    assert pg_temp.raises(
        'select workspace.admin_person_add_preview(''admin-a@example.com'', ''new@example.com'', ''N'', ''owner'')', '22023');
    assert pg_temp.raises(
        'select workspace.admin_person_add_preview(''admin-a@example.com'', ''new@example.com'', '''', ''reader'')', '22023');
    assert pg_temp.raises(
        'select workspace.admin_person_add_preview(''admin-a@example.com'', ''RITA@example.com'', ''N'', ''reader'')', '22023');
    assert pg_temp.raises(
        'select workspace.admin_person_add_preview(''admin-a@example.com'', ''new@example.com'', ''N'', ''administrator'')', 'KB001');

    v := workspace.admin_person_add_preview('admin-a@example.com', ' New@Example.com ', 'New Person', 'reviewer');
    assert v->>'preview' like 'Add New Person (new@example.com) as reviewer.%', v->>'preview';
    assert v->>'preview' like '%Cloudflare Access policy%' and v->>'preview' like '%domain-based%';
    perform workspace.admin_person_add_apply(
        'admin-a@example.com', 'new@example.com', 'New Person', 'reviewer', false, v->>'confirm_code');

    v := workspace.admin_person_add_preview('admin-a@example.com', 'rita@elsewhere.example', 'Other Rita', 'administrator', true);
    assert pg_temp.raises(format(
        'select workspace.admin_person_add_apply(''admin-a@example.com'', ''rita@elsewhere.example'', ''Other Rita'', ''administrator'', false, %L)',
        v->>'confirm_code'), 'KB002');
    perform workspace.admin_person_add_apply(
        'admin-a@example.com', 'rita@elsewhere.example', 'Other Rita', 'administrator', true, v->>'confirm_code');
end $$;
reset role;
do $$
begin
    assert (select role || ':' || handle || ':' || active from workspace.principals
            where email = 'new@example.com') = 'reviewer:new:true';
    assert (select handle from workspace.principals where email = 'rita@elsewhere.example')
           like 'rita-%', 'a taken handle gets a suffix';
    assert (select count(*) from workspace.access_grants g join workspace.principals p
            on p.id = g.principal_id where p.email = 'new@example.com') = 0;
    update workspace.principals set active = false where email = 'rita@elsewhere.example';
end $$;

-- 9. Deactivating: never yourself, never the last administrator.
set local role kb_engine;
do $$
declare
    v jsonb;
begin
    assert pg_temp.raises(
        'select workspace.admin_person_deactivate_preview(''admin-a@example.com'', ''Admin-A@example.com'')', 'KB001');
    assert pg_temp.raises(
        'select workspace.admin_person_deactivate_preview(''admin-a@example.com'', ''old@example.com'')', '22023');

    -- B holds a valid code, then A deactivates B: the code dies with B's access.
    insert into codes select 'b-kills-a',
        workspace.admin_person_deactivate_preview('admin-b@example.com', 'admin-a@example.com')->>'confirm_code';
    v := workspace.admin_person_deactivate_preview('admin-a@example.com', 'admin-b@example.com');
    perform workspace.admin_person_deactivate_apply('admin-a@example.com', 'admin-b@example.com', v->>'confirm_code');
    assert pg_temp.raises(format(
        'select workspace.admin_person_deactivate_apply(''admin-b@example.com'', ''admin-a@example.com'', %L)',
        (select c.v from codes c where c.k = 'b-kills-a')), '42501');
    assert pg_temp.raises('select workspace.admin_people_list(''admin-b@example.com'')', '42501');
    assert pg_temp.raises(
        'select workspace.admin_person_deactivate_preview(''admin-a@example.com'', ''admin-a@example.com'')', 'KB001');
end $$;
reset role;
do $$
declare
    v_rita workspace.principals%rowtype;
begin
    assert not (select active from workspace.principals where handle = 'admin-b');
    -- The last-administrator guard itself, reached with a caller who is not
    -- the target (the public path cannot get here: its caller is an admin).
    select * into v_rita from workspace.principals where handle = 'rita';
    begin
        perform workspace._admin_do_person_deactivate(
            v_rita, '{"person_email": "admin-a@example.com"}'::jsonb, true);
        raise exception 'the last administrator was removed';
    exception when sqlstate 'KB001' then
        assert sqlerrm like '%last active administrator%', sqlerrm;
    end;
    assert (select active from workspace.principals where handle = 'admin-a');
    assert (select count(*) from workspace.events where component = 'admin') = 6,
        'every successful apply writes one audit row';
    assert (select count(*) from workspace.events
            where component = 'admin' and position('@' in attrs::text) > 0) = 0;
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must still have zero table grants';
end $$;

rollback;
