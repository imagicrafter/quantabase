-- 0065: the timer job commands name the schema the curator functions live
-- in, whatever the caller's search path; Save and the migration's repair
-- rewrite broken commands; and a job actually runs when pg_cron's worker is up.
-- Runs under both_schemas.sh (workspace and another name).

do $$
declare
    v_schema text := 'workspace'::regnamespace::text;
begin
    assert workspace._curator_cron_schema() = v_schema, 'schema from pg_proc: ' || coalesce(workspace._curator_cron_schema(), 'null');
    assert workspace._curator_cron_command('kbe-curator-tick') = format('select %I.curator_tick_poke()', v_schema), 'tick command';
    assert workspace._curator_cron_command('kbe-curator-wake') = format('select %I.curator_wake(true)', v_schema), 'wake command';
    assert not has_function_privilege('kb_engine', 'workspace._curator_cron_apply(boolean)', 'execute'), 'apply hidden from kb_engine';
    assert not has_function_privilege('anon', 'workspace._curator_cron_apply(boolean)', 'execute'), 'apply hidden from anon';
end;
$$;

-- The caller's search path does not matter (the 0057 bug: public).
set search_path = public;
do $$
begin
    assert workspace._curator_cron_command('kbe-curator-tick') not like '%public.%', 'not public';
end;
$$;
reset search_path;

-- With pg_cron: Save writes the right commands, a broken job is repaired,
-- and each command names a function that exists. One transaction, rolled back.
begin;
insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('cs-boss', 'Cron Boss', 'administrator', 'cs-boss@example.com', true, 'sub-cs-boss', 'tok-cs-boss');
update workspace.engine_settings set access = coalesce(access, '{}'::jsonb) || '{"host":"x.example.com"}'::jsonb where id;
do $$
declare
    v_schema text := 'workspace'::regnamespace::text;
    v jsonb;
    r record;
begin
    begin
        create extension if not exists pg_net;
        create extension if not exists pg_cron;
    exception when others then
        raise notice 'pg_cron/pg_net unavailable here (%): cron schema checks skipped', sqlerrm;
        return;
    end;
    if to_regclass('vault.secrets') is null then
        return;
    end if;
    -- A job owned by another role cannot be rewritten: Save says so.
    perform cron.schedule('kbe-curator-wake', '* * * * *', 'select public.curator_wake(true)');
    begin
        perform workspace.app_timer_set('cs-boss@example.com', 'x.example.com', true);
        assert false, 'a foreign-owned job must stop the save';
    exception when sqlstate '55000' then
        assert sqlerrm like '%cannot be changed by postgres%', sqlerrm;
    end;
    perform cron.unschedule('kbe-curator-wake');
    -- Jobs as 0057 left them on a hosted Engine (owned by postgres, like the
    -- migrations and the functions).
    set local role postgres;
    perform cron.schedule('kbe-curator-tick', '0 * * * *', 'select public.curator_tick_poke()');
    perform cron.schedule('kbe-curator-wake', '* * * * *', 'select public.curator_wake(true)');
    reset role;
    v := workspace.app_timer_set('cs-boss@example.com', 'x.example.com', true);
    for r in select j.jobname, j.command from cron.job j where j.jobname like 'kbe-curator-%' loop
        assert r.command = workspace._curator_cron_command(r.jobname), r.jobname || ' runs ' || r.command;
        assert r.command like 'select ' || quote_ident(v_schema) || '.%', r.jobname || ' names the schema';
        assert to_regprocedure(quote_ident(v_schema) || case r.jobname
            when 'kbe-curator-tick' then '.curator_tick_poke(text)' else '.curator_wake(boolean)' end) is not null,
            r.jobname || ' calls a function that exists';
        execute r.command;  -- the command itself runs without error
    end loop;
    assert (select count(*) from cron.job where jobname like 'kbe-curator-%') = 2, 'two jobs';
    -- The repair path (what the migration runs) fixes a broken job too.
    set local role postgres;
    perform cron.schedule('kbe-curator-wake', '* * * * *', 'select public.curator_wake(true)');
    reset role;
    perform workspace._curator_cron_apply(true);
    assert (select command from cron.job where jobname = 'kbe-curator-wake')
        = workspace._curator_cron_command('kbe-curator-wake'), 'repaired';
end;
$$;
rollback;

-- A one-second job with the real wake command, committed so pg_cron's worker
-- can see it (the curator is off here, so the wake does nothing but run).
do $$
begin
    begin
        create extension if not exists pg_net;
        create extension if not exists pg_cron;
    exception when others then
        return;
    end;
    perform cron.schedule('kbe-cron-schema-check', '1 seconds', workspace._curator_cron_command('kbe-curator-wake'));
exception when others then
    raise notice 'second-granularity cron not available here (%): job run check skipped', sqlerrm;
end;
$$;

-- If pg_cron's worker runs here, the job must succeed (wait up to 15 s).
do $$
declare
    v_status text;
begin
    if to_regclass('cron.job') is null
       or not exists (select 1 from cron.job where jobname = 'kbe-cron-schema-check') then
        return;
    end if;
    for i in 1..15 loop
        select d.status into v_status from cron.job_run_details d
        join cron.job j on j.jobid = d.jobid
        where j.jobname = 'kbe-cron-schema-check' and d.status in ('succeeded', 'failed')
        order by d.start_time desc limit 1;
        exit when v_status is not null;
        perform pg_sleep(1);
    end loop;
    perform cron.unschedule('kbe-cron-schema-check');
    if v_status is null then
        raise notice 'pg_cron worker not running here: job run check skipped';
    else
        assert v_status = 'succeeded', 'the wake job ran: ' || v_status;
    end if;

end;
$$;

-- Leave the database as the other checks expect it: no pg_cron, no pg_net.
drop extension if exists pg_cron cascade;
drop extension if exists pg_net cascade;
