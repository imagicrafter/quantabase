-- 0053_curator.sql
--
-- The curator inside the service (Phase 10 build order, Step C).
--
-- The curator reads raw source items nobody has curated yet, asks a hosted
-- model for small patches, and writes them to the item OWNER's pages. It has
-- no connectors and no OAuth subject: it acts for the owner of the item in
-- hand, through the functions below, which are granted to kb_engine only.
--
-- WHAT THE DATABASE ENFORCES (whatever the model or the service says)
--   * An item updates only its owner's pages.
--   * Topic containment: an item writes only to pages whose topics are all
--     topics of the item (and still held by the owner). A page with no topics
--     is its owner's alone and may take any of the owner's items. A new page
--     gets exactly the item's topics. A private mail is never folded into a
--     page shared more widely.
--   * The page write goes through the same core as page_save (history,
--     links, summary queue, no silent overwrite).
--   * Items flagged as possible steering attempts are never claimed until
--     their owner releases them.
--   * Large changes wait in curator_reviews until the owner says yes.
--
-- TABLES
--   curator_settings   one row: on/off, model, templates, batch size, the
--                      service address the cron poke calls
--   curator_reviews    changes waiting for a person's yes
--   curator_runs       one row per tick: counts and failures
--
-- SECRETS live in Supabase Vault, never in a table here:
--   kbe_tick_secret    shared secret the cron poke sends; checked in the
--                      database, so the service never holds it
--   kbe_model_key      the DigitalOcean inference key, read by the service
-- Both are read with dynamic SQL so this file applies on a database without
-- the vault or pg_net extensions (a missing extension reads as "not set").
--
-- page_save is re-declared here as a thin wrapper over _page_save_as, so the
-- person path and the curator path share one write core.

-- ── source_items: curator bookkeeping ───────────────────────────────────────

alter table workspace.source_items
    add column if not exists flag_reason           text,
    add column if not exists released_at           timestamptz,
    add column if not exists released_by           uuid references workspace.principals(id) on delete set null,
    add column if not exists curator_claimed_until timestamptz,
    add column if not exists curator_attempts      integer not null default 0,
    add column if not exists curator_outcome       text,
    add column if not exists curator_error         text;

do $$
begin
    if not exists (select 1 from pg_constraint
                   where conname = 'source_items_curator_outcome_values') then
        alter table workspace.source_items
            add constraint source_items_curator_outcome_values check (
                curator_outcome is null or curator_outcome in
                ('applied', 'queued', 'mixed', 'no_change', 'superseded', 'failed'));
    end if;
end;
$$;

comment on column workspace.source_items.flag_reason is
    'Why the steering screen held this item. It waits until its owner releases it.';
comment on column workspace.source_items.curator_claimed_until is
    'Lease: a run is working on this item until then. A crashed run frees it on expiry.';

-- ── settings ────────────────────────────────────────────────────────────────

create table if not exists workspace.curator_settings (
    id            boolean     primary key default true,
    enabled       boolean     not null default false,
    model         text        not null default 'openai-gpt-oss-120b',
    templates     text[]      not null default '{}',
    batch_size    integer     not null default 10,
    max_attempts  integer     not null default 3,
    engine_url    text,
    updated_at    timestamptz not null default now(),
    constraint curator_settings_one_row check (id),
    -- No model below the floor measured in test A1 (2026-11-19).
    constraint curator_settings_model_values
        check (model in ('openai-gpt-oss-120b', 'deepseek-v4.1-flash')),
    constraint curator_settings_batch_size check (batch_size between 1 and 200),
    constraint curator_settings_attempts check (max_attempts between 1 and 10),
    constraint curator_settings_engine_url
        check (engine_url is null or engine_url ~ '^https://[^/[:space:]]+/internal/curator/tick$')
);

comment on table workspace.curator_settings is
    'One row: whether the curator runs, which model, which templates, batch size, '
    'and the tick address the cron poke calls. Off until someone turns it on.';

insert into workspace.curator_settings (id) values (true) on conflict (id) do nothing;

alter table workspace.curator_settings enable row level security;
revoke all on workspace.curator_settings from public;
revoke all on workspace.curator_settings from anon, authenticated;

-- ── review queue ────────────────────────────────────────────────────────────

