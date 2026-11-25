-- issues_test.sql -- checks for migration 0032.
-- Run by apply_local.sh against a throwaway database, as a superuser (it uses
-- `set role` to act as each service role). Any failed check raises and stops
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

create temp table ids (k text primary key, v uuid not null);
grant all on ids to kb_ingest, kb_engine;

insert into workspace.principals (handle, display_name, role, email, active) values
    ('boss', 'The Boss', 'administrator', 'boss@example.com', true),
    ('rita', 'Rita Reader', 'reader', 'rita@example.com', true),
    ('gone', 'Gone Person', 'reader', 'gone@example.com', false);

-- 1. Privileges.
do $$
begin
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
    assert not has_table_privilege('kb_engine', 'workspace.issues', 'select');
    assert not has_table_privilege('kb_ingest', 'workspace.issues', 'select');
    assert not has_table_privilege('anon', 'workspace.issues', 'select');
    assert not has_table_privilege('authenticated', 'workspace.issues', 'insert');
    assert not has_table_privilege('kb_engine', 'workspace.v_support_inbox', 'select');
    assert not has_table_privilege('kb_ingest', 'workspace.v_support_inbox', 'select');
    assert not has_table_privilege('anon', 'workspace.v_support_inbox', 'select');

    assert has_function_privilege('kb_ingest', 'workspace.issue_upsert(text, text, text, text, text, text)', 'execute');
    assert has_function_privilege('kb_ingest', 'workspace.issue_close_by_key(text, text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.issue_upsert(text, text, text, text, text, text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.issue_close_by_key(text, text)', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.issue_report(text, text, text, text)', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.issues_summary(text)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.issue_report(text, text, text, text)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.issues_summary(text)', 'execute');
    assert not has_function_privilege('anon', 'workspace.issue_report(text, text, text, text)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.issue_upsert(text, text, text, text, text, text)', 'execute');

    -- Nobody holds the support functions yet.
    assert not has_function_privilege('kb_engine', 'workspace.issue_set_card(uuid, text)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.issue_set_card(uuid, text)', 'execute');
    assert not has_function_privilege('anon', 'workspace.issue_set_card(uuid, text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.issue_set_status(uuid, text, text, text)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.issue_set_status(uuid, text, text, text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace._active_principal_by_email(text)', 'execute');
    assert not has_function_privilege('anon', 'workspace._active_principal_by_email(text)', 'execute');

    assert (select array_agg(column_name::text order by ordinal_position)
            from information_schema.columns
            where table_schema = 'workspace' and table_name = 'v_support_inbox')
           = array['id', 'category', 'source', 'error_class', 'title', 'detail',
                   'status', 'occurrences', 'opened_at', 'last_seen_at', 'card_id'],
        'the support view exposes exactly these columns';
end $$;

-- 2. The pullers' role: a repeat updates the one open row; closing needs proof.
set local role kb_ingest;
do $$
declare
    v_first  uuid;
    v_second uuid;
    v_third  uuid;
