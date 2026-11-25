-- 0026_events.sql
--
-- One append-only event log for kb-engine AND its agent host.
--
-- Why: DigitalOcean job logs are unreliable (websocket 1011, empty invocation
-- lists) and are purged on every deploy. On 2026-10-23 the Fireflies puller
-- failed to write a meeting's wiki page for a week and reported success; no
-- record survived to say why. Jobs now write their own record here.
--
-- Shape is chosen so a later exporter can turn it into Prometheus metrics for
-- Grafana: only service / component / event / status are low-cardinality
-- labels. Ids, titles and anything else go in `attrs`.
--
-- Conventions (enforced in scripts/obs/events.py, not here):
--   event  lowercase noun.verb, e.g. run.started, run.finished, wiki.write_failed
--   level  debug | info | warn | error
--   status ok | failed | skipped (null for events that are not outcomes)
--   a run.started with no matching run.finished (same run_id) = the process died
--
-- Append-only: kb_ingest can insert and read, never update or delete.
-- Retention (90 days) is a prune job, added with the exporter.

create table if not exists workspace.events (
    id          bigint generated always as identity primary key,
    ts          timestamptz not null default now(),
    service     text        not null,
    component   text        not null,
    event       text        not null,
    level       text        not null default 'info'
                check (level in ('debug', 'info', 'warn', 'error')),
    status      text        check (status in ('ok', 'failed', 'skipped')),
    run_id      text,
    commit_sha  text,
    duration_ms integer,
    attrs       jsonb       not null default '{}'::jsonb,
    constraint events_event_format check (event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

comment on table workspace.events is
    'Append-only event log for kb-engine and Hermes. Source for the future Prometheus exporter / Grafana views.';
comment on column workspace.events.attrs is
    'Free-form detail (ids, counts, error text). Never secrets -- scripts/obs scrubs secret-looking keys.';

create index if not exists events_ts_idx on workspace.events (ts desc);
create index if not exists events_component_event_ts_idx
    on workspace.events (service, component, event, ts desc);
create index if not exists events_run_id_idx on workspace.events (run_id) where run_id is not null;

alter table workspace.events enable row level security;

-- Fail closed: anon / authenticated are the PostgREST roles a browser can reach.
revoke all on workspace.events from anon, authenticated;

-- kb_ingest (pullers, agent host) appends and reads; service_role also prunes
-- (the 90-day retention job). Nobody updates a row once written.
grant select, insert on workspace.events to kb_ingest;
grant select, insert, delete on workspace.events to service_role;
grant usage on sequence workspace.events_id_seq to kb_ingest, service_role;

drop policy if exists kb_ingest_select on workspace.events;
drop policy if exists kb_ingest_insert on workspace.events;
create policy kb_ingest_select on workspace.events
    for select to kb_ingest using (true);
create policy kb_ingest_insert on workspace.events
    for insert to kb_ingest with check (true);


-- ROLLBACK -------------------------------------------------------------------
-- drop table if exists workspace.events;
