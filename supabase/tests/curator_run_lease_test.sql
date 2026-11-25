-- curator_run_lease_test.sql -- checks for migration 0064.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * a run holds a lease; a second start is refused while it is live
--   * a lease that ran out is reclaimed by the next start
--   * boot reclaim closes runs of another holder and pre-0064 rows
--   * heartbeat renews a live run, and answers false once it was reclaimed
--   * curator_tick_seen records the last poke; app_curator_health is
--     administrators only and reports the jobs, pokes and the lease holder
--   * grants: service functions to kb_engine only; nothing to anon

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('rl-boss', 'Lease Admin', 'administrator', 'rl-boss@example.com', true, 'sub-rl-boss', 'tok-rl-boss'),
    ('rl-ann',  'Lease Reader', 'reader',       'rl-ann@example.com',  true, 'sub-rl-ann',  'tok-rl-ann');

do $$
declare
    v_a uuid;
    v_b uuid;
    v   jsonb;
    v_n integer;
    v_denied boolean := false;
begin
    assert has_function_privilege('kb_engine', 'workspace.curator_run_start(text, text, integer)', 'execute'), 'kb_engine start';
    assert has_function_privilege('kb_engine', 'workspace.curator_run_heartbeat(uuid, integer)', 'execute'), 'kb_engine heartbeat';
    assert has_function_privilege('kb_engine', 'workspace.curator_run_reclaim(text)', 'execute'), 'kb_engine reclaim';
    assert has_function_privilege('kb_engine', 'workspace.curator_tick_seen(text)', 'execute'), 'kb_engine tick_seen';
    assert has_function_privilege('kb_engine', 'workspace.app_curator_health(text)', 'execute'), 'kb_engine health';
    assert not has_function_privilege('kb_engine', 'workspace._curator_health()', 'execute'), 'inner health hidden';
    assert not has_function_privilege('kb_engine', 'workspace._curator_runs_close_stale(text)', 'execute'), 'close_stale hidden';
    assert not has_function_privilege('anon', 'workspace.curator_run_start(text, text, integer)', 'execute'), 'anon start';
    assert not has_function_privilege('authenticated', 'workspace.app_curator_health(text)', 'execute'), 'authenticated health';
    assert not has_function_privilege('anon', 'workspace.curator_tick_seen(text)', 'execute'), 'anon tick_seen';

    update workspace.curator_runs set status = 'ok', finished_at = now() where status = 'running';

    -- A live lease refuses a second start.
    v_a := workspace.curator_run_start('tick', 'boot-a', 180);
    assert v_a is not null, 'first start';
    assert workspace.curator_run_start('tick', 'boot-b', 180) is null, 'live lease refuses a second start';
    assert workspace.curator_run_heartbeat(v_a, 180), 'heartbeat renews a live run';

    -- A lease that ran out is reclaimed by the next start.
    update workspace.curator_runs set lease_until = now() - interval '1 second' where id = v_a;
    v_b := workspace.curator_run_start('tick', 'boot-b', 180);
    assert v_b is not null, 'expired lease reclaimed';
    assert (select status from workspace.curator_runs where id = v_a) = 'failed', 'stale run closed as failed';
    assert (select stats->>'error' from workspace.curator_runs where id = v_a) = 'run stopped renewing its lease', 'reason recorded';
    assert not workspace.curator_run_heartbeat(v_a, 180), 'heartbeat of a reclaimed run answers false';

    -- Hard cap: a run older than 30 minutes is closed even with a lease.
    update workspace.curator_runs set started_at = now() - interval '31 minutes',
                                      lease_until = now() + interval '5 minutes' where id = v_b;
    assert workspace.curator_run_start('batch', 'boot-c', 180) is not null, 'hard cap reclaims';
    assert (select status from workspace.curator_runs where id = v_b) = 'failed', 'hard-capped run failed';
    update workspace.curator_runs set status = 'ok', finished_at = now() where status = 'running';

    -- Boot reclaim: a pre-0064 row (no holder, no lease, started 2 minutes
    -- ago) and another holder's live row are closed; this holder's own row is not.
    insert into workspace.curator_runs (mode, started_at) values ('tick', now() - interval '2 minutes') returning id into v_a;
    assert workspace.curator_run_start('tick', 'boot-d', 180) is null, 'pre-0064 row still blocks a start';
    v_n := workspace.curator_run_reclaim('boot-e');
    assert v_n = 1, 'boot reclaims the pre-0064 row';
    assert (select stats->>'error' from workspace.curator_runs where id = v_a) = 'service restarted during the run', 'restart reason';
    v_b := workspace.curator_run_start('tick', 'boot-e', 180);
    assert v_b is not null, 'start after reclaim';
    assert workspace.curator_run_reclaim('boot-e') = 0, 'own run kept';
    assert workspace.curator_run_reclaim('boot-f') = 1, 'other holder run closed';

    -- The old one-argument start still works.
    assert workspace.curator_run_start('tick') is not null, 'legacy start';
    update workspace.curator_runs set status = 'ok', finished_at = now() where status = 'running';

    -- Ticks received.
    perform workspace.curator_tick_seen('busy');
    assert (select last_tick_outcome from workspace.curator_settings where id) = 'busy', 'tick outcome stored';
    assert (select last_tick_at from workspace.curator_settings where id) is not null, 'tick time stored';
    begin
        perform workspace.curator_tick_seen('everything');
    exception when sqlstate '22023' then
        v_denied := true;
    end;
    assert v_denied, 'unknown outcome refused';

    -- Health: administrators only.
    v := workspace.app_curator_health('rl-boss@example.com');
    assert v ? 'jobs' and v ? 'cron_available' and v ? 'pokes_24h', 'health shape';
    assert jsonb_typeof(v->'jobs') = 'array', 'jobs is a list';
    assert v->>'last_tick_outcome' = 'busy', 'health shows the last tick';
    assert v->'running' = 'null'::jsonb or v->'running' is null, 'nothing running';
    v_denied := false;
    begin
        perform workspace.app_curator_health('rl-ann@example.com');
    exception when sqlstate '42501' then
        v_denied := true;
    end;
    assert v_denied, 'readers refused';
end;
$$;

rollback;