begin
    v_first := workspace.issue_upsert('source_failure', 'drive run failed',
        'HTTP 500 from host', 'drive', 'HTTPError', 'run-drive');
    v_second := workspace.issue_upsert('source_failure', 'drive run failed',
        'HTTP 401 from host', 'drive', 'AuthError', 'run-drive');
    assert v_first = v_second, 'a repeat must update the same row';
    insert into ids values ('drive', v_first);

    -- another source, and issues with no key, are their own rows
    v_third := workspace.issue_upsert('source_failure', 'wiki run failed', null, 'wiki', 'X', 'run-wiki');
    assert v_third <> v_first;
    assert workspace.issue_upsert('unknown_tag', 'a tag names no topic')
           <> workspace.issue_upsert('unknown_tag', 'a tag names no topic');

    assert pg_temp.raises('select workspace.issue_upsert(''bogus'', ''some title'')', '22023');
    assert pg_temp.raises('select workspace.issue_upsert(''source_failure'', ''  '')', '22023');
    assert pg_temp.raises('select workspace.issue_upsert(''source_failure'', null)', '22023');
    assert pg_temp.raises('select workspace.issue_close_by_key('''', ''x'')', '22023');
    assert pg_temp.raises('select * from workspace.issues', '42501');
    assert pg_temp.raises('select * from workspace.v_support_inbox', '42501');
    assert pg_temp.raises('select workspace.issue_report(''rita@example.com'', ''feature_gap'', ''a title'', null)', '42501');
    assert pg_temp.raises(format('select workspace.issue_set_card(%L, ''card-1'')', v_first), '42501');
    assert pg_temp.raises(format('select workspace.issue_set_status(%L, ''closed'')', v_first), '42501');
end $$;
reset role;

do $$
declare
    v_row workspace.issues%rowtype;
begin
    select * into v_row from workspace.issues where dedupe_key = 'run-drive';
    assert v_row.occurrences = 2 and v_row.status = 'open' and v_row.reported_by = 'system';
    assert v_row.error_class = 'AuthError' and v_row.detail = 'HTTP 401 from host',
        'a repeat keeps the latest message';
    assert v_row.last_seen_at >= v_row.opened_at;
    assert (select count(*) from workspace.issues where dedupe_key = 'run-drive') = 1;
end $$;

set local role kb_ingest;
do $$
declare
    v_new uuid;
begin
    assert workspace.issue_close_by_key('run-drive', 'clean run at 2026-01-01T00:00:00Z') = 1;
    assert workspace.issue_close_by_key('run-drive', 'again') = 0, 'nothing open: nothing closed';
    assert workspace.issue_close_by_key('run-never-seen', 'x') = 0;
    -- the same failure later opens a NEW issue
    v_new := workspace.issue_upsert('source_failure', 'drive run failed', 'd', 'drive', 'E', 'run-drive');
    assert v_new <> (select v from ids where k = 'drive');
end $$;
reset role;

do $$
declare
    v_row workspace.issues%rowtype;
begin
    select * into v_row from workspace.issues where id = (select v from ids where k = 'drive');
    assert v_row.status = 'closed' and v_row.closed_at is not null
           and v_row.proof = 'clean run at 2026-01-01T00:00:00Z';
    assert (select count(*) from workspace.issues where dedupe_key = 'run-drive') = 2;
    assert (select occurrences from workspace.issues
            where dedupe_key = 'run-drive' and status = 'open') = 1;
end $$;

-- 3. The second net: emails and URL query strings go, length is capped.
set local role kb_ingest;
select workspace.issue_upsert('source_failure',
    'failed for someone@example.com',
    E'GET https://api.example.com/v1/files?key=abc123&name=Quarterly#frag failed\nfor pat.owner@example.com ' || repeat('x', 900),
    'drive', 'E', 'run-scrub');
reset role;
do $$
declare
    v_row workspace.issues%rowtype;
begin
    select * into v_row from workspace.issues where dedupe_key = 'run-scrub';
    assert v_row.title = 'failed for [email]', v_row.title;
    assert position('@' in v_row.detail) = 0 and position('abc123' in v_row.detail) = 0
           and position('Quarterly' in v_row.detail) = 0, v_row.detail;
    assert v_row.detail like 'GET https://api.example.com/v1/files failed for [email] %', v_row.detail;
    assert length(v_row.detail) = 500;
end $$;

-- 4. A signed-in person reports: known, active people only; user categories only.
set local role kb_engine;
do $$
declare
    v_id uuid;
begin
    v_id := workspace.issue_report(' Rita@Example.com ', 'friction_point', 'Search is slow', 'It took a while.');
    insert into ids values ('rita', v_id);

    assert pg_temp.raises('select workspace.issue_report(''nobody@example.com'', ''feature_gap'', ''a good title'', null)', '42501'),
        'an unknown email is refused';
    assert pg_temp.raises('select workspace.issue_report(''gone@example.com'', ''feature_gap'', ''a good title'', null)', '42501'),
        'an inactive person is refused';
    assert pg_temp.raises('select workspace.issue_report(null, ''feature_gap'', ''a good title'', null)', '42501');
    assert pg_temp.raises('select workspace.issue_report('''', ''feature_gap'', ''a good title'', null)', '42501');

    assert pg_temp.raises('select workspace.issue_report(''rita@example.com'', ''source_failure'', ''a good title'', null)', '22023'),
        'system categories are not for people';
    assert pg_temp.raises('select workspace.issue_report(''rita@example.com'', ''config_invalid'', ''a good title'', null)', '22023');
    assert pg_temp.raises('select workspace.issue_report(''rita@example.com'', null, ''a good title'', null)', '22023');
    assert pg_temp.raises('select workspace.issue_report(''rita@example.com'', ''feature_gap'', ''abcd'', null)', '22023');
    assert pg_temp.raises(format('select workspace.issue_report(''rita@example.com'', ''feature_gap'', %L, null)',
        repeat('t', 121)), '22023');
    assert pg_temp.raises(format('select workspace.issue_report(''rita@example.com'', ''feature_gap'', ''a good title'', %L)',
        repeat('d', 1001)), '22023');

    assert pg_temp.raises('select workspace.issue_upsert(''source_failure'', ''some title'')', '42501');
    assert pg_temp.raises('select workspace.issue_close_by_key(''run-drive'', ''x'')', '42501');
    assert pg_temp.raises('select * from workspace.issues', '42501');
    assert pg_temp.raises('select * from workspace.v_support_inbox', '42501');
