-- 0064_curator_run_lease.sql
--
-- The curator stall of 2026-11-21 (test Engine): after one good run the
-- curator went quiet for 16 hours with nothing in the log, and the Timer
-- screen then said "Last run: running" for a run the service no longer had.
--
-- 1. A RUN HOLDS A SHORT LEASE, RENEWED WHILE IT WORKS. curator_run_start
--    used to treat a run as live for 15 minutes from its start, whatever
--    happened to the service. Now each run has lease_until (3 minutes by
--    default), renewed every minute by curator_run_heartbeat. A run whose
--    service died or restarted stops renewing and is closed as failed by the
--    next start; any run older than 30 minutes is closed too (hard cap).
--    curator_run_reclaim(holder) runs when the service boots: it closes
--    runs whose lease ran out and runs started by an older service (a
--    different holder, or no holder: rows written before this migration).
--
-- 2. THE SERVICE NOTES EVERY TICK IT RECEIVES. curator_tick_seen(outcome)
--    stores when the last poke arrived and what the service did with it
--    (started, busy), so the screens can tell "no poke arrived" from "pokes
--    arrive but nothing runs".
--
-- 3. THE SCREENS SEE THE CRON JOBS. app_curator_health(email), for
--    administrators: both cron jobs (schedule, active, last run and its
--    status from cron.job_run_details), the failed pokes of the last 24
--    hours from net._http_response, the last tick received, and the run
--    that holds the lease.
--
-- Every function: SECURITY DEFINER, fixed search_path, no grant to anon or
-- authenticated.

-- ── 1. the lease ────────────────────────────────────────────────────────────

alter table workspace.curator_runs
    add column if not exists lease_until timestamptz,
    add column if not exists holder text;

comment on column workspace.curator_runs.lease_until is
    'Until when the run holds the curator; renewed every minute while it works.';
comment on column workspace.curator_runs.holder is
    'Which service process started the run (a random id per boot).';

alter table workspace.curator_runs drop constraint if exists curator_runs_holder_len;
alter table workspace.curator_runs add constraint curator_runs_holder_len
    check (holder is null or length(holder) between 1 and 100);

-- Close runs that no longer hold the curator. Returns how many were closed.
create or replace function workspace._curator_runs_close_stale(p_holder text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_n integer;
begin
    update workspace.curator_runs r
       set status = 'failed', finished_at = now(),
           stats = r.stats || jsonb_build_object('error',
               case when r.started_at < now() - interval '30 minutes' then 'run did not finish in 30 minutes'
                    when r.lease_until is not null and r.lease_until < now() then 'run stopped renewing its lease'
                    when r.lease_until is null and r.started_at < now() - interval '15 minutes' then 'run did not finish'
                    else 'service restarted during the run' end)
     where r.status = 'running'
       and (r.started_at < now() - interval '30 minutes'
            or (r.lease_until is not null and r.lease_until < now())
            or (r.lease_until is null and r.started_at < now() - interval '15 minutes')
            or (p_holder is not null and (r.holder is null or r.holder <> p_holder)));
    get diagnostics v_n = row_count;
    return v_n;
end;
$$;

-- Start a run unless a live one holds the lease. Returns the run id, or null
-- when busy.
create or replace function workspace.curator_run_start(p_mode text, p_holder text, p_lease_seconds integer default 180)
returns uuid
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_id uuid;
begin
    if p_holder is null or length(p_holder) not between 1 and 100 then
        raise exception 'holder is required' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtext('kbe-curator-run'));
    perform workspace._curator_runs_close_stale(null);
    if exists (select 1 from workspace.curator_runs r where r.status = 'running') then
        return null;
    end if;
    insert into workspace.curator_runs (mode, holder, lease_until)
    values (case when p_mode = 'batch' then 'batch' else 'tick' end, p_holder,
            now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 180), 900))))
    returning id into v_id;
    return v_id;
end;
$$;