create table if not exists workspace.curator_reviews (
    id                  uuid        primary key default gen_random_uuid(),
    owner_principal_id  uuid        not null references workspace.principals(id) on delete cascade,
    item_id             uuid        not null references workspace.source_items(id) on delete cascade,
    page_id             uuid        references workspace.pages(id) on delete set null,
    page_key            text        not null,
    kind                text        not null,
    reasons             text[]      not null default '{}',
    proposal            jsonb       not null,
    base_hash           text,
    status              text        not null default 'pending',
    error               text,
    created_at          timestamptz not null default now(),
    decided_at          timestamptz,
    decided_by          uuid        references workspace.principals(id) on delete set null,
    applied_at          timestamptz,
    constraint curator_reviews_kind_values check (kind in ('update', 'new_page')),
    constraint curator_reviews_status_values
        check (status in ('pending', 'approved', 'rejected', 'applied', 'stale')),
    constraint curator_reviews_proposal_object check (jsonb_typeof(proposal) = 'object')
);

comment on table workspace.curator_reviews is
    'Curator changes that need a person''s yes (new deal, stage change, a large '
    'change). Applied on the next tick after the owner approves.';

-- One open proposal per item and page key: a re-run never queues twice.
create unique index if not exists curator_reviews_open_uniq
    on workspace.curator_reviews (item_id, page_key, kind)
    where status in ('pending', 'approved');
create index if not exists curator_reviews_owner_status
    on workspace.curator_reviews (owner_principal_id, status, created_at desc);

alter table workspace.curator_reviews enable row level security;
revoke all on workspace.curator_reviews from public;
revoke all on workspace.curator_reviews from anon, authenticated;

-- ── runs ────────────────────────────────────────────────────────────────────

create table if not exists workspace.curator_runs (
    id           uuid        primary key default gen_random_uuid(),
    mode         text        not null default 'tick',
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    status       text        not null default 'running',
    stats        jsonb       not null default '{}'::jsonb,
    constraint curator_runs_mode_values check (mode in ('tick', 'batch')),
    constraint curator_runs_status_values check (status in ('running', 'ok', 'failed'))
);

comment on table workspace.curator_runs is
    'One row per curator tick: counts of items, patches, reviews, summaries, '
    'pruned history rows and failed cron pokes. The status page reads it.';

create index if not exists curator_runs_started on workspace.curator_runs (started_at desc);

alter table workspace.curator_runs enable row level security;
revoke all on workspace.curator_runs from public;
revoke all on workspace.curator_runs from anon, authenticated;


-- ── one write core for page_save and the curator ────────────────────────────

create or replace function workspace._page_save_as(
    p_principal     uuid,
    p_allowed       text[],
    p_page          jsonb,
    p_expected_hash text
)
returns table (
    id            uuid,
    key           text,
    content_hash  text,
    created       boolean,
    changed       boolean,
    updated_at    timestamptz
)
language plpgsql
volatile
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_key       text;
    v_drawer    text;
    v_title     text;
    v_status    text;
    v_topics    text[];
    v_content   jsonb;
    v_hash      text;
    v_existing  workspace.pages%rowtype;
    v_id        uuid;
    v_now       timestamptz := now();
