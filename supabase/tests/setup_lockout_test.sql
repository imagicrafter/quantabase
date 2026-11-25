-- setup_lockout_test.sql -- checks for migration 0034.
-- Run by apply_local.sh against a throwaway database, as a superuser (it uses
-- `set role` to act as each service role). Any failed check raises and stops
-- the run. Everything happens in one transaction that is rolled back.
--
-- now() does not move inside a transaction, so time is moved by editing the
-- stored timestamps instead.

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

create or replace function pg_temp.hash(p_code text)
returns text language sql as $$
    select encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
$$;

-- 1. Who may run what.
do $$
begin
    assert has_function_privilege('kb_engine', 'workspace.engine_setup_attempt_check()', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.engine_setup_attempt_fail()', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.engine_setup_code_valid(text)', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.engine_setup_complete(text, jsonb)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.engine_setup_reopen(text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace._setup_record_failure()', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.engine_setup_attempt_fail()', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.engine_setup_code_valid(text)', 'execute');
    assert not has_function_privilege('anon', 'workspace.engine_setup_attempt_check()', 'execute');
    assert not has_function_privilege('anon', 'workspace.engine_setup_attempt_fail()', 'execute');
    assert not has_function_privilege('anon', 'workspace.engine_setup_code_valid(text)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.engine_setup_attempt_fail()', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.engine_setup_code_valid(text)', 'execute');
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must still have zero table grants';
end $$;

-- Open setup with a known code.
set local role kb_ingest;
select workspace.engine_setup_reopen(pg_temp.hash('the right code, long and random'));
reset role;

-- 2. A fresh window is not locked, and the public read shows no counter.
set local role kb_engine;
do $$
declare
    v_state jsonb := workspace.engine_setup_attempt_check();
begin
    assert v_state->>'locked' = 'false';
    assert (v_state->>'failures')::int = 0;
    assert (v_state->>'retry_after_seconds')::int = 0;
    assert not workspace.engine_settings_public() ? 'setup_failed_at';
    assert not workspace.engine_settings_public() ? 'setup_locked_until';
    assert not workspace.engine_settings_public() ? 'setup_code_ok_at';
    assert pg_temp.raises('select setup_failed_at from workspace.engine_settings', '42501');
    assert pg_temp.raises(
        'update workspace.engine_settings set setup_locked_until = null', '42501');
end $$;

-- 3. Four wrong codes do not lock; the right code still checks out.
do $$
declare
    v_state jsonb;
begin
    for i in 1..4 loop
        v_state := workspace.engine_setup_attempt_fail();
        assert v_state->>'locked' = 'false', 'must not lock before the fifth';
        assert (v_state->>'failures')::int = i;
    end loop;
    assert workspace.engine_setup_code_valid('the right code, long and random') is true;
    assert (workspace.engine_setup_attempt_check()->>'failures')::int = 4,
        'a right code check spends nothing and clears nothing';
end $$;
reset role;

-- 4. Wrong codes older than 15 minutes stop counting.
update workspace.engine_settings
set setup_failed_at = array[now() - interval '16 minutes', now() - interval '16 minutes',
                            now() - interval '16 minutes', now() - interval '14 minutes'];
set local role kb_engine;
do $$
declare
    v_state jsonb;
begin
    assert (workspace.engine_setup_attempt_check()->>'failures')::int = 1;
    v_state := workspace.engine_setup_attempt_fail();
    assert v_state->>'locked' = 'false';
    assert (v_state->>'failures')::int = 2, 'old failures must have been dropped';
end $$;
reset role;

-- 5. The fifth wrong code inside the window locks setup for an hour.
update workspace.engine_settings set setup_failed_at = '{}';
set local role kb_engine;
do $$
declare
    v_state  jsonb;
    v_access jsonb := '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "aud-1", "host": "engine.example.com"}';
begin
    -- Wrong codes count whichever function sees them.
    assert workspace.engine_setup_code_valid('wrong') is false;
    assert workspace.engine_setup_code_valid('') is false;
    assert workspace.engine_setup_complete('wrong', v_access) is false;
    assert (workspace.engine_setup_attempt_check()->>'failures')::int = 3;
    perform workspace.engine_setup_attempt_fail();
    v_state := workspace.engine_setup_attempt_fail();
    assert v_state->>'locked' = 'true', 'the fifth wrong code must lock';
    assert (v_state->>'retry_after_seconds')::int between 3590 and 3600;

    v_state := workspace.engine_setup_attempt_check();
    assert v_state->>'locked' = 'true';

    -- While locked, the RIGHT code no longer checks out, and nothing is stored.
    assert workspace.engine_setup_code_valid('the right code, long and random') is false;
    assert workspace.engine_settings_public()->>'setup_state' = 'open';
    assert workspace.engine_settings_public()->'access' = 'null'::jsonb;

    -- More wrong codes while locked do not push the lock further out.
    perform workspace.engine_setup_attempt_fail();
end $$;
reset role;

do $$
begin
    assert (select setup_locked_until from workspace.engine_settings)
           <= now() + interval '1 hour', 'a lock must not be extended while it holds';
    assert (select setup_code_hash from workspace.engine_settings) is not null,
        'a lockout must not spend the code';
end $$;

-- 5b. A setup already under way may finish after a lock begins: the right
--     code was checked (step 3) before the lock. Not after 10 minutes, and
--     never with a wrong code.
set local role kb_engine;
do $$
declare
    v_access jsonb := '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "aud-1", "host": "engine.example.com"}';
begin
    assert workspace.engine_setup_attempt_check()->>'locked' = 'true';
    assert workspace.engine_setup_complete('wrong again', v_access) is false;
    assert workspace.engine_settings_public()->>'setup_state' = 'open';
end $$;
reset role;
do $$
begin
    assert (select setup_code_ok_at from workspace.engine_settings) is not null,
        'a right code check must be noted';
end $$;
-- the check is now too old: locked means locked
update workspace.engine_settings set setup_code_ok_at = now() - interval '11 minutes';
set local role kb_engine;
do $$
declare
    v_access jsonb := '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "aud-1", "host": "engine.example.com"}';
begin
    assert workspace.engine_setup_complete('the right code, long and random', v_access) is false,
        'an old check must not open a locked setup';
end $$;
reset role;
-- the check is recent: the setup under way finishes
update workspace.engine_settings set setup_code_ok_at = now() - interval '2 minutes';
savepoint under_way;
set local role kb_engine;
do $$
declare
    v_access jsonb := '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "aud-1", "host": "engine.example.com"}';
begin
    assert workspace.engine_setup_complete('the right code, long and random', v_access) is true,
        'a setup under way must be able to finish despite a lock';
    assert workspace.engine_settings_public()->>'setup_state' = 'complete';
end $$;
reset role;
rollback to savepoint under_way;

-- 6. The lock ends by itself after the hour.
update workspace.engine_settings set setup_locked_until = now() - interval '1 second';
set local role kb_engine;
do $$
declare
    v_state jsonb := workspace.engine_setup_attempt_check();
begin
    assert v_state->>'locked' = 'false', 'an expired lock must not hold';
    assert (v_state->>'failures')::int = 0;
    assert workspace.engine_setup_code_valid('the right code, long and random') is true;
    -- and counting starts again from one
    assert (workspace.engine_setup_attempt_fail()->>'failures')::int = 1;
end $$;
reset role;

-- 7. A new code from the operator clears a lock.
update workspace.engine_settings
set setup_locked_until = now() + interval '50 minutes', setup_failed_at = '{}';
set local role kb_ingest;
select workspace.engine_setup_reopen(pg_temp.hash('a second code, also long and random'));
reset role;
set local role kb_engine;
do $$
begin
    assert workspace.engine_setup_attempt_check()->>'locked' = 'false';
    assert workspace.engine_setup_code_valid('a second code, also long and random') is true;
end $$;
reset role;

-- 8. Completing setup: the dashboard app must differ from the connector app;
--    success clears the counter and closes the window.
set local role kb_engine;
do $$
declare
    v_access jsonb := '{"team_domain": "https://acme.cloudflareaccess.com", "aud": "aud-1",
                        "status_aud": "aud-2", "host": "engine.example.com",
                        "resource_url": "https://engine.example.com/mcp", "level": "people"}';
begin
    perform workspace.engine_setup_attempt_fail();
    assert pg_temp.raises(format(
        'select workspace.engine_setup_complete(%L, %L::jsonb)',
        'a second code, also long and random', v_access || '{"status_aud": "aud-1"}'), '22023');
    assert workspace.engine_settings_public()->>'setup_state' = 'open',
        'a refused completion must not spend the code';

    assert workspace.engine_setup_complete('a second code, also long and random', v_access) is true;
    assert workspace.engine_settings_public()->>'setup_state' = 'complete';
    assert workspace.engine_settings_public() #>> '{access,level}' = 'people';
    assert workspace.engine_settings_public() #>> '{access,status_aud}' = 'aud-2';

    -- A closed window: nothing is valid, and nothing is counted.
    assert workspace.engine_setup_code_valid('a second code, also long and random') is false;
    assert workspace.engine_setup_code_valid('anything') is false;
    assert (workspace.engine_setup_attempt_check()->>'failures')::int = 0;
end $$;
reset role;

do $$
begin
    assert (select setup_failed_at from workspace.engine_settings) = '{}';
    assert (select setup_locked_until from workspace.engine_settings) is null;
    assert (select setup_code_ok_at from workspace.engine_settings) is null;
    assert (select setup_code_hash from workspace.engine_settings) is null;
end $$;

rollback;
