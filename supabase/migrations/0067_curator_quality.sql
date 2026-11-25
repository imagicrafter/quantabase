-- 0067_curator_quality.sql
--
-- Curator quality (decision 2026-11-22): the curator must match a careful
-- person filing a wiki by hand, and must not make duplicate pages.
--
--   curator_settings.strong_model   the model asked where judgement matters:
--                                   new pages in drawers marked
--                                   `judgement: high` in the templates, and
--                                   items whose consensus runs disagreed.
--                                   Default deepseek-v4.1-flash.
--   identities                      a person page keeps every known address
--                                   in fields.emails, an organisation page
--                                   every known domain in fields.domains;
--                                   key matching checks them all
--                                   (curator_candidates replaced here).
--   curator_page_index              a compact index of the owner's pages in
--                                   the item's topic (title, aliases, drawer,
--                                   key, description), ranked by key, words
--                                   and embedding.
--   curator_name_match              before a page without a strong key is
--                                   made: same normalised name or alias, or a
--                                   close embedding, in the same drawer.
--   page_duplicates                 the nightly look-alike list
--                                   (curator_duplicates_scan); the owner
--                                   merges or dismisses (app_duplicates_list,
--                                   app_page_merge, app_duplicate_dismiss).
--                                   Never merged automatically.
--   page_key_redirects              a merged page's old key, pointing at the
--                                   page it was merged into.
--   page_import                     replaced: a page that matches an existing
--                                   one (key, email/domain, name) is reported
--                                   as matched, not created.

-- ── settings ────────────────────────────────────────────────────────────────

alter table workspace.curator_settings
    add column if not exists strong_model text not null default 'deepseek-v4.1-flash',
    add column if not exists dup_scan_at  timestamptz;

-- Serverless models on DigitalOcean at or above the A1 floor. Prices
-- (USD per million tokens in/out, 2026-11): gpt-oss-120b 0.10/0.70,
-- deepseek-v4.1-flash 0.30/1.20, deepseek-v4-pro 1.74/3.48,
-- glm-5.3 1.40/4.40, anthropic-claude-sonnet-5.5 2.00/10.00.
alter table workspace.curator_settings drop constraint if exists curator_settings_strong_values;
alter table workspace.curator_settings add constraint curator_settings_strong_values
    check (strong_model in ('openai-gpt-oss-120b', 'deepseek-v4.1-flash', 'deepseek-v4-pro',
                            'glm-5.3', 'anthropic-claude-sonnet-5.5'));

create or replace function workspace.curator_consensus_get()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object('enabled', s.consensus, 'primary_model', s.model,
                              'tiebreak_model', s.tiebreak_model, 'strong_model', s.strong_model)
    from workspace.curator_settings s
    where s.id;
$$;

-- ── helpers (no grants) ─────────────────────────────────────────────────────

-- A name for matching: lower case, letters and digits only, single spaces.
create or replace function workspace._name_norm(p_text text)
returns text
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select btrim(regexp_replace(regexp_replace(lower(coalesce(p_text, '')), '[^[:alnum:]]+', ' ', 'g'),
                                '\s+', ' ', 'g'));
$$;

-- The text items of a jsonb array, lower case; empty when not an array.
create or replace function workspace._jsonb_lower_list(p_value jsonb)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select case when jsonb_typeof(p_value) = 'array'
                then array(select distinct lower(btrim(x)) from jsonb_array_elements_text(p_value) x
                           where length(btrim(x)) > 0)
                else array[]::text[] end;
$$;

-- Every address and domain a page is known by (fields.emails, fields.domains).
create or replace function workspace._page_identities(p_fields jsonb)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select workspace._jsonb_lower_list(p_fields->'emails') || workspace._jsonb_lower_list(p_fields->'domains');
$$;

-- The names a page answers to: title, aliases and the name part of a slug key.
create or replace function workspace._page_names(p_title text, p_aliases text[], p_key text)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select array(select distinct n from (
        select workspace._name_norm(p_title) as n
        union all select workspace._name_norm(a) from unnest(coalesce(p_aliases, array[]::text[])) a
        union all select workspace._name_norm(substring(p_key from '^[a-z][a-z-]*:(.+)$'))
    ) x where n <> '');
$$;

-- ── identities in key matching ─────────────────────────────────────────────

