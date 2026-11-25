-- 0017_document_and_wiki_get.sql
--
-- Adds `document_get` and `wiki_page_get` RPCs for the get_document and
-- get_wiki_page MCP tools.
--
-- WHY RPCS AND NOT TABLE READS:
--   The kb_engine role has no table grants on workspace.documents. Tools that
--   read `workspace.documents` directly with a privileged key and filter in
--   TypeScript implement a caller-side filter — one early return or refactor and
--   sensitive bodies leave Postgres. These SECURITY DEFINER functions own
--   the domain intersection in the WHERE clause, so an out-of-domain row never
--   leaves the database.
--
-- SECURITY NOTES:
--   • Both functions share the same `if cardinality(v_domains) = 0 then return`
--     guard as documents_search (migration 0011 line 59). Unknown identity means
--     zero results, not an error.
--   • `d.domains && v_domains` is in the WHERE clause, not a TypeScript filter.
--   • wiki_page_get escapes `%` and `_` before ILIKE. `get_wiki_page('%')` would
--     otherwise be a page-enumeration primitive.
--   • out-of-domain document_get returns nothing (empty), not an error. The
--     engine's tool layer maps empty to not_found with a byte-identical message
--     to a truly nonexistent id. A caller cannot distinguish the two.
--   • Both have `deleted_at is null` and review_status exclusions matching
--     documents_search.
--
-- GRANT posture: revoke from public, grant to kb_engine only.
-- The kb_engine role is created in 0018_kb_engine_role.sql.

-- ── document_get ─────────────────────────────────────────────────────────────

create or replace function workspace.document_get(
    p_workos_user_id text,
    p_id             uuid
)
returns table (
    id                uuid,
    source            text,
    external_id       text,
    title             text,
    body              text,
    distillation      text,
    url               text,
    author            text,
    tier              smallint,
    domains           text[],
    review_status     text,
    metadata          jsonb,
    source_created_at timestamptz,
    indexed_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_domains text[];
begin
    v_domains := workspace.resolve_domains_for_workos_user(p_workos_user_id);

    -- Zero domains means unknown or unprovisioned identity. Return nothing.
    -- The caller (engine tool layer) surfaces this as not_found, byte-identical
    -- to a truly nonexistent id, so the caller cannot distinguish domain exclusion
    -- from nonexistence.
    if v_domains is null or cardinality(v_domains) = 0 then
        return;
    end if;

    return query
    select
        d.id,
        d.source,
        d.external_id,
        d.title,
        d.body,
        d.distillation,
        d.url,
        d.author,
        d.tier,
        d.domains,
        d.review_status,
        d.metadata,
        d.source_created_at,
        d.indexed_at
    from workspace.documents d
    where d.id = p_id
      and d.deleted_at is null
      and d.review_status not in ('rejected', 'excluded')
      and d.domains && v_domains;
end;
$$;

comment on function workspace.document_get(text, uuid) is
    'Fetch a single document by id, access-controlled by workos_user_id. '
    'The domain intersection is in the WHERE clause — never filter in the caller. '
    'Out-of-domain and nonexistent return identically empty (tool maps both to not_found).';

revoke all on function workspace.document_get(text, uuid) from public;
-- grant to kb_engine in 0018_kb_engine_role.sql

-- ── wiki_page_get ─────────────────────────────────────────────────────────────

create or replace function workspace.wiki_page_get(
    p_workos_user_id text,
    p_title_or_path  text
)
returns table (
    id                uuid,
    source            text,
    external_id       text,
    title             text,
    body              text,
    distillation      text,
    url               text,
    author            text,
    tier              smallint,
    domains           text[],
    review_status     text,
    metadata          jsonb,
    source_created_at timestamptz,
    indexed_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_domains  text[];
    v_escaped  text;
    v_pattern  text;
begin
    if p_title_or_path is null or length(btrim(p_title_or_path)) = 0 then
        return;
    end if;

    v_domains := workspace.resolve_domains_for_workos_user(p_workos_user_id);

    if v_domains is null or cardinality(v_domains) = 0 then
        return;
    end if;

    -- Escape ILIKE metacharacters BEFORE building the pattern.
    -- An unescaped `%` or `_` in the caller-supplied title is a
    -- page-enumeration primitive: `get_wiki_page('%')` would return every page
    -- the principal can see. Escape them so they match literally.
    v_escaped := replace(replace(p_title_or_path, '\', '\\'), '%', '\%');
    v_escaped := replace(v_escaped, '_', '\_');
    v_pattern := '%' || v_escaped || '%';

    return query
    select
        d.id,
        d.source,
        d.external_id,
        d.title,
        d.body,
        d.distillation,
        d.url,
        d.author,
        d.tier,
        d.domains,
        d.review_status,
        d.metadata,
        d.source_created_at,
        d.indexed_at
    from workspace.documents d
    where d.source = 'wiki'
      and d.deleted_at is null
      and d.review_status not in ('rejected', 'excluded')
      and d.domains && v_domains
      and (
            d.title ilike v_pattern
         or d.external_id ilike v_pattern
      )
    order by
        -- Exact title match first, then partial
        case when lower(d.title) = lower(btrim(p_title_or_path)) then 0 else 1 end,
        d.tier asc,
        d.source_created_at desc nulls last
    limit 5;
end;
$$;

comment on function workspace.wiki_page_get(text, text) is
    'Fuzzy-fetch wiki documents by title or path, access-controlled by workos_user_id. '
    'ILIKE metacharacters (%, _) are escaped before use — prevents page enumeration. '
    'Out-of-domain documents never returned; domain intersection is in the WHERE clause.';

revoke all on function workspace.wiki_page_get(text, text) from public;
-- grant to kb_engine in 0018_kb_engine_role.sql


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.wiki_page_get(text, text);
-- drop function if exists workspace.document_get(text, uuid);