begin
    if p_principal is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    if p_page is null or jsonb_typeof(p_page) <> 'object' then
        raise exception 'page must be an object' using errcode = '22023';
    end if;

    v_key := lower(btrim(coalesce(p_page->>'key', '')));
    if length(v_key) not between 1 and 200 or v_key ~ '[[:space:]]' then
        raise exception 'key must be 1 to 200 characters with no spaces' using errcode = '22023';
    end if;
    v_drawer := btrim(coalesce(p_page->>'drawer', ''));
    if v_drawer !~ '^[a-z][a-z0-9-]*$' then
        raise exception 'drawer must be a drawer name such as people' using errcode = '22023';
    end if;
    v_title := btrim(coalesce(p_page->>'title', ''));
    if length(v_title) not between 1 and 300 then
        raise exception 'title must be 1 to 300 characters' using errcode = '22023';
    end if;
    v_status := coalesce(p_page->>'status', 'unreviewed');
    if v_status not in ('draft', 'unreviewed', 'current') then
        raise exception 'status must be draft, unreviewed or current' using errcode = '22023';
    end if;
    if coalesce(jsonb_typeof(p_page->'fields'), 'object') not in ('object', 'null')
       or coalesce(jsonb_typeof(p_page->'sources'), 'array') not in ('array', 'null')
       or coalesce(jsonb_typeof(p_page->'verified'), 'array') not in ('array', 'null') then
        raise exception 'fields must be an object; sources and verified lists' using errcode = '22023';
    end if;
    if length(coalesce(p_page->>'body', '')) > 200000
       or length(coalesce(p_page->>'description', '')) > 500 then
        raise exception 'body (200000) or description (500) is too long' using errcode = '22023';
    end if;

    v_topics := array(select distinct lower(t)
                      from unnest(workspace._jsonb_text_array(p_page->'topics', 'topics')) t
                      order by 1);
    if not (v_topics <@ coalesce(p_allowed, array[]::text[])) then
        raise exception 'a page can only be filed under topics you hold' using errcode = '22023';
    end if;

    v_content := jsonb_build_object(
        'drawer',      v_drawer,
        'template',    nullif(btrim(coalesce(p_page->>'template', '')), ''),
        'title',       v_title,
        'aliases',     to_jsonb(workspace._jsonb_text_array(p_page->'aliases', 'aliases')),
        'description', nullif(btrim(coalesce(p_page->>'description', '')), ''),
        'fields',      coalesce(nullif(p_page->'fields', 'null'::jsonb), '{}'::jsonb),
        'topics',      to_jsonb(v_topics),
        'status',      v_status,
        'tags',        to_jsonb(workspace._jsonb_text_array(p_page->'tags', 'tags')),
        'related',     to_jsonb(workspace._jsonb_text_array(p_page->'related', 'related')),
        'sources',     coalesce(nullif(p_page->'sources', 'null'::jsonb), '[]'::jsonb),
        'generated',   nullif(p_page->'generated', 'null'::jsonb),
        'verified',    coalesce(nullif(p_page->'verified', 'null'::jsonb), '[]'::jsonb),
        'body',        coalesce(p_page->>'body', ''));
    v_hash := encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex');

    select * into v_existing
    from workspace.pages p
    where p.owner_principal_id = p_principal and p.key = v_key and p.deleted_at is null
    for update;

    if found then
        if p_expected_hash is null then
            raise exception 'you already have a page with this key; read it with find_entity and pass its content_hash as expected_hash'
                using errcode = '22023';
        end if;
        if p_expected_hash <> v_existing.content_hash then
            raise exception 'the page has changed since it was read; read it again'
                using errcode = '22023';
        end if;
        if v_hash = v_existing.content_hash then
            return query select v_existing.id, v_key, v_hash, false, false, v_existing.updated_at;
            return;
        end if;
        update workspace.pages p set
            drawer = v_drawer, template = v_content->>'template', title = v_title,
            aliases = workspace._jsonb_text_array(v_content->'aliases', 'aliases'),
            description = v_content->>'description', fields = v_content->'fields',
            topics = v_topics, status = v_status,
            tags = workspace._jsonb_text_array(v_content->'tags', 'tags'),
            related = workspace._jsonb_text_array(v_content->'related', 'related'),
            sources = v_content->'sources', generated = v_content->'generated',
            verified = v_content->'verified', body = v_content->>'body',
            content_hash = v_hash, summary_queued_at = v_now, updated_at = v_now
        where p.id = v_existing.id;
        v_id := v_existing.id;
    else
        if p_expected_hash is not null then
            raise exception 'you have no page with this key to update' using errcode = '22023';
        end if;
        insert into workspace.pages as p (
            owner_principal_id, drawer, key, template, title, aliases, description,
            fields, topics, status, tags, related, sources, generated, verified,
            body, content_hash, summary_queued_at, created_at, updated_at)
        values (
            p_principal, v_drawer, v_key, v_content->>'template', v_title,
            workspace._jsonb_text_array(v_content->'aliases', 'aliases'),
            v_content->>'description', v_content->'fields', v_topics, v_status,
            workspace._jsonb_text_array(v_content->'tags', 'tags'),
            workspace._jsonb_text_array(v_content->'related', 'related'),
            v_content->'sources', v_content->'generated', v_content->'verified',
            v_content->>'body', v_hash, v_now, v_now, v_now)
        returning p.id into v_id;
    end if;

    insert into workspace.page_history (page_id, content_hash, snapshot, saved_by, saved_at)
    values (v_id, v_hash, v_content || jsonb_build_object('key', v_key), p_principal, v_now);

    perform workspace._page_links_rewrite(v_id);

    return query select v_id, v_key, v_hash, v_existing.id is null, true, v_now;
end;
$$;

revoke all on function workspace._page_save_as(uuid, text[], jsonb, text) from public;
revoke all on function workspace._page_save_as(uuid, text[], jsonb, text) from anon, authenticated;

create or replace function workspace.page_save(
    p_oauth_subject text,
    p_page          jsonb,
    p_expected_hash text default null
)
returns table (
    id            uuid,
    key           text,
    content_hash  text,
    created       boolean,
    changed       boolean,
    updated_at    timestamptz
)
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
begin
    return query
    select * from workspace._page_save_as(
        workspace._principal_id_for_oauth_subject(p_oauth_subject),
        coalesce(workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]),
        p_page,
        p_expected_hash);