end $$;

-- 5. Rate limit: 10 per person per hour, counted per person.
do $$
declare
    i integer;
begin
    for i in 2..10 loop
        perform workspace.issue_report('rita@example.com', 'feature_gap', 'Report number ' || i, null);
    end loop;
    assert pg_temp.raises('select workspace.issue_report(''rita@example.com'', ''feature_gap'', ''One too many'', null)', 'KB429'),
        'the eleventh report in an hour is refused';
    perform workspace.issue_report('boss@example.com', 'data_quality_issue', 'A page looks wrong', null);
end $$;
reset role;

update workspace.issues set opened_at = opened_at - interval '2 hours' where reported_by = 'rita';
set local role kb_engine;
select workspace.issue_report('rita@example.com', 'feature_gap', 'An hour later it works', null);

-- 6. Summary: administrators only.
do $$
declare
    v jsonb;
begin
    assert pg_temp.raises('select workspace.issues_summary(''rita@example.com'')', '42501');
    assert pg_temp.raises('select workspace.issues_summary(''nobody@example.com'')', '42501');
    assert pg_temp.raises('select workspace.issues_summary(null)', '42501');
    v := workspace.issues_summary('boss@example.com');
    assert (v->>'fixed_last_30_days')::integer = 1, v::text;
    assert jsonb_array_length(v->'open') = 17, v::text;
    assert (select array_agg(k order by k) from jsonb_object_keys(v->'open'->0) k)
           = array['category', 'has_card', 'id', 'occurrences', 'opened_at', 'source', 'status', 'title'];
end $$;
reset role;

-- 7. Reporter is a handle, never an email; the support functions work for the owner.
do $$
declare
    v_id uuid := (select v from ids where k = 'rita');
    v_row workspace.issues%rowtype;
begin
    assert (select reported_by from workspace.issues where id = v_id) = 'rita';
    assert (select count(*) from workspace.issues where position('@' in coalesce(reported_by, '')) > 0) = 0;
    assert pg_temp.raises(
        'insert into workspace.issues (category, title, reported_by) values (''feature_gap'', ''t'', ''a@b.example'')', '23514');

    perform workspace.issue_set_card(v_id, 'card-42');
    perform workspace.issue_set_status(v_id, 'fixed_pending_proof', 'https://example.com/acme/repo/pull/7', null);
    select * into v_row from workspace.issues where id = v_id;
    assert v_row.card_id = 'card-42' and v_row.status = 'fixed_pending_proof'
           and v_row.pr_url = 'https://example.com/acme/repo/pull/7' and v_row.closed_at is null;
    perform workspace.issue_set_status(v_id, 'closed', null, 'checked by hand');
    select * into v_row from workspace.issues where id = v_id;
    assert v_row.status = 'closed' and v_row.closed_at is not null and v_row.proof = 'checked by hand'
           and v_row.pr_url is not null;

    assert pg_temp.raises(format('select workspace.issue_set_status(%L, ''wont_fix'')', v_id), '22023');
    assert pg_temp.raises(format('select workspace.issue_set_status(%L, ''open'', ''javascript:alert(1)'')', v_id), '22023');
    assert pg_temp.raises(format('select workspace.issue_set_card(%L, ''bad card id'')', v_id), '22023');
    assert pg_temp.raises(format('select workspace.issue_set_card(%L, ''card-1'')', gen_random_uuid()), 'P0002');
    assert (select count(*) from workspace.v_support_inbox where card_id = 'card-42') = 1;

    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must still have zero table grants';
end $$;

rollback;