-- The old one-argument start keeps working (an older service during a
-- deploy), now with the default lease and no holder.
create or replace function workspace.curator_run_start(p_mode text default 'tick')
returns uuid
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_id uuid;
begin
    perform pg_advisory_xact_lock(hashtext('kbe-curator-run'));
    perform workspace._curator_runs_close_stale(null);
    if exists (select 1 from workspace.curator_runs r where r.status = 'running') then
        return null;
    end if;
    insert into workspace.curator_runs (mode, lease_until)
    values (case when p_mode = 'batch' then 'batch' else 'tick' end, now() + interval '15 minutes')
    returning id into v_id;
    return v_id;
end;
$$;

-- Renew a run's lease. False when the run no longer holds it (closed as
-- stale): the run then stops starting new work.
create or replace function workspace.curator_run_heartbeat(p_run uuid, p_lease_seconds integer default 180)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    update workspace.curator_runs r
       set lease_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 180), 900)))
     where r.id = p_run and r.status = 'running';
    return found;
end;
$$;

-- On boot: close runs left by an earlier service process. Returns how many.
create or replace function workspace.curator_run_reclaim(p_holder text)
returns integer
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    if p_holder is null or length(p_holder) not between 1 and 100 then
        raise exception 'holder is required' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtext('kbe-curator-run'));
    return workspace._curator_runs_close_stale(p_holder);
end;
$$;

-- ── 2. ticks received ───────────────────────────────────────────────────────

alter table workspace.curator_settings
    add column if not exists last_tick_at timestamptz,
    add column if not exists last_tick_outcome text;

alter table workspace.curator_settings drop constraint if exists curator_settings_tick_outcome_values;
alter table workspace.curator_settings add constraint curator_settings_tick_outcome_values
    check (last_tick_outcome is null or last_tick_outcome in ('started', 'busy', 'skipped', 'failed'));

comment on column workspace.curator_settings.last_tick_at is
    'When the service last received a poke with the right timer secret.';

create or replace function workspace.curator_tick_seen(p_outcome text)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    if p_outcome not in ('started', 'busy', 'skipped', 'failed') then
        raise exception 'unknown tick outcome' using errcode = '22023';
    end if;
    update workspace.curator_settings s
       set last_tick_at = now(), last_tick_outcome = p_outcome
     where s.id;
end;
$$;

-- ── 3. health for the screens ───────────────────────────────────────────────

create or replace function workspace._curator_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_jobs  jsonb := '[]'::jsonb;
    v_pokes jsonb;
begin
    if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
        execute $q$
            select coalesce(jsonb_agg(jsonb_build_object(
                       'name', j.jobname, 'schedule', j.schedule, 'active', j.active,
                       'last_start', d.start_time, 'last_status', d.status,
                       'last_message', left(d.return_message, 200)) order by j.jobname), '[]'::jsonb)
            from cron.job j
            left join lateral (
                select x.start_time, x.status, x.return_message
                from cron.job_run_details x where x.jobid = j.jobid
                order by x.start_time desc nulls last limit 1) d on true
            where j.jobname in ('kbe-curator-tick', 'kbe-curator-wake')
        $q$ into v_jobs;
    elsif to_regclass('cron.job') is not null then
        execute $q$
            select coalesce(jsonb_agg(jsonb_build_object('name', j.jobname, 'schedule', j.schedule,
                       'active', j.active) order by j.jobname), '[]'::jsonb)
            from cron.job j where j.jobname in ('kbe-curator-tick', 'kbe-curator-wake')
        $q$ into v_jobs;
    end if;

    if to_regclass('net._http_response') is not null then
        execute $q$
            select jsonb_build_object(
                'total', count(*),
                'failed', count(*) filter (where r.timed_out is true or r.error_msg is not null
                                              or r.status_code is null or r.status_code not between 200 and 299),
                'last_at', max(r.created),
                'last_failure_at', max(r.created) filter (where r.timed_out is true or r.error_msg is not null
                                              or r.status_code is null or r.status_code not between 200 and 299),
                'last_error', (array_agg(left(coalesce(nullif(r.error_msg, ''), 'HTTP ' || r.status_code::text, 'timed out'), 200)
                                         order by r.created desc)
                               filter (where r.timed_out is true or r.error_msg is not null
                                          or r.status_code is null or r.status_code not between 200 and 299))[1])
            from net._http_response r
            where r.created > now() - interval '24 hours'
        $q$ into v_pokes;
    end if;

    return jsonb_build_object(
        'cron_available', to_regclass('cron.job') is not null,
        'jobs', coalesce(v_jobs, '[]'::jsonb),
        'pokes_24h', v_pokes,
        'last_tick_at', (select s.last_tick_at from workspace.curator_settings s where s.id),
        'last_tick_outcome', (select s.last_tick_outcome from workspace.curator_settings s where s.id),
        'running', (select jsonb_build_object('started_at', r.started_at, 'lease_until', r.lease_until)
                    from workspace.curator_runs r where r.status = 'running'
                    order by r.started_at desc limit 1),
        'items_waiting', (select count(*) from workspace.source_items i
                          where i.curated_at is null and i.deleted_at is null
                            and (i.flagged is false or i.released_at is not null)));
