-- 0050_page_reads.sql
--
-- The page access rule and the four read functions the service calls.
--
-- THE RULE (workspace._page_visible)
--   A page is visible to a caller when
--       the caller is its owner, or
--       the caller holds one of its topics AND its owner is still active.
--   A page with no topics is its owner's alone. Unknown means no.
--   There is no way round it for an administrator.
--
-- Every function resolves the caller from the verified OAuth subject the
-- service passes (an ACTIVE principal, or nothing) and returns zero rows to
-- an unknown caller. The service sorts and groups; the database decides what
-- leaves it.
--
--   entity_find                    exact match on key, alias or title
--   entity_rows                    page headers of one drawer (list_entities)
--   page_related                   one step through page_links, both ways
--   pages_search_by_oauth_subject  hybrid keyword + vector search on pages

create or replace function workspace._page_visible(
    p_owner     uuid,
    p_topics    text[],
    p_granted   text[],
    p_principal uuid
)
returns boolean
language sql
stable
as $$
    select coalesce(
        p_principal is not null
        and p_owner is not null
        and (
            p_owner = p_principal
            or (
                p_topics && p_granted
                and exists (select 1 from workspace.principals o
                            where o.id = p_owner and o.active is true)
            )
        ),
        false);
$$;

comment on function workspace._page_visible(uuid, text[], text[], uuid) is
    'Internal: may this caller see this page? The one implementation of the '
    'page rule; every page read function calls it. Unknown means no.';

revoke all on function workspace._page_visible(uuid, text[], text[], uuid) from public;
revoke all on function workspace._page_visible(uuid, text[], text[], uuid) from anon, authenticated;


-- ── entity_find ──────────────────────────────────────────────────────────────

create or replace function workspace.entity_find(
    p_oauth_subject text,
    p_query         text,
    p_drawer        text    default null,
    p_limit         integer default 20
)
returns table (
    id            uuid,
    owner_handle  text,
    owner_name    text,
    is_own        boolean,
    drawer        text,
    key           text,
    title         text,
    aliases       text[],
    description   text,
    fields        jsonb,
    topics        text[],
    status        text,
    reviewed      timestamptz,
    tags          text[],
    related       text[],
    sources       jsonb,
    body          text,
    content_hash  text,
    template      text,
    generated     jsonb,
    verified      jsonb,
    created_at    timestamptz,
    updated_at    timestamptz,
    matched_on    text
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_granted   text[];
    v_q         text := lower(btrim(coalesce(p_query, '')));
begin
    if v_principal is null or v_q = '' then
        return;
    end if;
    v_granted := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);

    return query
    select p.id, o.handle, o.display_name, p.owner_principal_id = v_principal,
           p.drawer, p.key, p.title, p.aliases, p.description, p.fields, p.topics,
           p.status, p.reviewed, p.tags, p.related, p.sources, p.body,
           p.content_hash, p.template, p.generated, p.verified,
           p.created_at, p.updated_at,
           case when p.key = v_q then 'key'
                when exists (select 1 from unnest(p.aliases) a where lower(a) = v_q) then 'alias'
                else 'title' end
    from workspace.pages p
    join workspace.principals o on o.id = p.owner_principal_id
    where p.deleted_at is null
      and (p_drawer is null or p.drawer = p_drawer)
      and (p.key = v_q
           or lower(p.title) = v_q
           or exists (select 1 from unnest(p.aliases) a where lower(a) = v_q))
      and workspace._page_visible(p.owner_principal_id, p.topics, v_granted, v_principal)
    order by (p.owner_principal_id = v_principal) desc,
             (p.key = v_q) desc,
             p.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

comment on function workspace.entity_find(text, text, text, integer) is
    'Pages whose key, alias or title is exactly this text (any case), that the '
    'caller may see. The caller''s own pages first.';


-- ── entity_rows ──────────────────────────────────────────────────────────────

create or replace function workspace.entity_rows(
    p_oauth_subject text,
    p_drawer        text,
    p_limit         integer default 2000
)
returns table (
    id            uuid,
    owner_handle  text,
    is_own        boolean,
    drawer        text,
    key           text,
    title         text,
    description   text,
    fields        jsonb,
    status        text,
    reviewed      timestamptz,
    updated_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_granted   text[];
begin
    if v_principal is null then
        return;
    end if;
    v_granted := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);

    return query
    select p.id, o.handle, p.owner_principal_id = v_principal, p.drawer, p.key,
           p.title, p.description, p.fields, p.status, p.reviewed, p.updated_at
    from workspace.pages p
    join workspace.principals o on o.id = p.owner_principal_id
    where p.deleted_at is null
      and (p_drawer is null or p.drawer = p_drawer)
      and workspace._page_visible(p.owner_principal_id, p.topics, v_granted, v_principal)
    order by p.key, (p.owner_principal_id = v_principal) desc, p.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 2000), 5000));
end;
$$;

comment on function workspace.entity_rows(text, text, integer) is
    'Headers (no body) of the pages in one drawer the caller may see, ordered '
    'by key. The service groups them by key for list_entities.';


-- ── page_related ─────────────────────────────────────────────────────────────

