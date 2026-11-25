-- admin_reactivate_test.sql -- checks for migration 0042.
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
    ('rita', 'Rita Reader', 'reader', 'rita@example.com', true),
    ('gone', 'Gone Reader', 'reader', 'gone@example.com', false),
    ('old', 'Old Admin', 'administrator', 'old@example.com', false);
-- `gone` held a token before they were deactivated; `old` never had one.
update workspace.principals set token_hash = repeat('a', 64) where handle = 'gone';
insert into workspace.access_grants (principal_id, domain)
select p.id, 'consulting' from workspace.principals p where p.handle = 'gone';

-- 1. Privileges: the service reaches only the two public functions.
do $$
begin
    assert has_function_privilege('kb_engine',
        'workspace.admin_person_reactivate_preview(text, text)', 'execute');
    assert has_function_privilege('kb_engine',
        'workspace.admin_person_reactivate_apply(text, text, text)', 'execute');
    assert not has_function_privilege('anon',
        'workspace.admin_person_reactivate_preview(text, text)', 'execute');
    assert not has_function_privilege('authenticated',
        'workspace.admin_person_reactivate_apply(text, text, text)', 'execute');
    assert not has_function_privilege('kb_ingest',
        'workspace.admin_person_reactivate_apply(text, text, text)', 'execute');
    assert not has_function_privilege('kb_engine',
        'workspace._admin_do_person_reactivate(workspace.principals, jsonb, boolean)', 'execute');
    assert not has_function_privilege('kb_engine',
        'workspace._admin_run(workspace.principals, text, jsonb, boolean)', 'execute');
    assert not has_function_privilege('anon',
        'workspace._admin_run(workspace.principals, text, jsonb, boolean)', 'execute');
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
end $$;

set local role kb_engine;

-- 2. Only an active administrator may ask. A deactivated person cannot
--    bring themselves (or anyone) back.
do $$
declare
    v_email text;
begin
    foreach v_email in array array[
        'rita@example.com', 'gone@example.com', 'old@example.com', 'nobody@example.com', '']
    loop
        assert pg_temp.raises(format(
            'select workspace.admin_person_reactivate_preview(%L, %L)',
            v_email, 'gone@example.com'), '42501');
        assert pg_temp.raises(format(
            'select workspace.admin_person_reactivate_apply(%L, %L, %L)',
            v_email, 'gone@example.com', repeat('a', 32)), '42501');
    end loop;
end $$;

-- 3. Bad requests: unknown person, a person who is already active.
do $$
begin
    assert pg_temp.raises(
        'select workspace.admin_person_reactivate_preview(''admin-a@example.com'', ''nobody@example.com'')',
        '22023');
    assert pg_temp.raises(
        'select workspace.admin_person_reactivate_preview(''admin-a@example.com'', ''rita@example.com'')',
        '22023');
    assert pg_temp.raises(
        'select workspace.admin_person_reactivate_preview(''admin-a@example.com'', ''admin-a@example.com'')',
        '22023');
end $$;

-- 4. The preview changes nothing and says what comes back. The code is bound
--    to the exact person; it works once.
do $$
declare
    v jsonb;
begin
    v := workspace.admin_person_reactivate_preview('admin-a@example.com', ' Gone@Example.com ');
    assert v->>'preview' like 'Reactivate Gone Reader (gone@example.com), role reader.%', v->>'preview';
    assert v->>'preview' like '%consulting%', 'the preview names the topics that return';
    assert v->>'preview' not like '%ADMINISTRATOR%';
    assert v->>'preview' like '%A token they held before stops working for good%', v->>'preview';
    assert length(v->>'confirm_code') = 32;
    insert into codes values ('gone', v->>'confirm_code');

    -- A wrong code, and a right code for another person, are both refused.
    assert pg_temp.raises(format(
        'select workspace.admin_person_reactivate_apply(''admin-a@example.com'', ''gone@example.com'', %L)',
        repeat('0', 32)), 'KB002');
    assert pg_temp.raises(format(
        'select workspace.admin_person_reactivate_apply(''admin-a@example.com'', ''old@example.com'', %L)',
        v->>'confirm_code'), 'KB002');
    -- A reactivate code does not work for a deactivate of the same person.
    assert pg_temp.raises(format(
        'select workspace.admin_person_deactivate_apply(''admin-a@example.com'', ''gone@example.com'', %L)',
        v->>'confirm_code'), 'KB002');
end $$;
reset role;
do $$
begin
    assert not (select active from workspace.principals where handle = 'gone'),
        'a preview and refused applies change nothing';
    assert (select token_hash from workspace.principals where handle = 'gone') = repeat('a', 64),
        'a preview does not touch the token';
end $$;

set local role kb_engine;
do $$
declare
    v jsonb;
begin
    v := workspace.admin_person_reactivate_apply(
        'admin-a@example.com', 'gone@example.com', (select c.v from codes c where c.k = 'gone'));
    assert (v->>'applied')::boolean;
    -- Used once.
    assert pg_temp.raises(format(
        'select workspace.admin_person_reactivate_apply(''admin-a@example.com'', ''gone@example.com'', %L)',
        (select c.v from codes c where c.k = 'gone')), 'KB002');

    -- An administrator coming back is said plainly.
    v := workspace.admin_person_reactivate_preview('admin-a@example.com', 'old@example.com');
    assert v->>'preview' like '%ADMINISTRATOR%', v->>'preview';
    assert v->>'preview' like '%No topic is listed for them%', v->>'preview';
    assert v->>'preview' not like '%token%', 'no token line for a person who held none';
    perform workspace.admin_person_reactivate_apply(
        'admin-a@example.com', 'old@example.com', v->>'confirm_code');
    -- The returned administrator is an administrator again, at once.
    assert jsonb_array_length(workspace.admin_people_list('old@example.com')) >= 4;
end $$;
reset role;

do $$
begin
    assert (select active from workspace.principals where handle = 'gone');
    assert (select active from workspace.principals where handle = 'old');
    assert (select token_hash from workspace.principals where handle = 'gone') is null,
        'a token held before deactivation must not come back';
    assert workspace.resolve_domains(repeat('a', 64)) = array[]::text[],
        'the old token resolves to no topic';
    assert (select count(*) from workspace.access_grants g join workspace.principals p
            on p.id = g.principal_id where p.handle = 'gone') = 1,
        'reactivating adds no topic and removes none';
    assert (select count(*) from workspace.events
            where component = 'admin' and event = 'admin.person_reactivate') = 2,
        'every successful apply writes one audit row';
    assert (select count(*) from workspace.events
            where component = 'admin' and position('@' in attrs::text) > 0) = 0,
        'the audit trail holds no email address';
end $$;

rollback;
