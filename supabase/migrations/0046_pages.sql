-- 0046_pages.sql
--
-- Wiki pages live in the database: one row per page, one owner per row.
--
-- A page sits in a drawer (`drawer`, the entity type: people, organisations,
-- projects, ...) and carries one fixed `key` (an email address, a web domain,
-- a meeting id, or a slug for an idea). Keys are shared across the Engine,
-- pages are not: two people may each hold a page on the same key, and the
-- read functions group them by key. One person holds at most one live page
-- per key.
--
-- The header follows the knowledge-wiki frontmatter: title, aliases,
-- description, status, reviewed, tags, related, sources, generated, verified,
-- plus the drawer's own `fields`. A page is stale when updated_at is later
-- than reviewed.
--
-- Search is whole-page: `body` is keyword-searched, `distillation` (one
-- summary of the whole page) is the only thing embedded. No chunking. The
-- summary and embedding are written later by the curator (Step C); a save
-- only sets `summary_queued_at` to ask for them.
--
-- Reached only through SECURITY DEFINER functions (0050, 0051). RLS on, no
-- policies, no grants.

create table if not exists workspace.pages (
    id                  uuid        primary key default gen_random_uuid(),
    owner_principal_id  uuid        not null
        references workspace.principals(id) on delete restrict,

    drawer              text        not null,
    key                 text        not null,
    template            text,

    title               text        not null,
    aliases             text[]      not null default '{}',
    description         text,
    fields              jsonb       not null default '{}'::jsonb,
    topics              text[]      not null default '{}',
    status              text        not null default 'unreviewed',
    reviewed            timestamptz,
    tags                text[]      not null default '{}',
    related             text[]      not null default '{}',
    sources             jsonb       not null default '[]'::jsonb,
    generated           jsonb,
    verified            jsonb       not null default '[]'::jsonb,

    body                text        not null default '',
    content_hash        text        not null,

    distillation        text,
    embedding           vector(384),
    tsv                 tsvector,
    summary_queued_at   timestamptz,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    deleted_at          timestamptz,

    constraint pages_status_values
        check (status in ('draft', 'unreviewed', 'current')),
    constraint pages_key_shape
        check (key = lower(key) and length(key) between 1 and 200 and key !~ '[[:space:]]'),
    constraint pages_drawer_shape
        check (drawer ~ '^[a-z][a-z0-9-]*$'),
    constraint pages_title_not_blank
        check (length(btrim(title)) > 0),
    constraint pages_fields_object
        check (jsonb_typeof(fields) = 'object'),
    constraint pages_sources_array
        check (jsonb_typeof(sources) = 'array')
);

comment on table workspace.pages is
    'Curated wiki pages, one row per page, one owner per row. Authoritative. '
    'Reached only through SECURITY DEFINER functions.';
comment on column workspace.pages.key is
    'The entity key (email, web domain, meeting id or slug). Lower case. '
    'Shared across owners; one live page per owner per key.';
comment on column workspace.pages.summary_queued_at is
    'Set on every content change: the summary and embedding need writing. '
    'Cleared by the curator (Step C) when it writes them.';

create unique index if not exists pages_owner_key_live
    on workspace.pages (owner_principal_id, key)
    where deleted_at is null;
create index if not exists pages_key_idx on workspace.pages (key) where deleted_at is null;
create index if not exists pages_drawer_idx on workspace.pages (drawer) where deleted_at is null;
create index if not exists pages_aliases_gin on workspace.pages using gin (aliases);
create index if not exists pages_tsv_gin on workspace.pages using gin (tsv);
create index if not exists pages_embedding_hnsw
    on workspace.pages using hnsw (embedding vector_cosine_ops);
create index if not exists pages_summary_queue
    on workspace.pages (summary_queued_at)
    where summary_queued_at is not null and deleted_at is null;

-- tsv: title (A), aliases and description (B), body (C). Kept by a trigger
-- because array_to_string is not immutable, so it cannot be a generated column.
create or replace function workspace.pages_tsv_trigger()
returns trigger
language plpgsql
set search_path = workspace, pg_temp
as $$
begin
    new.tsv :=
        setweight(to_tsvector('english', coalesce(new.title, '')), 'A')
        || setweight(to_tsvector('english',
               coalesce(array_to_string(new.aliases, ' '), '') || ' '
               || coalesce(new.description, '')), 'B')
        || setweight(to_tsvector('english', coalesce(new.body, '')), 'C');
    return new;
end;
$$;

revoke all on function workspace.pages_tsv_trigger() from public;
revoke all on function workspace.pages_tsv_trigger() from anon, authenticated;

drop trigger if exists pages_tsv_update on workspace.pages;
create trigger pages_tsv_update
    before insert or update of title, aliases, description, body on workspace.pages
    for each row
    execute function workspace.pages_tsv_trigger();

alter table workspace.pages enable row level security;
revoke all on workspace.pages from public;
revoke all on workspace.pages from anon, authenticated;


-- VERIFY ------------------------------------------------------------------
-- select relrowsecurity from pg_class where oid = 'workspace.pages'::regclass;  -- t
-- select has_table_privilege('kb_engine', 'workspace.pages', 'select');        -- f


-- ROLLBACK ------------------------------------------------------------------
-- Roll back 0047 to 0051 first.
-- drop table if exists workspace.pages;
-- drop function if exists workspace.pages_tsv_trigger();