-- As in 0063, plus: a key the item names that is one of a page's known
-- addresses or domains matches that page ('identity').
create or replace function workspace.curator_candidates(
    p_item_id uuid,
    p_keys    text[],
    p_query   text,
    p_limit   integer default 8
)
returns table (
    id            uuid,
    drawer        text,
    key           text,
    template      text,
    title         text,
    aliases       text[],
    description   text,
    fields        jsonb,
    topics        text[],
    status        text,
    tags          text[],
    related       text[],
    sources       jsonb,
    generated     jsonb,
    verified      jsonb,
    body          text,
    content_hash  text,
    matched_on    text
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_owner   uuid;
    v_allowed text[];
    v_keys    text[] := array(select distinct lower(btrim(k)) from unnest(coalesce(p_keys, array[]::text[])) k
                              where length(btrim(k)) > 0);
    v_query   tsquery := websearch_to_tsquery('english', coalesce(p_query, ''));
    v_limit   integer := greatest(1, least(coalesce(p_limit, 8), 20));
begin
    select sc.owner_id, sc.allowed into v_owner, v_allowed
    from workspace._curator_item_scope(p_item_id) sc;

    return query
    with mine as (
        select p.*
        from workspace.pages p
        where p.owner_principal_id = v_owner
          and p.deleted_at is null
          and p.topics = v_allowed
    ),
    by_key as (
        select m.id,
               case when m.key = any(v_keys) then 'key'
                    when workspace._page_identities(m.fields) && v_keys then 'identity'
                    else 'alias' end as how,
               0 as rnk
        from mine m
        where m.key = any(v_keys)
           or workspace._page_identities(m.fields) && v_keys
           or exists (select 1 from unnest(m.aliases) a where lower(a) = any(v_keys))
    ),
    by_text as (
        select m.id, 'search'::text as how,
               row_number() over (order by ts_rank_cd(m.tsv, v_query) desc)::int as rnk
        from mine m
        where m.tsv @@ v_query
          and not exists (select 1 from by_key k where k.id = m.id)
        order by ts_rank_cd(m.tsv, v_query) desc
        limit v_limit
    ),
    hits as (
        select * from by_key
        union all
        select * from by_text
    )
    select m.id, m.drawer, m.key, m.template, m.title, m.aliases, m.description, m.fields,
           m.topics, m.status, m.tags, m.related, m.sources, m.generated, m.verified,
           m.body, m.content_hash, h.how
    from hits h
    join mine m on m.id = h.id
    order by h.rnk, m.updated_at desc
    limit v_limit;
end;
$$;

-- ── page index ──────────────────────────────────────────────────────────────

-- The owner's pages in the item's topic set, one short row each, best first:
-- key/identity/alias matches (score 2), then a mix of keyword rank and
-- embedding closeness. The service cuts the list to its token budget.
create or replace function workspace.curator_page_index(
    p_item_id   uuid,
    p_keys      text[],
    p_query     text,
    p_embedding vector(384) default null,
    p_limit     integer default 60
)
returns table (
    id           uuid,
    drawer       text,
    key          text,
    title        text,
    aliases      text[],
    description  text,
    identities   text[],
    score        real,
    matched_on   text
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_owner   uuid;
    v_allowed text[];
    v_keys    text[] := array(select distinct lower(btrim(k)) from unnest(coalesce(p_keys, array[]::text[])) k
                              where length(btrim(k)) > 0);
    v_query   tsquery := websearch_to_tsquery('english', coalesce(p_query, ''));
    v_limit   integer := greatest(1, least(coalesce(p_limit, 60), 200));
begin
    select sc.owner_id, sc.allowed into v_owner, v_allowed
    from workspace._curator_item_scope(p_item_id) sc;

    return query
    with mine as (
        select p.id, p.drawer, p.key, p.title, p.aliases, p.description,
               workspace._page_identities(p.fields) as ids, p.tsv, p.embedding, p.updated_at
        from workspace.pages p
        where p.owner_principal_id = v_owner
          and p.deleted_at is null
          and p.topics = v_allowed
    ),
    scored as (
        select m.*,
               case when m.key = any(v_keys) then 'key'
                    when m.ids && v_keys then 'identity'
                    when exists (select 1 from unnest(m.aliases) a where lower(a) = any(v_keys)) then 'alias'
                    when p_embedding is not null and m.embedding is not null then 'similar'
                    when m.tsv @@ v_query then 'search'
                    else 'recent' end as how,
               (case when m.tsv @@ v_query then least(ts_rank_cd(m.tsv, v_query), 1.0) else 0 end
                + case when p_embedding is not null and m.embedding is not null
                       then greatest(0, 1 - (m.embedding <=> p_embedding)) else 0 end)::real as s
        from mine m
    )
    select s.id, s.drawer, s.key, s.title, s.aliases, s.description, s.ids,
           case when s.how in ('key', 'identity', 'alias') then 2::real else s.s end,
           s.how
    from scored s
    order by case when s.how in ('key', 'identity', 'alias') then 0 else 1 end, s.s desc, s.updated_at desc
    limit v_limit;
end;
$$;

-- ── name match before create ────────────────────────────────────────────────

-- The owner's pages in one drawer (item's topic set) that answer to one of
-- these names (score 1), or whose summary embedding is close (score =
-- cosine similarity). Best first. The service applies the drawer's threshold.
create or replace function workspace.curator_name_match(
    p_item_id   uuid,
    p_drawer    text,
    p_names     text[],
    p_embedding vector(384) default null,
    p_limit     integer default 3
)
returns table (id uuid, key text, title text, score real, how text)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_owner   uuid;
    v_allowed text[];
    v_names   text[] := array(select distinct workspace._name_norm(n) from unnest(coalesce(p_names, array[]::text[])) n
                              where workspace._name_norm(n) <> '');
begin
    select sc.owner_id, sc.allowed into v_owner, v_allowed
    from workspace._curator_item_scope(p_item_id) sc;

    return query
    select x.id, x.key, x.title, x.score, x.how
    from (
        select p.id, p.key, p.title,
               case when workspace._page_names(p.title, p.aliases, p.key) && v_names then 1::real
                    when p_embedding is not null and p.embedding is not null
                         then greatest(0, 1 - (p.embedding <=> p_embedding))::real
                    else 0::real end as score,
               case when workspace._page_names(p.title, p.aliases, p.key) && v_names then 'name'
                    else 'embedding' end as how
        from workspace.pages p
        where p.owner_principal_id = v_owner
          and p.deleted_at is null
          and p.topics = v_allowed
          and p.drawer = p_drawer
    ) x
    where x.score > 0
    order by x.score desc
    limit greatest(1, least(coalesce(p_limit, 3), 10));
end;
$$;

-- ── look-alike list ─────────────────────────────────────────────────────────

create table if not exists workspace.page_duplicates (
    id                  uuid        primary key default gen_random_uuid(),
    owner_principal_id  uuid        not null references workspace.principals(id) on delete cascade,
    page_a              uuid        not null references workspace.pages(id) on delete cascade,
    page_b              uuid        not null references workspace.pages(id) on delete cascade,
    drawer              text        not null,
    reason              text        not null,
    score               real        not null,
    status              text        not null default 'open',
    created_at          timestamptz not null default now(),
    decided_at          timestamptz,
    constraint page_duplicates_order check (page_a < page_b),
    constraint page_duplicates_status_values check (status in ('open', 'merged', 'dismissed')),
    constraint page_duplicates_reason_values check (reason in ('shared email or domain', 'same name', 'similar')),
    constraint page_duplicates_pair unique (page_a, page_b)
);

comment on table workspace.page_duplicates is
    'Pages that look like the same thing (nightly scan). The owner merges or dismisses; never merged automatically.';

alter table workspace.page_duplicates enable row level security;
revoke all on workspace.page_duplicates from public;
revoke all on workspace.page_duplicates from anon, authenticated;

create table if not exists workspace.page_key_redirects (
    owner_principal_id  uuid        not null references workspace.principals(id) on delete cascade,
    old_key             text        not null,
    new_key             text        not null,
    merged_at           timestamptz not null default now(),
    primary key (owner_principal_id, old_key)
);

comment on table workspace.page_key_redirects is
    'A merged page''s old key and the key of the page it was merged into.';

alter table workspace.page_key_redirects enable row level security;
revoke all on workspace.page_key_redirects from public;
revoke all on workspace.page_key_redirects from anon, authenticated;

-- Find look-alikes across every owner: same owner, drawer and topic set, and
-- a shared address/domain (or one page's key is the other's identity), a
-- shared name, or summary embeddings at least the drawer's threshold
-- (p_thresholds {"drawer": 0.9}, else p_default). Runs at most once in 20
-- hours unless forced. A dismissed pair is never proposed again. Returns the
-- number of new pairs, or -1 when not due.
create or replace function workspace.curator_duplicates_scan(
    p_default    real default 0.92,
    p_thresholds jsonb default '{}'::jsonb,
    p_force      boolean default false
)
returns integer
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_last timestamptz := (select s.dup_scan_at from workspace.curator_settings s where s.id);
    v_n    integer;
begin
    if not coalesce(p_force, false) and v_last is not null and v_last > now() - interval '20 hours' then
        return -1;
    end if;
    update workspace.curator_settings s set dup_scan_at = now() where s.id;

    with live as (
        select p.id, p.owner_principal_id as owner, p.drawer, p.topics, p.key, p.embedding,
               workspace._page_identities(p.fields) || p.key as ids,
               workspace._page_names(p.title, p.aliases, p.key) as names
        from workspace.pages p
        where p.deleted_at is null
    ),
    pairs as (
        select a.owner, a.id as pa, b.id as pb, a.drawer,
               case when a.ids && b.ids then 'shared email or domain'
                    when a.names && b.names then 'same name'
                    else 'similar' end as reason,
               case when a.ids && b.ids or a.names && b.names then 1::real
                    else (1 - (a.embedding <=> b.embedding))::real end as score
        from live a
        join live b on b.owner = a.owner and b.drawer = a.drawer and b.topics = a.topics and a.id < b.id
        where a.ids && b.ids
           or a.names && b.names
           or (a.embedding is not null and b.embedding is not null
               and 1 - (a.embedding <=> b.embedding)
                   >= coalesce((p_thresholds->>a.drawer)::real, p_default))
    )
    insert into workspace.page_duplicates (owner_principal_id, page_a, page_b, drawer, reason, score)
    select owner, pa, pb, drawer, reason, score from pairs
    on conflict (page_a, page_b) do nothing;
    get diagnostics v_n = row_count;
    return v_n;
end;
$$;

-- The signed-in person's open look-alike pairs, both pages summarised.
create or replace function workspace.app_duplicates_list(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', d.id, 'drawer', d.drawer, 'reason', d.reason, 'score', d.score,
                   'created_at', d.created_at,
                   'a', jsonb_build_object('id', a.id, 'key', a.key, 'title', a.title,
                                           'description', a.description, 'updated_at', a.updated_at,
                                           'content_hash', a.content_hash),
                   'b', jsonb_build_object('id', b.id, 'key', b.key, 'title', b.title,
                                           'description', b.description, 'updated_at', b.updated_at,
                                           'content_hash', b.content_hash))
               order by d.score desc, d.created_at desc)
        from workspace.page_duplicates d
        join workspace.pages a on a.id = d.page_a and a.deleted_at is null
        join workspace.pages b on b.id = d.page_b and b.deleted_at is null
        where d.owner_principal_id = v_who.id and d.status = 'open'), '[]'::jsonb);
