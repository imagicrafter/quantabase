-- 0001_documents_table.sql
--
-- workspace.documents -- one row per DOCUMENT (not per chunk).
--
-- A wiki page, an email thread, a meeting, an artifact. Sectioning applies only
-- above a size threshold, on `##` boundaries, and never below `##`; section rows
-- point at their parent via `parent_external_id`.
--
-- This table is a DERIVED, DISPOSABLE index. Git and the upstream sources remain
-- authoritative. It must be truncatable and fully rebuildable with nothing lost.
--
-- Coexists with workspace.memory_chunks. Nothing here reads or writes that table.

-- pgvector is already installed on this project (public, 0.8.0). Assert rather
-- than `create extension`, so this migration modifies nothing outside the
-- `workspace` schema. HNSW indexes require pgvector >= 0.5.0.
do $$
begin
    if not exists (select 1 from pg_extension where extname = 'vector') then
        raise exception 'pgvector is not installed; workspace.documents needs it';
    end if;
end;
$$;

create table if not exists workspace.documents (
    id                  uuid primary key default gen_random_uuid(),

    -- Identity. (source, external_id) is the connector's stable handle on a row.
    source              text        not null,
    external_id         text        not null,
    source_hash         text        not null,

    -- Sectioning. Null for whole documents and for parent rows.
    parent_external_id  text,

    -- Content. Three texts: title anchors, distillation is embedded,
    -- body is what keyword search runs over.
    title               text        not null,
    body                text        not null,
    distillation        text,

    -- Retrieval
    embedding           vector(384),
    tsv                 tsvector,

    -- Provenance / description
    url                 text,
    author              text,
    domains             text[]      not null,
    visibility          text        not null default 'private',
    tier                smallint    not null default 4,
    metadata            jsonb       not null default '{}'::jsonb,

    source_created_at   timestamptz,
    indexed_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    deleted_at          timestamptz,

    constraint documents_source_external_id_uniq
        unique (source, external_id),
    constraint documents_tier_range
        check (tier between 1 and 4),
    constraint documents_visibility_values
        check (visibility in ('private', 'shared')),
    -- An empty domains array can never intersect any caller's grants, so the row
    -- would be invisible to everyone forever with no error raised. Forbid it.
    constraint documents_domains_non_empty
        check (cardinality(domains) > 0),
    constraint documents_source_not_blank
        check (length(btrim(source)) > 0),
    constraint documents_external_id_not_blank
        check (length(btrim(external_id)) > 0),
    constraint documents_title_not_blank
        check (length(btrim(title)) > 0)
);

comment on table workspace.documents is
    'Document-grained knowledge index. Derived and disposable; sources are authoritative.';
comment on column workspace.documents.distillation is
    'Extracted meaning. THIS is what gets embedded. body is what gets keyword-searched.';
comment on column workspace.documents.domains is
    'Access labels. Intersected against a principal''s grants at retrieval. Never empty.';
comment on column workspace.documents.tier is
    '1 = human-verified, 2 = curated, 3 = distilled thread/meeting, 4 = raw.';
comment on column workspace.documents.source_hash is
    'Hash of the connector source text. Unchanged hash means skip re-embedding.';

-- Indexes -------------------------------------------------------------------

-- HNSW over IVFFlat: IVFFlat requires a populated table to build a useful list
-- structure and this table starts empty.
create index if not exists documents_embedding_hnsw
    on workspace.documents using hnsw (embedding vector_cosine_ops);

create index if not exists documents_tsv_gin
    on workspace.documents using gin (tsv);

create index if not exists documents_domains_gin
    on workspace.documents using gin (domains);

create index if not exists documents_live
    on workspace.documents (source, external_id)
    where deleted_at is null;

create index if not exists documents_parent
    on workspace.documents (parent_external_id)
    where parent_external_id is not null;

-- tsv maintenance -----------------------------------------------------------

create or replace function workspace.documents_tsv_trigger()
returns trigger
language plpgsql
as $$
begin
    new.tsv := to_tsvector(
        'english',
        coalesce(new.title, '') || ' ' || coalesce(new.body, '')
    );
    return new;
end;
$$;

drop trigger if exists documents_tsv_update on workspace.documents;
create trigger documents_tsv_update
    before insert or update of title, body
    on workspace.documents
    for each row
    execute function workspace.documents_tsv_trigger();

drop trigger if exists documents_set_updated_at on workspace.documents;
create trigger documents_set_updated_at
    before update on workspace.documents
    for each row
    execute function workspace.set_updated_at();

-- Access posture ------------------------------------------------------------
-- Fail closed from the first migration. Reads go through the SECURITY DEFINER
-- retrieval function in 0003, never directly against the table.

alter table workspace.documents enable row level security;

revoke all on workspace.documents from anon, authenticated;


-- ROLLBACK -------------------------------------------------------------------
-- drop trigger if exists documents_set_updated_at on workspace.documents;
-- drop trigger if exists documents_tsv_update on workspace.documents;
-- drop function if exists workspace.documents_tsv_trigger();
-- drop table if exists workspace.documents;
-- (workspace.memory_chunks and its functions are untouched by this migration.)