end;
$$;

revoke all on function workspace.page_save(text, jsonb, text) from public;
revoke all on function workspace.page_save(text, jsonb, text) from anon, authenticated;
grant execute on function workspace.page_save(text, jsonb, text) to kb_engine;


-- ── helpers (no grants) ─────────────────────────────────────────────────────

-- The live item, its owner (active only) and the topics a write may use:
-- the item's topics that the owner still holds.
create or replace function workspace._curator_item_scope(p_item_id uuid)
returns table (owner_id uuid, allowed text[], released boolean)
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_item  workspace.source_items%rowtype;
    v_owner workspace.principals%rowtype;
begin
    select * into v_item from workspace.source_items s
    where s.id = p_item_id and s.deleted_at is null;
    if not found then
        raise exception 'no such item' using errcode = '22023';
    end if;
    select * into v_owner from workspace.principals o
    where o.id = v_item.owner_principal_id and o.active is true;
    if not found then
        raise exception 'the item''s owner is not active' using errcode = '42501';
    end if;
    return query select
        v_owner.id,
        array(select t from unnest(v_item.topics) t
              where t = any(workspace._resolve_domains_for_principal(v_owner))
              order by 1),
        v_item.released_at is not null;
end;
$$;

revoke all on function workspace._curator_item_scope(uuid) from public;
revoke all on function workspace._curator_item_scope(uuid) from anon, authenticated;

-- A vault secret by name, or null when the vault is absent or the name unset.
create or replace function workspace._curator_vault_secret(p_name text)
returns text
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_value text;
begin
    if to_regclass('vault.decrypted_secrets') is null then
        return null;
    end if;
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
        into v_value using p_name;
    return nullif(v_value, '');
end;
$$;

revoke all on function workspace._curator_vault_secret(text) from public;
revoke all on function workspace._curator_vault_secret(text) from anon, authenticated;


-- ── settings and secrets (kb_engine) ────────────────────────────────────────

create or replace function workspace.curator_settings_get()
returns table (
    enabled      boolean,
    model        text,
    templates    text[],
    batch_size   integer,
    max_attempts integer,
    engine_url   text,
    has_model_key boolean
)
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select s.enabled, s.model, s.templates, s.batch_size, s.max_attempts, s.engine_url,
           workspace._curator_vault_secret('kbe_model_key') is not null
    from workspace.curator_settings s
    where s.id;
$$;

