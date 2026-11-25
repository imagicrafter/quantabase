-- 0057_curator_wake_and_claim.sql
--
-- Two fixes from the 2026-11-20 cold-start test (G1).
--
-- 1. THE CURATOR WAKES WHEN NEW ITEMS LAND (the owner's decision, 2026-11-20).
--    No interval to choose any more. Instead:
--      * a new source item (source_item_record inserts into source_items)
--        wakes the curator at once, through the same guarded pg_net poke the
--        timer uses (curator_tick_poke), unless it was woken in the last
--        2 minutes (debounce, curator_settings.last_wake_at);
--      * a minute job (kbe-curator-wake) is the trailing edge of that
--        debounce: it pokes only when items are waiting that arrived after
--        the last wake and the 2 minutes have passed. It is plain SQL and
--        sends nothing when nothing is waiting;
--      * a fixed hourly tick (kbe-curator-tick, minute 0) always runs, the
--        safety net: retries, missed items, summaries, history prune,
--        nightly backup. A tick with nothing waiting spends no model tokens.
--    The Timer screen keeps one switch (curator on/off) and the test button.
--    app_timer_set(text, text, integer, boolean) is replaced by
--    app_timer_set(text, text, boolean).
--    A wake never fails an ingest: any error inside it is swallowed.
--
-- 2. THE CLAIM SURVIVES A RESTART. engine_setup_claim_held() tells a
--    restarted service that the Database screen already stored this claim
--    (setup window open with a code hash) and who the owner is, so it keeps
--    the original code instead of making a new one (engine/src/app/boot-code.ts).
--    It returns no hash and no code.
--
-- Every function: SECURITY DEFINER, fixed search_path, no grant to anon or
-- authenticated.

-- ── 1. wake ─────────────────────────────────────────────────────────────────

alter table workspace.curator_settings
    add column if not exists last_wake_at timestamptz;

comment on column workspace.curator_settings.last_wake_at is
    'When new source items last woke the curator (debounce: at most one wake per 2 minutes).';

-- Wake the curator now unless it was woken in the last 2 minutes. Returns the
-- pg_net request id, or null when nothing was sent. For the trigger and the
-- minute job only (no grant).
create or replace function workspace.curator_wake(p_only_if_waiting boolean default false)
returns bigint
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_last timestamptz;
    v_go   boolean := false;
begin
    select s.last_wake_at into v_last
    from workspace.curator_settings s
    where s.id and s.enabled and s.engine_url is not null;
    if not found then
        return null;
    end if;
    if v_last is not null and v_last > now() - interval '2 minutes' then
        return null;
    end if;
    if p_only_if_waiting then
        -- Trailing edge: only items that arrived since the last wake and are
        -- still waiting for the curator.
        select exists (
            select 1 from workspace.source_items i
            where i.curated_at is null and i.deleted_at is null
              and (i.flagged is false or i.released_at is not null)
              and (i.curator_claimed_until is null or i.curator_claimed_until < now())
              and (v_last is null or i.received_at > v_last)
        ) into v_go;
        if not v_go then
            return null;
        end if;
    end if;
    update workspace.curator_settings s set last_wake_at = now() where s.id;
    return workspace.curator_tick_poke('tick');
end;
$$;

comment on function workspace.curator_wake(boolean) is
    'Poke the curator now, at most once per 2 minutes. With true, only when '
    'items arrived since the last wake are waiting.';

create or replace function workspace._curator_wake_on_insert()
returns trigger
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
begin
    begin
        perform workspace.curator_wake(false);
    exception when others then
        -- Never fail an ingest over a wake; the minute job and the hourly
        -- tick pick the items up.
        raise warning 'curator wake skipped (%)', sqlstate;
    end;
    return null;
end;
$$;

drop trigger if exists source_items_wake_curator on workspace.source_items;
create trigger source_items_wake_curator
    after insert on workspace.source_items
    for each statement
    execute function workspace._curator_wake_on_insert();

-- ── timer (administrators): one switch ──────────────────────────────────────

drop function if exists workspace.app_timer_set(text, text, integer, boolean);

create or replace function workspace._app_timer_state()
returns jsonb
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_job  jsonb;
    v_wake jsonb;
begin
    if to_regclass('cron.job') is not null then
        execute 'select jsonb_build_object(''schedule'', j.schedule, ''active'', j.active) '
                'from cron.job j where j.jobname = ''kbe-curator-tick'' limit 1'
            into v_job;
        execute 'select jsonb_build_object(''schedule'', j.schedule, ''active'', j.active) '
                'from cron.job j where j.jobname = ''kbe-curator-wake'' limit 1'
            into v_wake;
    end if;
    return jsonb_build_object(
        'cron_available', to_regclass('cron.job') is not null,
        'net_available', to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is not null,
        'vault_available', to_regclass('vault.secrets') is not null,
        'job', v_job,
        'wake_job', v_wake,
        'wake_on_new_items', exists (select 1 from pg_trigger t
                                     where t.tgname = 'source_items_wake_curator'
                                       and t.tgrelid = 'workspace.source_items'::regclass),
        'last_wake_at', (select s.last_wake_at from workspace.curator_settings s where s.id),
        'engine_url', (select s.engine_url from workspace.curator_settings s where s.id),
        'enabled', (select s.enabled from workspace.curator_settings s where s.id),
        'model', (select s.model from workspace.curator_settings s where s.id),
        'tick_secret_set', workspace._curator_vault_secret('kbe_tick_secret') is not null,
        'last_run', (select jsonb_build_object('status', r.status, 'started_at', r.started_at,
                                               'finished_at', r.finished_at, 'stats', r.stats)
                     from workspace.curator_runs r order by r.started_at desc limit 1));
end;
$$;

-- Point the timer at the service and switch the curator on or off. Makes the
-- tick secret inside the database the first time; it never leaves the
-- database. The caller names only the host, which must be the Engine's own
-- host as stored by sign-in setup; the address is built here.
create or replace function workspace.app_timer_set(p_email text, p_host text, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_tick     text := format('select %I.curator_tick_poke()', current_schema());
    v_wake     text := format('select %I.curator_wake(true)', current_schema());
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

    if to_regclass('cron.job') is not null then
        execute 'select cron.unschedule(j.jobid) from cron.job j '
                'where j.jobname in (''kbe-curator-tick'', ''kbe-curator-wake'')';
        if v_on then
            -- The safety net, fixed at once an hour.
            execute 'select cron.schedule(''kbe-curator-tick'', ''0 * * * *'', $1)' using v_tick;
            -- The trailing edge of the 2-minute debounce: SQL only, pokes
            -- only when new items are waiting.
            execute 'select cron.schedule(''kbe-curator-wake'', ''* * * * *'', $1)' using v_wake;
        end if;
    end if;
    return workspace._app_timer_state();
end;
$$;

-- An Engine whose timer was on before this migration: move it to the fixed
-- schedule now (the old 5/15/60 choice is gone).
do $$
begin
    if to_regclass('cron.job') is not null
       and exists (select 1 from workspace.curator_settings s where s.id and s.enabled) then
        execute 'select cron.unschedule(j.jobid) from cron.job j '
                'where j.jobname in (''kbe-curator-tick'', ''kbe-curator-wake'')';
        execute 'select cron.schedule(''kbe-curator-tick'', ''0 * * * *'', $1)'
            using format('select %I.curator_tick_poke()', current_schema());
        execute 'select cron.schedule(''kbe-curator-wake'', ''* * * * *'', $1)'
            using format('select %I.curator_wake(true)', current_schema());
    end if;
exception when others then
    raise warning 'timer not moved to the fixed schedule (%); save it once on the Timer screen', sqlstate;
end;
$$;

-- ── 2. the claim a restarted service keeps ──────────────────────────────────

create or replace function workspace.engine_setup_claim_held()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object(
        'held', coalesce((select s.setup_state = 'open' and s.setup_code_hash is not null
                          from workspace.engine_settings s where s.id), false),
        'owner', (select lower(p.email) from workspace.principals p
                  where p.role = 'administrator' and p.active and p.email is not null
                  order by p.created_at, p.id limit 1));
$$;

comment on function workspace.engine_setup_claim_held() is
    'Whether the setup window holds a first-run claim (no hash returned), and the owner.';

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace.curator_wake(boolean) from public;
revoke all on function workspace.curator_wake(boolean) from anon, authenticated;
revoke all on function workspace._curator_wake_on_insert() from public;
revoke all on function workspace._curator_wake_on_insert() from anon, authenticated;
revoke all on function workspace._app_timer_state() from public;
revoke all on function workspace._app_timer_state() from anon, authenticated;
revoke all on function workspace.app_timer_set(text, text, boolean) from public;
revoke all on function workspace.app_timer_set(text, text, boolean) from anon, authenticated;
grant execute on function workspace.app_timer_set(text, text, boolean) to kb_engine;
revoke all on function workspace.engine_setup_claim_held() from public;
revoke all on function workspace.engine_setup_claim_held() from anon, authenticated;
grant execute on function workspace.engine_setup_claim_held() to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select workspace.engine_setup_claim_held();          -- {"held": ..., "owner": ...}
-- select jobname, schedule from cron.job where jobname like 'kbe-curator-%';
--
-- ROLLBACK ----------------------------------------------------------------
-- drop trigger source_items_wake_curator on workspace.source_items;
-- drop function workspace._curator_wake_on_insert(), workspace.curator_wake(boolean),
--   workspace.engine_setup_claim_held(), workspace.app_timer_set(text, text, boolean);
-- select cron.unschedule('kbe-curator-wake');
-- re-run 0054's app_timer_set and _app_timer_state.
