-- 0010_connector_state.sql
--
-- Per-source cursors for incremental ingest.
--
-- The drafted design says "the date email threads were last checked". Nothing
-- persisted that: there is no `workspace.sync_state` table in this schema. Without
-- a durable cursor a cron either rescans everything every night or silently misses
-- a window when a run fails partway.
--
-- `cursor` is jsonb rather than a timestamp because sources need different shapes.
-- Gmail in particular is not safely incremental on time alone -- messages arrive
-- out of order and a pure `after:` query drops them. It needs `historyId`
-- alongside the timestamp.
--
-- Also carries the CRON LOCK. Per this workspace's own operating notes, parallel
-- workflow runs corrupt the runner's shared database. A daily ingest
-- and a weekly review will eventually overlap; `locked_until` makes the second
-- run stand down instead of racing.

create table if not exists workspace.connector_state (
    source          text primary key,
    cursor          jsonb       not null default '{}'::jsonb,

    last_run_at     timestamptz,
    last_success_at timestamptz,
    last_error      text,
    consecutive_failures integer not null default 0,

    -- Advisory lock. A worker sets it on start and clears it on exit; a stale
    -- lock expires on its own so a crashed run cannot block the source forever.
    locked_until    timestamptz,
    locked_by       text,

    updated_at      timestamptz not null default now()
);

comment on table workspace.connector_state is
    'Per-source ingest cursor plus an expiring advisory lock against overlapping cron runs.';
comment on column workspace.connector_state.cursor is
    'Source-shaped. Gmail needs {last_checked, history_id} -- a timestamp alone drops out-of-order mail.';
comment on column workspace.connector_state.locked_until is
    'Expiring lock. A crashed run releases by timeout rather than blocking the source forever.';

drop trigger if exists connector_state_set_updated_at on workspace.connector_state;
create trigger connector_state_set_updated_at
    before update on workspace.connector_state
    for each row
    execute function workspace.set_updated_at();

-- Lock acquisition -----------------------------------------------------------
-- Single statement so two workers cannot both believe they won.

create or replace function workspace.acquire_connector_lock(
    p_source text,
    p_owner  text,
    p_ttl_seconds integer default 3600
)
returns boolean
language plpgsql
security definer
set search_path = workspace, pg_temp
as $fn$
declare
    v_acquired boolean;
begin
    insert into workspace.connector_state (source, locked_until, locked_by)
    values (p_source, now() + make_interval(secs => p_ttl_seconds), p_owner)
    on conflict (source) do update
        set locked_until = now() + make_interval(secs => p_ttl_seconds),
            locked_by    = p_owner
        where workspace.connector_state.locked_until is null
           or workspace.connector_state.locked_until < now()
    returning true into v_acquired;

    return coalesce(v_acquired, false);
end;
$fn$;

create or replace function workspace.release_connector_lock(p_source text)
returns void
language sql
security definer
set search_path = workspace, pg_temp
as $fn$
    update workspace.connector_state
    set locked_until = null, locked_by = null
    where source = p_source;
$fn$;

alter table workspace.connector_state enable row level security;
revoke all on workspace.connector_state from anon, authenticated;
grant select, insert, update on workspace.connector_state to service_role;
grant execute on function workspace.acquire_connector_lock(text, text, integer) to service_role;
grant execute on function workspace.release_connector_lock(text) to service_role;


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.release_connector_lock(text);
-- drop function if exists workspace.acquire_connector_lock(text, text, integer);
-- drop table if exists workspace.connector_state;