-- True only when the shared secret matches the one in the vault. The service
-- passes what the caller sent and never holds the secret itself.
create or replace function workspace.curator_tick_secret_ok(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_want text := workspace._curator_vault_secret('kbe_tick_secret');
begin
    if v_want is null or p_secret is null or length(v_want) < 32 then
        return false;
    end if;
    return sha256(convert_to(p_secret, 'UTF8')) = sha256(convert_to(v_want, 'UTF8'));
end;
$$;

-- The inference key, for the service's model calls only.
create or replace function workspace.curator_model_key()
returns text
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select workspace._curator_vault_secret('kbe_model_key');
$$;

-- For pg_cron (runs as postgres; no grant to any API role). Posts to the
-- service's tick address with the vault secret in a header, so the secret
-- never appears in cron.job. Returns the pg_net request id, or null when
-- pg_net, the address or the secret is missing.
create or replace function workspace.curator_tick_poke(p_mode text default 'tick')
returns bigint
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_url    text := (select s.engine_url from workspace.curator_settings s where s.id);
    v_secret text := workspace._curator_vault_secret('kbe_tick_secret');
    v_id     bigint;
begin
    if v_url is null or v_secret is null or to_regprocedure(
        'net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
        return null;
    end if;
    execute 'select net.http_post(url := $1, body := $2, params := ''{}''::jsonb, '
            'headers := $3, timeout_milliseconds := 5000)'
        into v_id
        using v_url,
              jsonb_build_object('mode', case when p_mode = 'batch' then 'batch' else 'tick' end),
              jsonb_build_object('Content-Type', 'application/json', 'X-Kbe-Tick', v_secret);
    return v_id;
end;
$$;

-- Failed pokes since a time: pg_cron reports success even when the HTTP call
-- failed, so the service reads pg_net's response table on each tick.
create or replace function workspace.curator_poke_failures(p_since timestamptz)
returns table (failed integer, last_error text)
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    if to_regclass('net._http_response') is null then
        return query select 0, null::text;
        return;
    end if;
    return query execute
        'select count(*)::int, '
        '       (array_agg(coalesce(nullif(r.error_msg, ''''), ''HTTP '' || r.status_code::text, ''timed out'') '
        '                  order by r.created desc))[1] '
        'from net._http_response r '
        'where r.created > $1 '
        '  and (r.timed_out is true or r.error_msg is not null '
        '       or r.status_code is null or r.status_code not between 200 and 299)'
        using p_since;
end;
$$;


-- ── runs ────────────────────────────────────────────────────────────────────

-- Start a run unless one started in the last 15 minutes is still running.
-- Returns the run id, or null when busy. A crashed run is closed as failed.
create or replace function workspace.curator_run_start(p_mode text default 'tick')
returns uuid
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_id uuid;
begin
    perform pg_advisory_xact_lock(hashtext('kbe-curator-run'));
    update workspace.curator_runs r
       set status = 'failed', finished_at = now(),
           stats = r.stats || '{"error":"run did not finish"}'::jsonb
     where r.status = 'running' and r.started_at < now() - interval '15 minutes';
    if exists (select 1 from workspace.curator_runs r where r.status = 'running') then
        return null;
    end if;
    insert into workspace.curator_runs (mode)
    values (case when p_mode = 'batch' then 'batch' else 'tick' end)
    returning id into v_id;
    return v_id;
end;
$$;

create or replace function workspace.curator_run_finish(p_run uuid, p_ok boolean, p_stats jsonb)
returns void
language sql
volatile
security definer
set search_path = workspace, pg_temp
as $$
    update workspace.curator_runs r
       set status = case when p_ok then 'ok' else 'failed' end,
           finished_at = now(),
           stats = case when jsonb_typeof(p_stats) = 'object' then p_stats else '{}'::jsonb end
     where r.id = p_run and r.status = 'running';
$$;

-- When the last run finished (to read failed pokes since then).
create or replace function workspace.curator_last_run_at()
returns timestamptz
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select max(r.started_at) from workspace.curator_runs r where r.status <> 'running';
$$;


-- ── items ───────────────────────────────────────────────────────────────────

-- Claim up to p_limit items: live, not curated, not flagged (or released by
-- their owner), not leased, under the attempt limit, active owner. An older
-- version of an item that has a newer one is closed as 'superseded' instead.
create or replace function workspace.curator_claim(p_limit integer, p_lease_seconds integer default 600)
returns table (
    id                uuid,
    owner_principal_id uuid,
    owner_email       text,
    source            text,
    source_id         text,
    version           integer,
    title             text,
    body              text,
    topics            text[],
    metadata          jsonb,
    source_created_at timestamptz,
    received_at       timestamptz,
    released          boolean
)
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
#variable_conflict use_column
declare
    v_max integer := (select s.max_attempts from workspace.curator_settings s where s.id);
begin
    update workspace.source_items s
       set curated_at = now(), curator_outcome = 'superseded', curator_claimed_until = null
     where s.curated_at is null and s.deleted_at is null
       and exists (select 1 from workspace.source_items n
                   where n.owner_principal_id = s.owner_principal_id
                     and n.source = s.source and n.source_id = s.source_id
                     and n.version > s.version and n.deleted_at is null);

    return query
    with picked as (
        select s.id
        from workspace.source_items s
        join workspace.principals o on o.id = s.owner_principal_id and o.active is true
        where s.curated_at is null
          and s.deleted_at is null
          and (s.flagged is false or s.released_at is not null)
          and (s.curator_claimed_until is null or s.curator_claimed_until < now())
          and s.curator_attempts < coalesce(v_max, 3)
        order by s.received_at, s.id
        limit greatest(1, least(coalesce(p_limit, 10), 200))
        for update of s skip locked
    )
    update workspace.source_items s
       set curator_claimed_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 3600))),
           curator_attempts = s.curator_attempts + 1
      from picked
     where s.id = picked.id
    returning s.id, s.owner_principal_id,
              (select o.email from workspace.principals o where o.id = s.owner_principal_id),
              s.source, s.source_id, s.version, s.title, s.body, s.topics, s.metadata,
              s.source_created_at, s.received_at, s.released_at is not null;
end;
$$;

-- Hold an item for a person: the steering screen found instruction-like text.
create or replace function workspace.curator_flag(p_item_id uuid, p_reason text)
returns void
language sql
volatile
security definer
set search_path = workspace, pg_temp
as $$
    update workspace.source_items s
       set flagged = true, flag_reason = left(coalesce(p_reason, 'flagged'), 500),
           curator_claimed_until = null
     where s.id = p_item_id and s.released_at is null;
$$;

-- Close an item. 'failed' only frees the lease and records the error (the
-- item is tried again until max_attempts); every other outcome marks it
-- curated with the pages it touched (added to any earlier ones).
create or replace function workspace.curator_item_done(
    p_item_id uuid,
    p_outcome text,
    p_pages   uuid[],
    p_error   text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    if p_outcome not in ('applied', 'queued', 'mixed', 'no_change', 'failed') then
        raise exception 'unknown outcome' using errcode = '22023';
    end if;
    update workspace.source_items s
       set curated_at = case when p_outcome = 'failed' then s.curated_at else now() end,
           curator_outcome = p_outcome,
           curated_pages = array(select distinct u from unnest(
               s.curated_pages || coalesce(p_pages, array[]::uuid[])) u where u is not null),
           curator_error = case when p_outcome = 'failed' then left(p_error, 500) else null end,
           curator_claimed_until = null
     where s.id = p_item_id;
end;
$$;


-- ── pages for the curator ───────────────────────────────────────────────────

-- The shortlist for one item: the item owner's pages that the item may write
-- to (topic containment), matched by key or alias first, then by keyword.
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
          and p.topics <@ v_allowed
    ),
    by_key as (
        select m.id, case when m.key = any(v_keys) then 'key' else 'alias' end as how, 0 as rnk
        from mine m
        where m.key = any(v_keys)
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

-- Save a page for the item's owner. Topics must be within the item's topics
-- that the owner still holds; an existing page outside them cannot be
-- written, whatever its key.
create or replace function workspace.curator_page_save(
    p_item_id       uuid,
    p_page          jsonb,
    p_expected_hash text default null
)
returns table (
    id            uuid,
    key           text,
    content_hash  text,
    created       boolean,
    changed       boolean,
    updated_at    timestamptz
)
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_owner   uuid;
    v_allowed text[];
    v_key     text := lower(btrim(coalesce(p_page->>'key', '')));
begin
    select sc.owner_id, sc.allowed into v_owner, v_allowed
    from workspace._curator_item_scope(p_item_id) sc;

    if exists (select 1 from workspace.pages p
               where p.owner_principal_id = v_owner and p.key = v_key
                 and p.deleted_at is null and not (p.topics <@ v_allowed)) then
        raise exception 'that page is shared more widely than this item' using errcode = '22023';
    end if;

    return query
    select * from workspace._page_save_as(v_owner, v_allowed, p_page, p_expected_hash);
end;
$$;


-- ── review queue ────────────────────────────────────────────────────────────

-- Queue a change for the owner's yes. A repeat of an open proposal for the
-- same item, page key and kind is ignored. Returns the review id (null on a
-- repeat).
create or replace function workspace.curator_review_add(
    p_item_id   uuid,
    p_page_id   uuid,
    p_page_key  text,
    p_kind      text,
    p_reasons   text[],
    p_proposal  jsonb,
    p_base_hash text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_owner uuid;
    v_id    uuid;
begin
    select sc.owner_id into v_owner from workspace._curator_item_scope(p_item_id) sc;
    if p_page_id is not null and not exists (
        select 1 from workspace.pages p where p.id = p_page_id and p.owner_principal_id = v_owner) then
        raise exception 'that page is not the item owner''s' using errcode = '22023';
    end if;
    insert into workspace.curator_reviews
        (owner_principal_id, item_id, page_id, page_key, kind, reasons, proposal, base_hash)
    values (v_owner, p_item_id, p_page_id, lower(btrim(p_page_key)), p_kind,
            coalesce(p_reasons, array[]::text[]), p_proposal, p_base_hash)
    on conflict (item_id, page_key, kind) where status in ('pending', 'approved') do nothing
    returning id into v_id;
    return v_id;
end;
$$;

-- Approved reviews the service applies on its next tick.
create or replace function workspace.curator_reviews_approved(p_limit integer default 20)
returns table (
    id        uuid,
    item_id   uuid,
    page_id   uuid,
    page_key  text,
    kind      text,
    proposal  jsonb,
    base_hash text
)
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select r.id, r.item_id, r.page_id, r.page_key, r.kind, r.proposal, r.base_hash
    from workspace.curator_reviews r
    where r.status = 'approved'
    order by r.decided_at, r.id
    limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

create or replace function workspace.curator_review_mark(p_id uuid, p_status text, p_error text default null)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    if p_status not in ('applied', 'stale') then
        raise exception 'status must be applied or stale' using errcode = '22023';
    end if;
    update workspace.curator_reviews r
       set status = p_status,
           applied_at = case when p_status = 'applied' then now() else null end,
           error = left(p_error, 500)
     where r.id = p_id and r.status = 'approved';
end;
$$;

-- The owner's own queue (for the app, Step D). Owner only; no administrator
-- reads another person's queue.
create or replace function workspace.curator_review_list(p_oauth_subject text, p_status text default 'pending')
returns table (
    id         uuid,
    item_id    uuid,
    item_title text,
    page_key   text,
    kind       text,
    reasons    text[],
    proposal   jsonb,
    status     text,
    created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
begin
    if v_principal is null then
        return;
    end if;
    return query
    select r.id, r.item_id, s.title, r.page_key, r.kind, r.reasons, r.proposal, r.status, r.created_at
    from workspace.curator_reviews r
    join workspace.source_items s on s.id = r.item_id
    where r.owner_principal_id = v_principal
      and (p_status is null or r.status = p_status)
    order by r.created_at desc
    limit 200;
end;
$$;

-- The owner says yes or no. Returns true when a pending review changed.
create or replace function workspace.curator_review_decide(p_oauth_subject text, p_id uuid, p_approve boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
begin
    if v_principal is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    update workspace.curator_reviews r
       set status = case when p_approve then 'approved' else 'rejected' end,
           decided_at = now(), decided_by = v_principal
     where r.id = p_id and r.owner_principal_id = v_principal and r.status = 'pending';
    return found;
end;
$$;

-- The owner lets a flagged item through. It is still data, never
-- instructions; the curator queues every change from a released item.
create or replace function workspace.source_item_release(p_oauth_subject text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
begin
    if v_principal is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    update workspace.source_items s
       set released_at = now(), released_by = v_principal
     where s.id = p_id and s.owner_principal_id = v_principal
       and s.flagged is true and s.released_at is null and s.deleted_at is null;
    return found;
end;
$$;


-- ── summaries ───────────────────────────────────────────────────────────────

-- Pages whose summary and embedding need writing (set on every content change).
create or replace function workspace.curator_summary_queue(p_limit integer default 20)
returns table (
    id                uuid,
    drawer            text,
    title             text,
    description       text,
    body              text,
    summary_queued_at timestamptz
)
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select p.id, p.drawer, p.title, p.description, left(p.body, 20000), p.summary_queued_at
    from workspace.pages p
    where p.summary_queued_at is not null and p.deleted_at is null
    order by p.summary_queued_at, p.id
    limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

-- Write a page's summary and embedding and clear its marker, but only if the
-- page has not changed since the summary was asked for (same marker). A page
-- saved again meanwhile keeps its marker and is summarised next time.
create or replace function workspace.curator_summary_write(
    p_page_id      uuid,
    p_queued_at    timestamptz,
    p_distillation text,
    p_embedding    vector(384)
)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
begin
    if p_distillation is null or length(btrim(p_distillation)) not between 1 and 2000 then
        raise exception 'summary must be 1 to 2000 characters' using errcode = '22023';
    end if;
    update workspace.pages p
       set distillation = btrim(p_distillation), embedding = p_embedding, summary_queued_at = null
     where p.id = p_page_id and p.deleted_at is null and p.summary_queued_at = p_queued_at;
    return found;
end;
$$;


-- ── grants: kb_engine only ──────────────────────────────────────────────────

revoke all on function workspace.curator_settings_get() from public;
revoke all on function workspace.curator_settings_get() from anon, authenticated;
grant execute on function workspace.curator_settings_get() to kb_engine;

revoke all on function workspace.curator_tick_secret_ok(text) from public;
revoke all on function workspace.curator_tick_secret_ok(text) from anon, authenticated;
grant execute on function workspace.curator_tick_secret_ok(text) to kb_engine;

revoke all on function workspace.curator_model_key() from public;
revoke all on function workspace.curator_model_key() from anon, authenticated;
grant execute on function workspace.curator_model_key() to kb_engine;

revoke all on function workspace.curator_tick_poke(text) from public;
revoke all on function workspace.curator_tick_poke(text) from anon, authenticated;

revoke all on function workspace.curator_poke_failures(timestamptz) from public;
revoke all on function workspace.curator_poke_failures(timestamptz) from anon, authenticated;
grant execute on function workspace.curator_poke_failures(timestamptz) to kb_engine;

revoke all on function workspace.curator_run_start(text) from public;
revoke all on function workspace.curator_run_start(text) from anon, authenticated;
grant execute on function workspace.curator_run_start(text) to kb_engine;

revoke all on function workspace.curator_run_finish(uuid, boolean, jsonb) from public;
revoke all on function workspace.curator_run_finish(uuid, boolean, jsonb) from anon, authenticated;
grant execute on function workspace.curator_run_finish(uuid, boolean, jsonb) to kb_engine;

revoke all on function workspace.curator_last_run_at() from public;
revoke all on function workspace.curator_last_run_at() from anon, authenticated;
grant execute on function workspace.curator_last_run_at() to kb_engine;

revoke all on function workspace.curator_claim(integer, integer) from public;
revoke all on function workspace.curator_claim(integer, integer) from anon, authenticated;
grant execute on function workspace.curator_claim(integer, integer) to kb_engine;

revoke all on function workspace.curator_flag(uuid, text) from public;
revoke all on function workspace.curator_flag(uuid, text) from anon, authenticated;
grant execute on function workspace.curator_flag(uuid, text) to kb_engine;

revoke all on function workspace.curator_item_done(uuid, text, uuid[], text) from public;
revoke all on function workspace.curator_item_done(uuid, text, uuid[], text) from anon, authenticated;
grant execute on function workspace.curator_item_done(uuid, text, uuid[], text) to kb_engine;

revoke all on function workspace.curator_candidates(uuid, text[], text, integer) from public;
revoke all on function workspace.curator_candidates(uuid, text[], text, integer) from anon, authenticated;
grant execute on function workspace.curator_candidates(uuid, text[], text, integer) to kb_engine;

revoke all on function workspace.curator_page_save(uuid, jsonb, text) from public;
revoke all on function workspace.curator_page_save(uuid, jsonb, text) from anon, authenticated;
grant execute on function workspace.curator_page_save(uuid, jsonb, text) to kb_engine;

revoke all on function workspace.curator_review_add(uuid, uuid, text, text, text[], jsonb, text) from public;
revoke all on function workspace.curator_review_add(uuid, uuid, text, text, text[], jsonb, text) from anon, authenticated;
grant execute on function workspace.curator_review_add(uuid, uuid, text, text, text[], jsonb, text) to kb_engine;

revoke all on function workspace.curator_reviews_approved(integer) from public;
revoke all on function workspace.curator_reviews_approved(integer) from anon, authenticated;
grant execute on function workspace.curator_reviews_approved(integer) to kb_engine;

revoke all on function workspace.curator_review_mark(uuid, text, text) from public;
revoke all on function workspace.curator_review_mark(uuid, text, text) from anon, authenticated;
grant execute on function workspace.curator_review_mark(uuid, text, text) to kb_engine;

revoke all on function workspace.curator_review_list(text, text) from public;
revoke all on function workspace.curator_review_list(text, text) from anon, authenticated;
grant execute on function workspace.curator_review_list(text, text) to kb_engine;

revoke all on function workspace.curator_review_decide(text, uuid, boolean) from public;
revoke all on function workspace.curator_review_decide(text, uuid, boolean) from anon, authenticated;
grant execute on function workspace.curator_review_decide(text, uuid, boolean) to kb_engine;

revoke all on function workspace.source_item_release(text, uuid) from public;
revoke all on function workspace.source_item_release(text, uuid) from anon, authenticated;
grant execute on function workspace.source_item_release(text, uuid) to kb_engine;

revoke all on function workspace.curator_summary_queue(integer) from public;
revoke all on function workspace.curator_summary_queue(integer) from anon, authenticated;
grant execute on function workspace.curator_summary_queue(integer) to kb_engine;

revoke all on function workspace.curator_summary_write(uuid, timestamptz, text, vector) from public;
revoke all on function workspace.curator_summary_write(uuid, timestamptz, text, vector) from anon, authenticated;
grant execute on function workspace.curator_summary_write(uuid, timestamptz, text, vector) to kb_engine;


-- CRON (not created by this file; see docs/operations.md "Curator timer") ---
-- select vault.create_secret('<long random>', 'kbe_tick_secret');
-- update workspace.curator_settings set engine_url = 'https://<host>/internal/curator/tick';
-- select cron.schedule('kbe-curator-tick', '*/5 * * * *', 'select workspace.curator_tick_poke()');


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('anon', 'workspace.curator_claim(integer, integer)', 'execute');  -- f
-- select has_function_privilege('kb_engine', 'workspace.curator_tick_poke(text)', 'execute');     -- f
-- select * from workspace.curator_settings_get();


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply 0051 to restore the original page_save body, then drop the
-- functions above, the three tables and the added source_items columns.