end;
$$;

create or replace function workspace.app_curator_health(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._admin_require(p_email);
    return workspace._curator_health();
end;
$$;

comment on function workspace.app_curator_health(text) is
    'Administrators: cron jobs and their last runs, failed pokes (24 h), last tick received, the run holding the lease.';

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._curator_runs_close_stale(text) from public;
revoke all on function workspace._curator_runs_close_stale(text) from anon, authenticated;
revoke all on function workspace.curator_run_start(text, text, integer) from public;
revoke all on function workspace.curator_run_start(text, text, integer) from anon, authenticated;
grant execute on function workspace.curator_run_start(text, text, integer) to kb_engine;
revoke all on function workspace.curator_run_start(text) from public;
revoke all on function workspace.curator_run_start(text) from anon, authenticated;
grant execute on function workspace.curator_run_start(text) to kb_engine;
revoke all on function workspace.curator_run_heartbeat(uuid, integer) from public;
revoke all on function workspace.curator_run_heartbeat(uuid, integer) from anon, authenticated;
grant execute on function workspace.curator_run_heartbeat(uuid, integer) to kb_engine;
revoke all on function workspace.curator_run_reclaim(text) from public;
revoke all on function workspace.curator_run_reclaim(text) from anon, authenticated;
grant execute on function workspace.curator_run_reclaim(text) to kb_engine;
revoke all on function workspace.curator_tick_seen(text) from public;
revoke all on function workspace.curator_tick_seen(text) from anon, authenticated;
grant execute on function workspace.curator_tick_seen(text) to kb_engine;
revoke all on function workspace._curator_health() from public;
revoke all on function workspace._curator_health() from anon, authenticated;
revoke all on function workspace.app_curator_health(text) from public;
revoke all on function workspace.app_curator_health(text) from anon, authenticated;
grant execute on function workspace.app_curator_health(text) to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select id, status, started_at, lease_until, holder from workspace.curator_runs order by started_at desc limit 3;
-- select workspace._curator_health();
--
-- ROLLBACK ----------------------------------------------------------------
-- drop function workspace.app_curator_health(text), workspace._curator_health(),
--   workspace.curator_tick_seen(text), workspace.curator_run_reclaim(text),
--   workspace.curator_run_heartbeat(uuid, integer), workspace.curator_run_start(text, text, integer),
--   workspace._curator_runs_close_stale(text);
-- re-run 0053's curator_run_start(text).
-- alter table workspace.curator_settings drop constraint curator_settings_tick_outcome_values,
--   drop column last_tick_at, drop column last_tick_outcome;
-- alter table workspace.curator_runs drop constraint curator_runs_holder_len,
--   drop column lease_until, drop column holder;
