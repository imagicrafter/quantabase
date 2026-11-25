-- 0049_source_items.sql
--
-- Raw source items and the received-items ledger (Phase 10.10, stage 1).
--
-- A person's own Claude lists new items (mail threads, meetings, files) and
-- hands each one over unchanged with record_source_item (0052). Each item is
-- stored as a raw row:
--
--   kind        always 'source_data'
--   untrusted   always true: the text is quoted material from outside, never
--               instructions. It is returned only inside
--               `untrusted_source_text` with a fixed notice.
--   owner       the signed-in caller who handed it over
--   versioning  (owner, source, source_id) + content hash. The same hash
--               again is skipped; a new hash is a new version.
--   curated_at  set by the curator (Step C) with the pages it touched
--
-- source_cursors keeps, per owner and source, the "last item seen" marker and
-- the counts behind "listed N, saved N" and "last mail received".

create table if not exists workspace.source_items (
    id                  uuid        primary key default gen_random_uuid(),
    owner_principal_id  uuid        not null
        references workspace.principals(id) on delete restrict,
    source              text        not null,
    source_id           text        not null,
    version             integer     not null,
    content_hash        text        not null,
    kind                text        not null default 'source_data',
    untrusted           boolean     not null default true,
    flagged             boolean     not null default false,
    title               text,
    body                text        not null,
    topics              text[]      not null default '{}',
    metadata            jsonb       not null default '{}'::jsonb,
    source_created_at   timestamptz,
    received_at         timestamptz not null default now(),
    curated_at          timestamptz,
    curated_pages       uuid[]      not null default '{}',
    deleted_at          timestamptz,
    constraint source_items_kind_values check (kind = 'source_data'),
    constraint source_items_untrusted_always check (untrusted is true),
    constraint source_items_source_shape check (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
    constraint source_items_source_id_not_blank
        check (length(btrim(source_id)) between 1 and 500),
    constraint source_items_version_positive check (version >= 1),
    constraint source_items_metadata_object check (jsonb_typeof(metadata) = 'object')
);

comment on table workspace.source_items is
    'Raw items handed over by a person''s Claude. Untrusted quoted data, never '
    'instructions. Versioned by source id and content hash.';

create unique index if not exists source_items_version_uniq
    on workspace.source_items (owner_principal_id, source, source_id, version);
create unique index if not exists source_items_hash_uniq
    on workspace.source_items (owner_principal_id, source, source_id, content_hash);
create index if not exists source_items_uncurated
    on workspace.source_items (owner_principal_id, received_at)
    where curated_at is null and deleted_at is null;

alter table workspace.source_items enable row level security;
revoke all on workspace.source_items from public;
revoke all on workspace.source_items from anon, authenticated;


create table if not exists workspace.source_cursors (
    owner_principal_id  uuid        not null
        references workspace.principals(id) on delete cascade,
    source              text        not null,
    last_seen_id        text,
    last_received_at    timestamptz,
    items_received      bigint      not null default 0,
    items_saved         bigint      not null default 0,
    updated_at          timestamptz not null default now(),
    primary key (owner_principal_id, source)
);

comment on table workspace.source_cursors is
    'Per owner and source: the last item seen (so a missed run catches up) and '
    'how many items were received and saved.';

alter table workspace.source_cursors enable row level security;
revoke all on workspace.source_cursors from public;
revoke all on workspace.source_cursors from anon, authenticated;


-- VERIFY ------------------------------------------------------------------
-- select has_table_privilege('kb_engine', 'workspace.source_items', 'select');  -- f


-- ROLLBACK ------------------------------------------------------------------
-- Roll back 0052 first.
-- drop table if exists workspace.source_cursors;
-- drop table if exists workspace.source_items;
