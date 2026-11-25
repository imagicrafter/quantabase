-- issues_admin_read_test.sql -- checks for migration 0044.
-- Run by apply_local.sh against a throwaway database, as a superuser. Any
-- failed check raises and stops the run. Everything is rolled back.

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

insert into workspace.principals (handle, display_name, role, email, active) values
    ('boss', 'The Boss', 'administrator', 'boss@example.com', true),
    ('rita', 'Rita Reader', 'reader', 'rita@example.com', true),
    ('gone', 'Gone Admin', 'administrator', 'gone@example.com', false);

insert into workspace.issues (id, category, title, detail, source, dedupe_key, status, closed_at) values
    ('00000000-0000-0000-0000-0000000000a1', 'source_failure', 'wiki run failed',
     'TimeoutError', 'wiki', 'run-wiki', 'open', null),
    ('00000000-0000-0000-0000-0000000000a2', 'unknown_tag', 'drive has items with an unknown tag',
     '2 item(s)', 'drive', 'unknown-tag-drive', 'closed', now());

-- 1. Privileges: no application role may call these. Only `kbe issues`
--    does, over the owner's direct connection; the service lists issues
--    through issues_summary and never needs the detail text.
do $$
begin
    assert not has_function_privilege('kb_engine', 'workspace.issues_list(text, boolean)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.issue_detail(text, uuid)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.issues_list(text, boolean)', 'execute');
    assert not has_function_privilege('anon', 'workspace.issues_list(text, boolean)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.issue_detail(text, uuid)', 'execute');
    assert not has_function_privilege('anon', 'workspace.issue_detail(text, uuid)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace._issues_admin_only(text)', 'execute');
    assert not has_table_privilege('kb_engine', 'workspace.issues', 'select');
end $$;

-- 2. Only an active administrator is answered, whoever holds the connection.
do $$
declare
    v_email text;
begin
    foreach v_email in array array['rita@example.com', 'gone@example.com',
                                   'nobody@example.com', '', null] loop
        assert pg_temp.raises(format('select workspace.issues_list(%L, true)', v_email), '42501'),
            format('issues_list must refuse %s', coalesce(v_email, 'null'));
        assert pg_temp.raises(format(
            'select workspace.issue_detail(%L, %L)', v_email,
            '00000000-0000-0000-0000-0000000000a1'), '42501'),
            format('issue_detail must refuse %s', coalesce(v_email, 'null'));
    end loop;
end $$;

-- 3. The list: open only by default, everything on request, no detail text.
do $$
declare
    v_open jsonb := workspace.issues_list('boss@example.com', false);
    v_null jsonb := workspace.issues_list('boss@example.com', null);
    v_all  jsonb := workspace.issues_list('BOSS@example.com', true);
begin
    assert jsonb_array_length(v_open) = 1, v_open::text;
    assert v_open->0->>'title' = 'wiki run failed';
    assert v_null = v_open, 'a null flag means open only';
    assert jsonb_array_length(v_all) = 2, v_all::text;
    assert not (v_all->0 ? 'detail') and not (v_all->1 ? 'detail'), 'the list holds no detail';
end $$;

-- 4. One issue, with its detail; an unknown id is null, not an error.
do $$
declare
    v_one jsonb := workspace.issue_detail(
        'boss@example.com', '00000000-0000-0000-0000-0000000000a2');
begin
    assert v_one->>'detail' = '2 item(s)' and v_one->>'status' = 'closed', v_one::text;
    assert workspace.issue_detail(
        'boss@example.com', '00000000-0000-0000-0000-0000000000ff') is null;
end $$;

rollback;
