-- 0065_curator_cron_schema.sql
--
-- The curator stall, root cause (test Engine, 2026-11-21): every run of both
-- timer jobs failed since 0057 with
--     ERROR: function public.curator_tick_poke() does not exist
--     ERROR: function public.curator_wake(boolean) does not exist
-- The job commands were built from current_schema(), which is the schema of
-- whoever runs the statement: `public` for the migration's DO block on a
-- hosted project (search path "$user", public, ...), and not reliably the
-- Engine's schema elsewhere either. Saving the Timer screen did not repair it.
--
-- 1. THE COMMANDS NAME THE SCHEMA THE FUNCTIONS LIVE IN. _curator_cron_schema()
--    reads the schema of curator_tick_poke from pg_proc (by its own
--    schema-qualified name, which the schema rewrite renames), so the
--    commands are right whatever the search path of the caller.
--
-- 2. ONE PLACE SCHEDULES THE JOBS. _curator_cron_apply(on) removes both jobs
--    and, when on, creates them again with the right commands, then checks
--    each command names a function that exists. app_timer_set (Timer "Save")
--    calls it every time, so a Save always rewrites the commands.
--
-- 3. REPAIR. Applying this migration reschedules the jobs of an Engine whose
--    timer is on (or that has either job), so a live Engine is fixed by the
--    update alone. Running it again changes nothing.
--
-- Every function: SECURITY DEFINER, fixed search_path, no grant to anon or
-- authenticated; the helpers have no grant to any API role.

-- ── 1. the schema the curator functions live in ─────────────────────────────

create or replace function workspace._curator_cron_schema()
returns text
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select n.nspname::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.oid = 'workspace.curator_tick_poke(text)'::regprocedure;
$$;

comment on function workspace._curator_cron_schema() is
    'The schema the curator functions live in (from pg_proc), for the cron job commands.';

-- The exact command each timer job runs.
create or replace function workspace._curator_cron_command(p_job text)
returns text
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_schema text := workspace._curator_cron_schema();
begin
    return case p_job
        when 'kbe-curator-tick' then format('select %I.curator_tick_poke()', v_schema)
        when 'kbe-curator-wake' then format('select %I.curator_wake(true)', v_schema)
    end;
end;
$$;

comment on function workspace._curator_cron_command(text) is
    'The command for kbe-curator-tick or kbe-curator-wake, naming the Engine''s own schema.';

-- ── 2. (re)create both jobs ─────────────────────────────────────────────────

create or replace function workspace._curator_cron_apply(p_on boolean)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_name text;
    v_cmd  text;
    v_live text;
begin
    if to_regclass('cron.job') is null then
        return;
    end if;
    -- pg_cron lets a role remove only its own jobs. A job of the same name
    -- owned by another role cannot be rewritten from here: say so plainly
    -- instead of leaving it running its old command.
    execute 'select string_agg(j.jobname || '' (owned by '' || j.username || '')'', '', '') from cron.job j '
            'where j.jobname in (''kbe-curator-tick'', ''kbe-curator-wake'') and j.username <> current_user'
        into v_live;
    if v_live is not null then
        raise exception 'timer job % cannot be changed by %: remove it as that role, then save the timer again',
            v_live, current_user using errcode = '55000';
    end if;
    execute 'select cron.unschedule(j.jobid) from cron.job j '
            'where j.jobname in (''kbe-curator-tick'', ''kbe-curator-wake'')';
    if not coalesce(p_on, false) then
        return;
    end if;
    -- The safety net, once an hour; and the trailing edge of the 2-minute
    -- debounce, SQL only, which pokes only when new items are waiting.
    execute 'select cron.schedule(''kbe-curator-tick'', ''0 * * * *'', $1)'
        using workspace._curator_cron_command('kbe-curator-tick');
    execute 'select cron.schedule(''kbe-curator-wake'', ''* * * * *'', $1)'
        using workspace._curator_cron_command('kbe-curator-wake');
    -- What is scheduled now must be exactly what was asked for.
    foreach v_name in array array['kbe-curator-tick', 'kbe-curator-wake'] loop
        v_cmd := workspace._curator_cron_command(v_name);
        execute 'select string_agg(j.command, '' | '') from cron.job j where j.jobname = $1'
            into v_live using v_name;
        if v_live is distinct from v_cmd then
            raise exception 'timer job % runs "%", expected "%"', v_name, coalesce(v_live, 'nothing'), v_cmd
                using errcode = '55000';
        end if;
    end loop;