create or replace function workspace.page_related(
    p_oauth_subject text,
    p_keys          text[],
    p_limit         integer default 10
)
returns table (
    from_key      text,
    direction     text,
    reason        text,
    id            uuid,
    owner_handle  text,
    is_own        boolean,
    drawer        text,
    key           text,
    title         text,
    description   text,
    updated_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_granted   text[];
    v_keys      text[];
begin
    if v_principal is null then
        return;
    end if;
    v_granted := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);
    select coalesce(array_agg(distinct lower(btrim(k))), array[]::text[]) into v_keys
    from unnest(coalesce(p_keys, array[]::text[])) k
    where length(btrim(k)) > 0;

    return query
    with src as (
        -- The pages the caller may see on the asked keys.
        select s.id, s.key
        from workspace.pages s
        where s.deleted_at is null
          and s.key = any(v_keys)
          and workspace._page_visible(s.owner_principal_id, s.topics, v_granted, v_principal)
    ),
    edges as (
        select s.key as from_key, 'out'::text as direction, l.reason, l.target_key as other_key
        from src s join workspace.page_links l on l.page_id = s.id
        union
        select l.target_key, 'in'::text, l.reason, b.key
        from workspace.page_links l
        join workspace.pages b on b.id = l.page_id
        where l.target_key = any(v_keys)
          and b.deleted_at is null
          and workspace._page_visible(b.owner_principal_id, b.topics, v_granted, v_principal)
    ),
    hits as (
        select distinct on (p.id)
               e.from_key, e.direction, e.reason, p.id, o.handle,
               p.owner_principal_id = v_principal as own, p.drawer, p.key,
               p.title, p.description, p.updated_at
        from edges e
        join workspace.pages p on p.key = e.other_key and p.deleted_at is null
        join workspace.principals o on o.id = p.owner_principal_id
        where not (p.key = any(v_keys))
          and workspace._page_visible(p.owner_principal_id, p.topics, v_granted, v_principal)
        order by p.id, e.direction desc, e.reason
    )
    select h.from_key, h.direction, h.reason, h.id, h.handle, h.own, h.drawer,
           h.key, h.title, h.description, h.updated_at
    from hits h
    order by h.own desc, h.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 10), 50)) * 3;
end;
$$;

comment on function workspace.page_related(text, text[], integer) is
    'Pages one link away from the given keys (out-links and backlinks), both '
    'ends checked by the page rule. Up to 3 x p_limit page rows; the service '
    'groups them by key and keeps p_limit keys.';


-- ── pages_search_by_oauth_subject ────────────────────────────────────────────

create or replace function workspace.pages_search_by_oauth_subject(
    p_oauth_subject text,
    query_text      text,
    query_embedding vector(384),
    match_count     integer default 10
)
returns table (
    id            uuid,
    owner_handle  text,
    is_own        boolean,
    drawer        text,
    key           text,
    title         text,
    description   text,
    distillation  text,
    fields        jsonb,
    updated_at    timestamptz,
    score         double precision
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_granted   text[];
    v_query     tsquery := websearch_to_tsquery('english', coalesce(query_text, ''));
    v_count     integer := greatest(1, least(coalesce(match_count, 10), 50));
begin
    if v_principal is null then
        return;
    end if;
    v_granted := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);

    return query
    with visible as (
        select p.*
        from workspace.pages p
        where p.deleted_at is null
          and workspace._page_visible(p.owner_principal_id, p.topics, v_granted, v_principal)
    ),
    kw as (
        select v.id as page_id,
               row_number() over (order by ts_rank_cd(v.tsv, v_query) desc) as rnk
        from visible v
        where v.tsv @@ v_query
        order by ts_rank_cd(v.tsv, v_query) desc
        limit 200
    ),
    vec as (
        select v.id as page_id,
               row_number() over (order by v.embedding <=> query_embedding) as rnk
        from visible v
        where v.embedding is not null and query_embedding is not null
        order by v.embedding <=> query_embedding
        limit 200
    ),
    fused as (
        select coalesce(k.page_id, x.page_id) as page_id,
               coalesce(1.0::double precision / (60 + k.rnk), 0.0)
             + coalesce(1.0::double precision / (60 + x.rnk), 0.0) as rrf
        from kw k
        full outer join vec x on x.page_id = k.page_id
    )
    select p.id, o.handle, p.owner_principal_id = v_principal, p.drawer, p.key,
           p.title, p.description, p.distillation, p.fields, p.updated_at, f.rrf
    from fused f
    join workspace.pages p on p.id = f.page_id
    join workspace.principals o on o.id = p.owner_principal_id
    order by f.rrf desc
    limit v_count * 3;
end;
$$;

comment on function workspace.pages_search_by_oauth_subject(text, text, vector, integer) is
    'Hybrid search over the pages the caller may see. Up to 3 x match_count '
    'page rows; the service groups them by key, own page first.';


revoke all on function workspace.entity_find(text, text, text, integer) from public;
revoke all on function workspace.entity_find(text, text, text, integer) from anon, authenticated;
grant execute on function workspace.entity_find(text, text, text, integer) to kb_engine;

revoke all on function workspace.entity_rows(text, text, integer) from public;
revoke all on function workspace.entity_rows(text, text, integer) from anon, authenticated;
grant execute on function workspace.entity_rows(text, text, integer) to kb_engine;

revoke all on function workspace.page_related(text, text[], integer) from public;
revoke all on function workspace.page_related(text, text[], integer) from anon, authenticated;
grant execute on function workspace.page_related(text, text[], integer) to kb_engine;

revoke all on function workspace.pages_search_by_oauth_subject(text, text, vector, integer) from public;
revoke all on function workspace.pages_search_by_oauth_subject(text, text, vector, integer) from anon, authenticated;
grant execute on function workspace.pages_search_by_oauth_subject(text, text, vector, integer) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('anon',
--   'workspace.entity_find(text, text, text, integer)', 'execute');   -- f
-- select count(*) from workspace.entity_find('no-such-subject', 'x');  -- 0


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.pages_search_by_oauth_subject(text, text, vector, integer);
-- drop function if exists workspace.page_related(text, text[], integer);
-- drop function if exists workspace.entity_rows(text, text, integer);
-- drop function if exists workspace.entity_find(text, text, text, integer);
-- drop function if exists workspace._page_visible(uuid, text[], text[], uuid);