end;
$$;

-- Both pages of one of the person's own open pairs, in full (for a merge).
create or replace function workspace.app_duplicate_get(p_email text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    return (
        select jsonb_build_object(
                   'id', d.id, 'drawer', d.drawer, 'reason', d.reason, 'score', d.score,
                   'a', jsonb_build_object('id', a.id, 'key', a.key, 'title', a.title, 'body', a.body,
                                           'content_hash', a.content_hash),
                   'b', jsonb_build_object('id', b.id, 'key', b.key, 'title', b.title, 'body', b.body,
                                           'content_hash', b.content_hash))
        from workspace.page_duplicates d
        join workspace.pages a on a.id = d.page_a and a.deleted_at is null
        join workspace.pages b on b.id = d.page_b and b.deleted_at is null
        where d.id = p_id and d.owner_principal_id = v_who.id and d.status = 'open');
end;
$$;

create or replace function workspace.app_duplicate_dismiss(p_email text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    update workspace.page_duplicates d set status = 'dismissed', decided_at = now()
    where d.id = p_id and d.owner_principal_id = v_who.id and d.status = 'open';
    return found;
end;
$$;

-- Merge one of the person's own pairs: keep `p_keep`, fold the other in.
-- The kept page gets the merged body (built by the service from both
-- bodies), the other's title and aliases as aliases, its key as a known
-- address/domain when it is one, the union of fields (the kept page's values
-- win), tags, links and sources; saved through _page_save_as (history kept).
-- The other page is deleted (its history stays), links to its key are
-- pointed at the kept key, and a redirect is recorded. Both pages must be
-- unchanged since they were read (their hashes).
create or replace function workspace.app_page_merge(
    p_email     text,
    p_id        uuid,
    p_keep      uuid,
    p_body      text,
    p_keep_hash text,
    p_drop_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_who    workspace.principals%rowtype := workspace._app_person(p_email);
    v_dup    workspace.page_duplicates%rowtype;
    v_keep   workspace.pages%rowtype;
    v_drop   workspace.pages%rowtype;
    v_fields jsonb;
    v_emails text[];
    v_doms   text[];
    v_page   jsonb;
    v_saved  record;
begin
    select * into v_dup from workspace.page_duplicates d
    where d.id = p_id and d.owner_principal_id = v_who.id and d.status = 'open'
    for update;
    if not found then
        raise exception 'there is no such open pair' using errcode = '22023';
    end if;
    if p_keep not in (v_dup.page_a, v_dup.page_b) then
        raise exception 'the page to keep must be one of the pair' using errcode = '22023';
    end if;
    select * into v_keep from workspace.pages p where p.id = p_keep and p.deleted_at is null for update;
    select * into v_drop from workspace.pages p
    where p.id = case when p_keep = v_dup.page_a then v_dup.page_b else v_dup.page_a end
      and p.deleted_at is null for update;
    if v_keep.id is null or v_drop.id is null then
        raise exception 'one of the pages is gone' using errcode = '22023';
    end if;
    if v_keep.owner_principal_id <> v_who.id or v_drop.owner_principal_id <> v_who.id then
        raise exception 'not your pages' using errcode = '42501';
    end if;
    if v_keep.content_hash <> p_keep_hash or v_drop.content_hash <> p_drop_hash then
        raise exception 'a page has changed since it was read; read them again' using errcode = '22023';
    end if;
    if v_keep.topics <> v_drop.topics or v_keep.drawer <> v_drop.drawer then
        raise exception 'only pages in the same drawer and topics can be merged' using errcode = '22023';
    end if;
    if p_body is null or length(btrim(p_body)) = 0 then
        raise exception 'the merged text is empty' using errcode = '22023';
    end if;

    v_emails := array(select distinct x from unnest(
        workspace._jsonb_lower_list(v_keep.fields->'emails') || workspace._jsonb_lower_list(v_drop.fields->'emails')
        || case when v_drop.key ~ '^[^@:[:space:]]+@[^@[:space:]]+$' then array[v_drop.key] else array[]::text[] end) x
        where x <> v_keep.key order by 1);
    v_doms := array(select distinct x from unnest(
        workspace._jsonb_lower_list(v_keep.fields->'domains') || workspace._jsonb_lower_list(v_drop.fields->'domains')
        || case when v_drop.key ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then array[v_drop.key] else array[]::text[] end) x
        where x <> v_keep.key order by 1);
    v_fields := v_drop.fields || v_keep.fields;
    v_fields := case when cardinality(v_emails) > 0 then v_fields || jsonb_build_object('emails', to_jsonb(v_emails))
                     else v_fields - 'emails' end;
    v_fields := case when cardinality(v_doms) > 0 then v_fields || jsonb_build_object('domains', to_jsonb(v_doms))
                     else v_fields - 'domains' end;

    v_page := jsonb_build_object(
        'drawer', v_keep.drawer, 'key', v_keep.key, 'template', v_keep.template, 'title', v_keep.title,
        'aliases', to_jsonb(array(select distinct a from unnest(v_keep.aliases || v_drop.aliases || v_drop.title) a
                                  where workspace._name_norm(a) <> workspace._name_norm(v_keep.title) order by 1)),
        'description', coalesce(v_keep.description, v_drop.description),
        'fields', v_fields,
        'topics', to_jsonb(v_keep.topics),
        'status', v_keep.status,
        'tags', to_jsonb(array(select distinct t from unnest(v_keep.tags || v_drop.tags) t order by 1)),
        'related', to_jsonb(array(select distinct r from unnest(v_keep.related || v_drop.related) r
                                  where r not in (v_keep.key, v_drop.key) order by 1)),
        'sources', v_keep.sources || coalesce((select jsonb_agg(s) from jsonb_array_elements(v_drop.sources) s
                                               where not v_keep.sources @> jsonb_build_array(s)), '[]'::jsonb),
        'generated', v_keep.generated,
        'verified', v_keep.verified,
        'body', p_body);
    select * into v_saved from workspace._page_save_as(v_who.id, v_keep.topics, v_page, v_keep.content_hash);

    update workspace.pages p set deleted_at = now() where p.id = v_drop.id;

    -- Links to the old key now lead to the kept page.
    delete from workspace.page_links l
    where l.target_key = v_drop.key
      and exists (select 1 from workspace.page_links k
                  where k.page_id = l.page_id and k.target_key = v_keep.key and k.reason = l.reason);
    update workspace.page_links l set target_key = v_keep.key
    where l.target_key = v_drop.key
      and l.page_id in (select p.id from workspace.pages p where p.owner_principal_id = v_who.id);
    update workspace.pages p
    set related = array(select distinct r from unnest(array_replace(p.related, v_drop.key, v_keep.key)) r
                        where r <> p.key)
    where p.owner_principal_id = v_who.id and p.deleted_at is null and v_drop.key = any(p.related);
    insert into workspace.page_key_redirects (owner_principal_id, old_key, new_key)
    values (v_who.id, v_drop.key, v_keep.key)
    on conflict (owner_principal_id, old_key) do update set new_key = excluded.new_key, merged_at = now();
    update workspace.page_key_redirects r set new_key = v_keep.key
    where r.owner_principal_id = v_who.id and r.new_key = v_drop.key;

    update workspace.page_duplicates d set status = 'merged', decided_at = now() where d.id = v_dup.id;
    update workspace.page_duplicates d set status = 'dismissed', decided_at = now()
    where d.status = 'open' and v_drop.id in (d.page_a, d.page_b);

    return jsonb_build_object('kept', v_keep.id, 'key', v_keep.key, 'merged', v_drop.key,
                              'content_hash', v_saved.content_hash);
end;
$$;

-- ── import uses the same matching ───────────────────────────────────────────

-- As in 0056, plus: a page whose key, known addresses/domains or names
-- match one of the person's live pages in the same drawer is not created;
-- the answer is {status: matched, key, how}.
create or replace function workspace.page_import(p_owner_email text, p_page jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_owner   workspace.principals%rowtype := workspace._active_principal_by_email(p_owner_email);
    v_key     text := lower(btrim(coalesce(p_page->>'key', '')));
    v_drawer  text := btrim(coalesce(p_page->>'drawer', ''));
    v_ids     text[];
    v_names   text[];
    v_allowed text[];
    v_match   record;
    v_saved   record;
begin
    if v_owner.id is null then
        raise exception 'no active person with that email' using errcode = '22023';
    end if;
    if exists (select 1 from workspace.pages p
               where p.owner_principal_id = v_owner.id and p.key = v_key and p.deleted_at is null) then
        return jsonb_build_object('status', 'exists', 'key', v_key);
    end if;
    v_ids := workspace._page_identities(coalesce(p_page->'fields', '{}'::jsonb)) || v_key;
    v_names := workspace._page_names(p_page->>'title',
                                     workspace._jsonb_lower_list(p_page->'aliases'), v_key);
    select p.key,
           case when (workspace._page_identities(p.fields) || p.key) && v_ids then 'email or domain'
                else 'name' end as how
      into v_match
    from workspace.pages p
    where p.owner_principal_id = v_owner.id and p.deleted_at is null and p.drawer = v_drawer
      and ((workspace._page_identities(p.fields) || p.key) && v_ids
           or workspace._page_names(p.title, p.aliases, p.key) && v_names)
    order by case when (workspace._page_identities(p.fields) || p.key) && v_ids then 0 else 1 end, p.updated_at desc
    limit 1;
    if v_match.key is not null then
        return jsonb_build_object('status', 'matched', 'key', v_match.key, 'how', v_match.how, 'proposed', v_key);
    end if;
    v_allowed := array(select g.domain from workspace.access_grants g where g.principal_id = v_owner.id);
    select * into v_saved from workspace._page_save_as(v_owner.id, v_allowed, p_page, null);
    return jsonb_build_object('status', 'created', 'key', v_saved.key, 'id', v_saved.id);
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._name_norm(text) from public;
revoke all on function workspace._name_norm(text) from anon, authenticated;
revoke all on function workspace._jsonb_lower_list(jsonb) from public;
revoke all on function workspace._jsonb_lower_list(jsonb) from anon, authenticated;
revoke all on function workspace._page_identities(jsonb) from public;
revoke all on function workspace._page_identities(jsonb) from anon, authenticated;
revoke all on function workspace._page_names(text, text[], text) from public;
revoke all on function workspace._page_names(text, text[], text) from anon, authenticated;

revoke all on function workspace.curator_candidates(uuid, text[], text, integer) from public;
revoke all on function workspace.curator_candidates(uuid, text[], text, integer) from anon, authenticated;
grant execute on function workspace.curator_candidates(uuid, text[], text, integer) to kb_engine;
revoke all on function workspace.curator_consensus_get() from public;
revoke all on function workspace.curator_consensus_get() from anon, authenticated;
grant execute on function workspace.curator_consensus_get() to kb_engine;
revoke all on function workspace.curator_page_index(uuid, text[], text, vector, integer) from public;
revoke all on function workspace.curator_page_index(uuid, text[], text, vector, integer) from anon, authenticated;
grant execute on function workspace.curator_page_index(uuid, text[], text, vector, integer) to kb_engine;
revoke all on function workspace.curator_name_match(uuid, text, text[], vector, integer) from public;
revoke all on function workspace.curator_name_match(uuid, text, text[], vector, integer) from anon, authenticated;
grant execute on function workspace.curator_name_match(uuid, text, text[], vector, integer) to kb_engine;
revoke all on function workspace.curator_duplicates_scan(real, jsonb, boolean) from public;
revoke all on function workspace.curator_duplicates_scan(real, jsonb, boolean) from anon, authenticated;
grant execute on function workspace.curator_duplicates_scan(real, jsonb, boolean) to kb_engine;

revoke all on function workspace.app_duplicates_list(text) from public;
revoke all on function workspace.app_duplicates_list(text) from anon, authenticated;
grant execute on function workspace.app_duplicates_list(text) to kb_engine;
revoke all on function workspace.app_duplicate_get(text, uuid) from public;
revoke all on function workspace.app_duplicate_get(text, uuid) from anon, authenticated;
grant execute on function workspace.app_duplicate_get(text, uuid) to kb_engine;
revoke all on function workspace.app_duplicate_dismiss(text, uuid) from public;
revoke all on function workspace.app_duplicate_dismiss(text, uuid) from anon, authenticated;
grant execute on function workspace.app_duplicate_dismiss(text, uuid) to kb_engine;
revoke all on function workspace.app_page_merge(text, uuid, uuid, text, text, text) from public;
revoke all on function workspace.app_page_merge(text, uuid, uuid, text, text, text) from anon, authenticated;
grant execute on function workspace.app_page_merge(text, uuid, uuid, text, text, text) to kb_engine;

revoke all on function workspace.page_import(text, jsonb) from public;
revoke all on function workspace.page_import(text, jsonb) from anon, authenticated;


-- VERIFY ------------------------------------------------------------------
-- select workspace.curator_consensus_get()->>'strong_model';          -- deepseek-v4.1-flash
-- select has_table_privilege('kb_engine', 'workspace.page_duplicates', 'select');  -- f


-- ROLLBACK ------------------------------------------------------------------
-- Re-run the 0063 curator_candidates, 0062 curator_consensus_get and 0056
-- page_import definitions, then:
-- drop function if exists workspace.app_page_merge(text, uuid, uuid, text, text, text);
-- drop function if exists workspace.app_duplicate_dismiss(text, uuid);
-- drop function if exists workspace.app_duplicate_get(text, uuid);
-- drop function if exists workspace.app_duplicates_list(text);
-- drop function if exists workspace.curator_duplicates_scan(real, jsonb, boolean);
-- drop function if exists workspace.curator_name_match(uuid, text, text[], vector, integer);
-- drop function if exists workspace.curator_page_index(uuid, text[], text, vector, integer);
-- drop table if exists workspace.page_key_redirects;
-- drop table if exists workspace.page_duplicates;
-- drop function if exists workspace._page_names(text, text[], text);
-- drop function if exists workspace._page_identities(jsonb);
-- drop function if exists workspace._jsonb_lower_list(jsonb);
-- drop function if exists workspace._name_norm(text);
-- alter table workspace.curator_settings drop constraint if exists curator_settings_strong_values;
-- alter table workspace.curator_settings drop column if exists dup_scan_at, drop column if exists strong_model;