end;
$$;

comment on function workspace._curator_cron_apply(boolean) is
    'Removes both timer jobs and, when on, creates them again with commands naming the Engine''s schema.';

-- ── Timer "Save" ────────────────────────────────────────────────────────────
-- As 0057, but the jobs are always (re)created through _curator_cron_apply.
-- The caller names only the host, which must be the Engine's own host as
-- stored by sign-in setup; the address is built here.
create or replace function workspace.app_timer_set(p_email text, p_host text, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_id       uuid;
    v_stored   text := (select lower(btrim(s.access->>'host')) from workspace.engine_settings s where s.id);
    v_host     text := lower(btrim(coalesce(p_host, '')));
    v_on       boolean := coalesce(p_enabled, false);
begin
    perform workspace._admin_require(p_email);
    if v_stored is null or v_stored !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' then
        raise exception 'set up sign-in first: the Engine''s host is not stored yet' using errcode = '22023';
    end if;
    if v_host <> v_stored then
        raise exception 'the timer can only call this Engine''s own host' using errcode = '22023';
    end if;
    if v_on and (to_regclass('cron.job') is null or to_regclass('vault.secrets') is null
        or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null) then
        raise exception 'the timer needs the pg_cron, pg_net and Vault extensions' using errcode = '55000';
    end if;

    update workspace.curator_settings s
       set engine_url = 'https://' || v_stored || '/internal/curator/tick',
           enabled = v_on, updated_at = now()
     where s.id;

    if v_on and workspace._curator_vault_secret('kbe_tick_secret') is null then
        execute 'select id from vault.secrets where name = ''kbe_tick_secret'' limit 1' into v_id;
        if v_id is null then
            execute 'select vault.create_secret($1, ''kbe_tick_secret'', ''Curator timer secret'')'
                using encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text
                                               || clock_timestamp()::text, 'UTF8')), 'hex');
        end if;
    end if;

    perform workspace._curator_cron_apply(v_on);
    return workspace._app_timer_state();
end;
$$;

-- ── 3. repair a live Engine ─────────────────────────────────────────────────
-- An Engine whose timer is on, or that has either job (with whatever command),
-- gets both jobs rewritten now. Nothing else changes.
do $$
declare
    v_has_jobs boolean := false;
begin
    if to_regclass('cron.job') is null then
        return;
    end if;
    execute 'select exists (select 1 from cron.job j '
            'where j.jobname in (''kbe-curator-tick'', ''kbe-curator-wake''))' into v_has_jobs;
    if v_has_jobs or exists (select 1 from workspace.curator_settings s where s.id and s.enabled) then
        perform workspace._curator_cron_apply(true);
    end if;
exception when sqlstate '55000' then
    -- A job owned by another role: the update still applies; the Timer screen
    -- shows the failing job and Save names the fix.
    raise warning 'timer jobs not repaired: %', sqlerrm;
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────
revoke all on function workspace._curator_cron_schema() from public;
revoke all on function workspace._curator_cron_schema() from anon, authenticated;
revoke all on function workspace._curator_cron_command(text) from public;
revoke all on function workspace._curator_cron_command(text) from anon, authenticated;
revoke all on function workspace._curator_cron_apply(boolean) from public;
revoke all on function workspace._curator_cron_apply(boolean) from anon, authenticated;
revoke all on function workspace.app_timer_set(text, text, boolean) from public;
revoke all on function workspace.app_timer_set(text, text, boolean) from anon, authenticated;
grant execute on function workspace.app_timer_set(text, text, boolean) to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select jobname, command from cron.job where jobname like 'kbe-curator-%';
--   -- expect: select workspace.curator_tick_poke() / select workspace.curator_wake(true)
-- select status, return_message from cron.job_run_details order by start_time desc limit 4;
--
-- ROLLBACK ----------------------------------------------------------------
-- re-run 0057's app_timer_set(text, text, boolean);
-- drop function workspace._curator_cron_apply(boolean), workspace._curator_cron_command(text),
--   workspace._curator_cron_schema();
-- (leave the jobs: their commands are now correct)
