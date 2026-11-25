-- 0008_raw_captures.sql
--
-- BRONZE layer -- immutable raw source text.
--
-- Why this exists: the single most likely recurring operation is changing the
-- distillation prompt. Without a raw layer, bumping DISTILLER_VERSION means
-- re-fetching every Gmail thread and re-reading every Drive document. For email
-- that can be impossible: threads get moved, deleted, or fall outside the token's
-- reach. Bronze makes re-distillation a local operation with no API calls and no
-- fetch cost.
--
-- SCOPE: fetched sources only -- gmail, fireflies, drive.
-- The wiki is deliberately EXCLUDED. `~/github/knowledge` is a git repository:
-- already immutable, already versioned, already re-readable. Snapshotting it here
-- would duplicate content git holds better.
--
-- APPEND-ONLY. A changed source produces a NEW row, never an update. Enforced at
-- the privilege level below, not by convention.

create table if not exists workspace.raw_captures (
    id            uuid primary key default gen_random_uuid(),

    source        text        not null,
    external_id   text        not null,
    -- sha256 of raw_text. Same content re-fetched = same hash = no new row.
    capture_hash  text        not null,

    raw_text      text        not null,
    -- Everything the API returned that is not the body: headers, participants,
    -- thread ids, mime type, folder path. Whatever a future distiller might want.
    raw_metadata  jsonb       not null default '{}'::jsonb,

    fetched_at    timestamptz not null default now(),

    constraint raw_captures_version_uniq
        unique (source, external_id, capture_hash),
    constraint raw_captures_source_values
        check (source in ('gmail', 'fireflies', 'drive')),
    constraint raw_captures_not_blank
        check (length(btrim(external_id)) > 0 and length(raw_text) > 0)
);

comment on table workspace.raw_captures is
    'Bronze layer: immutable raw source text. Append-only. Wiki excluded -- git is its bronze.';
comment on column workspace.raw_captures.capture_hash is
    'sha256 of raw_text. Re-fetching unchanged content inserts nothing.';

-- Newest capture per document. Index name must NOT collide with the view below:
-- indexes and views share one namespace in pg_class.
create index if not exists raw_captures_latest_idx
    on workspace.raw_captures (source, external_id, fetched_at desc);

create index if not exists raw_captures_fetched
    on workspace.raw_captures (fetched_at desc);

create or replace view workspace.raw_captures_latest as
select distinct on (source, external_id)
    id, source, external_id, capture_hash, raw_text, raw_metadata, fetched_at
from workspace.raw_captures
order by source, external_id, fetched_at desc;

comment on view workspace.raw_captures_latest is
    'Most recent capture per document. Re-distillation reads from here.';

-- Access posture -------------------------------------------------------------
-- Append-only is enforced by privilege: INSERT and SELECT only. No UPDATE, no
-- DELETE, not even for the writer role. A bronze layer that can be rewritten is
-- not a bronze layer.

alter table workspace.raw_captures enable row level security;

revoke all on workspace.raw_captures from anon, authenticated;
grant select, insert on workspace.raw_captures to service_role;
grant select on workspace.raw_captures_latest to service_role;


-- ROLLBACK -------------------------------------------------------------------
-- drop view if exists workspace.raw_captures_latest;
-- drop table if exists workspace.raw_captures;
