-- 0054_app_screens.sql
--
-- The app screens (Phase 10 build order, Step D): the functions behind the
-- setup screens after sign-in (templates, topics, model key, timer, health)
-- and the owner screens (review queue, flagged items, pages, history).
--
-- WHO IS ASKING
--   The service passes the email of the signed-in person, which it has just
--   read from a verified Cloudflare Access assertion (the same contract as
--   the admin_* functions in 0033). Every function below resolves that email
--   to an ACTIVE person and refuses anything else. Owner screens act on the
--   caller's own rows only; settings need an administrator.
--
-- APPROVALS ONLY THROUGH THE APP
--   The OAuth-subject versions of decide, release and list (0053) are dropped
--   here. The MCP connector passes an OAuth subject; these functions take an
--   email that only the app's sign-in check supplies, and no MCP tool calls
--   them (engine/tests/app/mcp-boundary.test.ts checks that).
--
-- TEMPLATES
--   The chosen entity templates move out of curator_settings.templates (the
--   Step C stopgap) into their own table, engine_templates. curator_settings_get
--   keeps its signature and now reads the new table.
--
-- SECRETS
--   app_secret_set writes one named secret into Supabase Vault and returns
--   nothing. The tick secret is made inside the database (app_timer_set) and
--   never leaves it. kbe_embed_token is written by the setup screen through the
--   Management API and read by the service with engine_embed_token().
--
-- Every function here: SECURITY DEFINER, fixed search_path, no grant to
-- anon or authenticated, execute to kb_engine only.

-- ── templates ───────────────────────────────────────────────────────────────

create table if not exists workspace.engine_templates (
    name       text        primary key,
    position   integer     not null,
    chosen_at  timestamptz not null default now(),
    chosen_by  uuid        references workspace.principals(id) on delete set null,
    constraint engine_templates_name_format check (name ~ '^[a-z][a-z0-9-]*$' and name <> 'base')
);

comment on table workspace.engine_templates is
    'The business templates this Engine uses, in order (base is always on and '
    'never listed). Chosen on the Template setup screen.';

alter table workspace.engine_templates enable row level security;
revoke all on workspace.engine_templates from public;
revoke all on workspace.engine_templates from anon, authenticated;

-- Carry over what Step C stored, then drop the stopgap column.
do $$
begin
    if exists (select 1 from information_schema.columns
               where table_schema = 'workspace' and table_name = 'curator_settings'
                 and column_name = 'templates') then
        insert into workspace.engine_templates (name, position)
        select u.t, u.ord::integer
        from workspace.curator_settings s,
             unnest(s.templates) with ordinality as u(t, ord)
        where s.id and u.t ~ '^[a-z][a-z0-9-]*$' and u.t <> 'base'
        on conflict (name) do nothing;
        alter table workspace.curator_settings drop column templates;
    end if;
end;
$$;

create or replace function workspace.engine_templates_get()
returns text[]
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(array_agg(t.name order by t.position, t.name), array[]::text[])
    from workspace.engine_templates t;
$$;

-- Same signature as 0053; templates now come from engine_templates.
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
    select s.enabled, s.model, workspace.engine_templates_get(), s.batch_size, s.max_attempts,
           s.engine_url, workspace._curator_vault_secret('kbe_model_key') is not null
    from workspace.curator_settings s
    where s.id;
$$;

-- ── who is asking ───────────────────────────────────────────────────────────

-- The active person with this email, or 42501.
create or replace function workspace._app_person(p_email text)
returns workspace.principals
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
begin
    v_who := workspace._active_principal_by_email(p_email);
    if v_who.id is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    return v_who;
end;
$$;

create or replace function workspace.app_whoami(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._active_principal_by_email(p_email);
begin
    if v_who.id is null then
        return null;
    end if;
    return jsonb_build_object(
        'display_name', v_who.display_name,
        'role', v_who.role,
        'pending_reviews', (select count(*) from workspace.curator_reviews r
                            where r.owner_principal_id = v_who.id and r.status = 'pending'),
        'flagged', (select count(*) from workspace.source_items s
                    where s.owner_principal_id = v_who.id and s.flagged is true
                      and s.released_at is null and s.curated_at is null and s.deleted_at is null),
        'pages', (select count(*) from workspace.pages p
                  where p.owner_principal_id = v_who.id and p.deleted_at is null));
end;
$$;

-- ── templates, topics (administrators) ──────────────────────────────────────

create or replace function workspace.app_templates_set(p_email text, p_names text[])
returns text[]
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who   workspace.principals%rowtype := workspace._admin_require(p_email);
    v_names text[];
begin
    -- first mention wins; the order given is kept; base is always on
    v_names := array(select x.n from (
                         select u.n, min(u.ord) as o
                         from unnest(coalesce(p_names, array[]::text[])) with ordinality as u(n, ord)
                         where u.n <> 'base'
                         group by u.n) x
                     order by x.o);
    if cardinality(v_names) > 10
       or exists (select 1 from unnest(v_names) n where n !~ '^[a-z][a-z0-9-]*$') then
        raise exception 'templates must be up to 10 template names' using errcode = '22023';
    end if;
    delete from workspace.engine_templates where true;
    insert into workspace.engine_templates (name, position, chosen_by)
    select n, ord::integer, v_who.id from unnest(v_names) with ordinality as u(n, ord);
    return workspace.engine_templates_get();
end;
$$;

create or replace function workspace.app_topics_list(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._admin_require(p_email);
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'topic', d.domain, 'label', d.label, 'sensitive', d.sensitive,
            'people', (select count(*) from workspace.access_grants g where g.domain = d.domain))
            order by d.domain)
        from workspace.domains d), '[]'::jsonb);
end;
$$;

-- Add a topic. Never changes an existing one (a sensitive topic stays locked).
create or replace function workspace.app_topic_add(
    p_email text, p_topic text, p_label text, p_sensitive boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_topic text := lower(btrim(coalesce(p_topic, '')));
    v_label text := btrim(coalesce(p_label, ''));
begin
    perform workspace._admin_require(p_email);
    if v_topic !~ '^[a-z][a-z0-9-]{0,39}$' or v_topic = 'unclassified' then
        raise exception 'a topic is 1 to 40 lower-case letters, digits or dashes, starting with a letter'
            using errcode = '22023';
    end if;
    if length(v_label) not between 1 and 80 then
        raise exception 'a label is 1 to 80 characters' using errcode = '22023';
    end if;
    insert into workspace.domains (domain, label, sensitive)
    values (v_topic, v_label, coalesce(p_sensitive, false))
    on conflict (domain) do nothing;
    return found;
end;
$$;

-- ── secrets (administrators) ────────────────────────────────────────────────

-- Write one named secret into the vault. Returns nothing, ever.
create or replace function workspace.app_secret_set(p_email text, p_name text, p_value text)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_id uuid;
begin
    perform workspace._admin_require(p_email);
    if p_name is distinct from 'kbe_model_key' then
        raise exception 'that secret cannot be set here' using errcode = '22023';
    end if;
    if p_value is null or length(p_value) not between 10 and 4096 or p_value ~ '[[:space:]]' then
        raise exception 'the key must be 10 to 4096 characters with no spaces' using errcode = '22023';
    end if;
    if to_regclass('vault.secrets') is null then
        raise exception 'Supabase Vault is not available on this database' using errcode = '55000';
    end if;
    execute 'select id from vault.secrets where name = $1 limit 1' into v_id using p_name;
    if v_id is null then
        execute 'select vault.create_secret($1, $2, $3)'
            using p_value, p_name, 'Set on the KB Engine setup screen';
    else
        execute 'select vault.update_secret($1, $2)' using v_id, p_value;
    end if;
end;
$$;

-- The embed function's bearer, for the service (no EMBED_TOKEN variable).
create or replace function workspace.engine_embed_token()
returns text
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select workspace._curator_vault_secret('kbe_embed_token');
$$;

-- ── timer (administrators) ──────────────────────────────────────────────────

create or replace function workspace._app_timer_state()
returns jsonb
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_job jsonb;
begin
    if to_regclass('cron.job') is not null then
        execute 'select jsonb_build_object(''schedule'', j.schedule, ''active'', j.active) '
                'from cron.job j where j.jobname = ''kbe-curator-tick'' limit 1'
            into v_job;
    end if;
    return jsonb_build_object(
        'cron_available', to_regclass('cron.job') is not null,
        'net_available', to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is not null,
        'vault_available', to_regclass('vault.secrets') is not null,
        'job', v_job,
        'engine_url', (select s.engine_url from workspace.curator_settings s where s.id),
        'enabled', (select s.enabled from workspace.curator_settings s where s.id),
        'model', (select s.model from workspace.curator_settings s where s.id),
        'tick_secret_set', workspace._curator_vault_secret('kbe_tick_secret') is not null,
        'last_run', (select jsonb_build_object('status', r.status, 'started_at', r.started_at,
                                               'finished_at', r.finished_at, 'stats', r.stats)
                     from workspace.curator_runs r order by r.started_at desc limit 1));
end;
$$;

create or replace function workspace.app_timer_get(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._admin_require(p_email);
    return workspace._app_timer_state();
end;
$$;

-- Point the timer at the service and switch it on or off. Makes the tick
-- secret inside the database the first time; it never leaves the database.
-- The caller names only the host, which must be the Engine's own host as
-- stored by sign-in setup (engine_settings.access.host); the address is built
-- here, so the secret can only ever be sent to this Engine.
create or replace function workspace.app_timer_set(
    p_email text, p_host text, p_every_minutes integer, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_schedule text;
    v_command  text := format('select %I.curator_tick_poke()', current_schema());
    v_id       uuid;
    v_stored   text := (select lower(btrim(s.access->>'host')) from workspace.engine_settings s where s.id);
    v_host     text := lower(btrim(coalesce(p_host, '')));
    v_url      text;
begin
    perform workspace._admin_require(p_email);
    if v_stored is null or v_stored !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' then
        raise exception 'set up sign-in first: the Engine''s host is not stored yet' using errcode = '22023';
    end if;
    if v_host <> v_stored then
        raise exception 'the timer can only call this Engine''s own host' using errcode = '22023';
    end if;
    v_url := 'https://' || v_stored || '/internal/curator/tick';
    v_schedule := case p_every_minutes
        when 5 then '*/5 * * * *' when 15 then '*/15 * * * *' when 60 then '0 * * * *' end;
    if v_schedule is null then
        raise exception 'the timer runs every 5, 15 or 60 minutes' using errcode = '22023';
    end if;
    if coalesce(p_enabled, false) and (to_regclass('cron.job') is null or to_regclass('vault.secrets') is null
        or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null) then
        raise exception 'the timer needs the pg_cron, pg_net and Vault extensions' using errcode = '55000';
    end if;

    update workspace.curator_settings s
       set engine_url = v_url, enabled = coalesce(p_enabled, false), updated_at = now()
     where s.id;

    if coalesce(p_enabled, false) and workspace._curator_vault_secret('kbe_tick_secret') is null then
        execute 'select id from vault.secrets where name = ''kbe_tick_secret'' limit 1' into v_id;
        if v_id is null then
            execute 'select vault.create_secret($1, ''kbe_tick_secret'', ''Curator timer secret'')'
                using encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text
                                               || clock_timestamp()::text, 'UTF8')), 'hex');
        end if;
    end if;

    if to_regclass('cron.job') is not null then
        execute 'select cron.unschedule(j.jobid) from cron.job j where j.jobname = ''kbe-curator-tick''';
        if coalesce(p_enabled, false) then
            execute 'select cron.schedule(''kbe-curator-tick'', $1, $2)' using v_schedule, v_command;
        end if;
    end if;
    return workspace._app_timer_state();
end;
$$;

-- Poke the service once now, for the Timer screen's test button. Returns the
-- pg_net request id (null when the timer is not set up).
create or replace function workspace.app_timer_test(p_email text)
returns bigint
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._admin_require(p_email);
    return workspace.curator_tick_poke('tick');
end;
$$;

-- What came back for one poke: status code and whether it timed out. Never
-- the body (an Access sign-in page or the service's answer).
create or replace function workspace.app_timer_result(p_email text, p_request bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_row jsonb;
begin
    perform workspace._admin_require(p_email);
    if to_regclass('net._http_response') is null then
        return null;
    end if;
    execute 'select jsonb_build_object(''status_code'', r.status_code, ''timed_out'', r.timed_out, '
            '''error'', left(r.error_msg, 200)) from net._http_response r where r.id = $1'
        into v_row using p_request;
    return v_row;
end;
$$;

-- ── health (administrators) ─────────────────────────────────────────────────

create or replace function workspace.app_health(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_migrations jsonb;
begin
    perform workspace._admin_require(p_email);
    if to_regclass('workspace.kbe_migrations') is not null then
        execute 'select jsonb_build_object(''count'', count(*), ''latest'', max(filename)) '
                'from workspace.kbe_migrations'
            into v_migrations;
    end if;
    return jsonb_build_object(
        'migrations', v_migrations,
        'administrators', (select count(*) from workspace.principals p
                           where p.role = 'administrator' and p.active),
        'people', (select count(*) from workspace.principals p
                   where p.active and p.email is not null),
        'topics', (select count(*) from workspace.domains),
        'templates', to_jsonb(workspace.engine_templates_get()),
        'has_model_key', workspace._curator_vault_secret('kbe_model_key') is not null,
        'has_embed_token', workspace._curator_vault_secret('kbe_embed_token') is not null,
        'timer', workspace._app_timer_state(),
        'pending_reviews', (select count(*) from workspace.curator_reviews r where r.status = 'pending'),
        'flagged', (select count(*) from workspace.source_items s
                    where s.flagged is true and s.released_at is null
                      and s.curated_at is null and s.deleted_at is null));
end;
$$;

-- ── review queue (the owner) ────────────────────────────────────────────────

drop function if exists workspace.curator_review_decide(text, uuid, boolean);
drop function if exists workspace.source_item_release(text, uuid);
drop function if exists workspace.curator_review_list(text, text);

create or replace function workspace.app_review_list(p_email text, p_status text default 'pending')
returns table (
    id         uuid,
    item_title text,
    page_key   text,
    kind       text,
    reasons    text[],
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
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    return query
    select r.id, s.title, r.page_key, r.kind, r.reasons, r.status, r.created_at
    from workspace.curator_reviews r
    join workspace.source_items s on s.id = r.item_id
    where r.owner_principal_id = v_who.id
      and (p_status is null or r.status = p_status)
    order by r.created_at desc
    limit 200;
end;
$$;

-- One review with what the diff needs: the proposal and the page as it is now.
create or replace function workspace.app_review_get(p_email text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
    v_out jsonb;
begin
    select jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'status', r.status, 'page_key', r.page_key,
        'reasons', to_jsonb(r.reasons), 'proposal', r.proposal, 'base_hash', r.base_hash,
        'created_at', r.created_at,
        'item', jsonb_build_object('title', s.title, 'source', s.source, 'received_at', s.received_at),
        'page', (select jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body,
                                           'fields', p.fields, 'content_hash', p.content_hash)
                 from workspace.pages p
                 where p.owner_principal_id = v_who.id and p.deleted_at is null
                   and (p.id = r.page_id or (r.page_id is null and p.key = r.page_key))
                 limit 1))
      into v_out
    from workspace.curator_reviews r
    join workspace.source_items s on s.id = r.item_id
    where r.id = p_id and r.owner_principal_id = v_who.id;
    return v_out;
end;
$$;

-- The owner says yes or no. True when a pending review changed.
create or replace function workspace.app_review_decide(p_email text, p_id uuid, p_approve boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    if p_approve is null then
        raise exception 'say yes or no' using errcode = '22023';
    end if;
    update workspace.curator_reviews r
       set status = case when p_approve then 'approved' else 'rejected' end,
           decided_at = now(), decided_by = v_who.id
     where r.id = p_id and r.owner_principal_id = v_who.id and r.status = 'pending';
    return found;
end;
$$;

-- ── flagged items (the owner) ───────────────────────────────────────────────

create or replace function workspace.app_flagged_list(p_email text)
returns table (
    id          uuid,
    source      text,
    title       text,
    flag_reason text,
    received_at timestamptz,
    excerpt     text
)
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
#variable_conflict use_column
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    return query
    select s.id, s.source, s.title, s.flag_reason, s.received_at, left(s.body, 1500)
    from workspace.source_items s
    where s.owner_principal_id = v_who.id and s.flagged is true
      and s.released_at is null and s.curated_at is null and s.deleted_at is null
    order by s.received_at desc
    limit 200;
end;
$$;

-- Let a flagged item through. It is still data, never instructions; the
-- curator queues every change from a released item for a yes.
create or replace function workspace.app_flagged_release(p_email text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    update workspace.source_items s
       set released_at = now(), released_by = v_who.id
     where s.id = p_id and s.owner_principal_id = v_who.id
       and s.flagged is true and s.released_at is null and s.deleted_at is null
       and s.curated_at is null;
    return found;
end;
$$;

-- Throw a flagged item away: it is closed without touching any page. The raw
-- row stays (the ledger), marked as curated with no change.
create or replace function workspace.app_flagged_discard(p_email text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    update workspace.source_items s
       set curated_at = now(), curator_outcome = 'no_change',
           curator_error = 'discarded by its owner', curator_claimed_until = null
     where s.id = p_id and s.owner_principal_id = v_who.id
       and s.flagged is true and s.released_at is null and s.deleted_at is null
       and s.curated_at is null;
    return found;
end;
$$;

-- ── pages and history (the owner) ───────────────────────────────────────────

create or replace function workspace.app_pages_list(p_email text, p_query text default null, p_limit integer default 100)
returns table (
    id         uuid,
    key        text,
    drawer     text,
    title      text,
    status     text,
    updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
#variable_conflict use_column
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
    v_q   text := nullif(lower(btrim(coalesce(p_query, ''))), '');
begin
    return query
    select p.id, p.key, p.drawer, p.title, p.status, p.updated_at
    from workspace.pages p
    where p.owner_principal_id = v_who.id and p.deleted_at is null
      and (v_q is null or strpos(lower(p.title), v_q) > 0 or strpos(p.key, v_q) > 0)
    order by p.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

create or replace function workspace.app_page_get(p_email text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
    v_out jsonb;
begin
    select jsonb_build_object(
        'id', p.id, 'key', p.key, 'drawer', p.drawer, 'template', p.template,
        'title', p.title, 'aliases', to_jsonb(p.aliases), 'description', p.description,
        'fields', p.fields, 'topics', to_jsonb(p.topics), 'status', p.status,
        'tags', to_jsonb(p.tags), 'related', to_jsonb(p.related), 'sources', p.sources,
        'generated', p.generated, 'verified', p.verified, 'body', p.body,
        'content_hash', p.content_hash, 'updated_at', p.updated_at)
      into v_out
    from workspace.pages p
    where p.id = p_id and p.owner_principal_id = v_who.id and p.deleted_at is null;
    return v_out;
end;
$$;

-- The same write core as page_save: owner is the caller, topics must be
-- held, and a change to an existing page needs its current content hash.
create or replace function workspace.app_page_save(p_email text, p_page jsonb, p_expected_hash text)
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
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    return query
    select * from workspace._page_save_as(
        v_who.id,
        coalesce(workspace._resolve_domains_for_principal(v_who), array[]::text[]),
        p_page,
        p_expected_hash);
end;
$$;

create or replace function workspace.app_page_history(p_email text, p_page_id uuid)
returns table (
    id           uuid,
    content_hash text,
    title        text,
    saved_by     text,
    saved_at     timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
#variable_conflict use_column
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    return query
    select h.id, h.content_hash, h.snapshot->>'title', coalesce(w.display_name, 'unknown'), h.saved_at
    from workspace.page_history h
    join workspace.pages p on p.id = h.page_id
    left join workspace.principals w on w.id = h.saved_by
    where h.page_id = p_page_id and p.owner_principal_id = v_who.id and p.deleted_at is null
    order by h.saved_at desc, h.id
    limit 500;
end;
$$;

create or replace function workspace.app_page_version(p_email text, p_history_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
    v_out jsonb;
begin
    select jsonb_build_object('id', h.id, 'page_id', h.page_id, 'saved_at', h.saved_at,
                              'content_hash', h.content_hash, 'snapshot', h.snapshot,
                              'current_hash', p.content_hash, 'current_body', p.body)
      into v_out
    from workspace.page_history h
    join workspace.pages p on p.id = h.page_id
    where h.id = p_history_id and p.owner_principal_id = v_who.id and p.deleted_at is null;
    return v_out;
end;
$$;

-- Put an old version back. A new version is written (history is never
-- rewritten); the page must not have changed since the person looked.
create or replace function workspace.app_page_restore(p_email text, p_history_id uuid, p_expected_hash text)
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
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_snap jsonb;
begin
    select h.snapshot || jsonb_build_object('key', p.key) into v_snap
    from workspace.page_history h
    join workspace.pages p on p.id = h.page_id
    where h.id = p_history_id and p.owner_principal_id = v_who.id and p.deleted_at is null;
    if v_snap is null then
        raise exception 'no such version of one of your pages' using errcode = '22023';
    end if;
    if p_expected_hash is null then
        raise exception 'the page''s current content hash is needed' using errcode = '22023';
    end if;
    return query
    select * from workspace._page_save_as(
        v_who.id,
        coalesce(workspace._resolve_domains_for_principal(v_who), array[]::text[]),
        v_snap,
        p_expected_hash);
end;
$$;

-- ── grants: kb_engine only ──────────────────────────────────────────────────

-- Helpers: no grant to anyone.
revoke all on function workspace._app_person(text) from public;
revoke all on function workspace._app_person(text) from anon, authenticated;
revoke all on function workspace._app_timer_state() from public;
revoke all on function workspace._app_timer_state() from anon, authenticated;

revoke all on function workspace.engine_templates_get() from public;
revoke all on function workspace.engine_templates_get() from anon, authenticated;
grant execute on function workspace.engine_templates_get() to kb_engine;
revoke all on function workspace.engine_embed_token() from public;
revoke all on function workspace.engine_embed_token() from anon, authenticated;
grant execute on function workspace.engine_embed_token() to kb_engine;
revoke all on function workspace.app_whoami(text) from public;
revoke all on function workspace.app_whoami(text) from anon, authenticated;
grant execute on function workspace.app_whoami(text) to kb_engine;
revoke all on function workspace.app_templates_set(text, text[]) from public;
revoke all on function workspace.app_templates_set(text, text[]) from anon, authenticated;
grant execute on function workspace.app_templates_set(text, text[]) to kb_engine;
revoke all on function workspace.app_topics_list(text) from public;
revoke all on function workspace.app_topics_list(text) from anon, authenticated;
grant execute on function workspace.app_topics_list(text) to kb_engine;
revoke all on function workspace.app_topic_add(text, text, text, boolean) from public;
revoke all on function workspace.app_topic_add(text, text, text, boolean) from anon, authenticated;
grant execute on function workspace.app_topic_add(text, text, text, boolean) to kb_engine;
revoke all on function workspace.app_secret_set(text, text, text) from public;
revoke all on function workspace.app_secret_set(text, text, text) from anon, authenticated;
grant execute on function workspace.app_secret_set(text, text, text) to kb_engine;
revoke all on function workspace.app_timer_get(text) from public;
revoke all on function workspace.app_timer_get(text) from anon, authenticated;
grant execute on function workspace.app_timer_get(text) to kb_engine;
revoke all on function workspace.app_timer_set(text, text, integer, boolean) from public;
revoke all on function workspace.app_timer_set(text, text, integer, boolean) from anon, authenticated;
grant execute on function workspace.app_timer_set(text, text, integer, boolean) to kb_engine;
revoke all on function workspace.app_timer_test(text) from public;
revoke all on function workspace.app_timer_test(text) from anon, authenticated;
grant execute on function workspace.app_timer_test(text) to kb_engine;
revoke all on function workspace.app_timer_result(text, bigint) from public;
revoke all on function workspace.app_timer_result(text, bigint) from anon, authenticated;
grant execute on function workspace.app_timer_result(text, bigint) to kb_engine;
revoke all on function workspace.app_health(text) from public;
revoke all on function workspace.app_health(text) from anon, authenticated;
grant execute on function workspace.app_health(text) to kb_engine;
revoke all on function workspace.app_review_list(text, text) from public;
revoke all on function workspace.app_review_list(text, text) from anon, authenticated;
grant execute on function workspace.app_review_list(text, text) to kb_engine;
revoke all on function workspace.app_review_get(text, uuid) from public;
revoke all on function workspace.app_review_get(text, uuid) from anon, authenticated;
grant execute on function workspace.app_review_get(text, uuid) to kb_engine;
revoke all on function workspace.app_review_decide(text, uuid, boolean) from public;
revoke all on function workspace.app_review_decide(text, uuid, boolean) from anon, authenticated;
grant execute on function workspace.app_review_decide(text, uuid, boolean) to kb_engine;
revoke all on function workspace.app_flagged_list(text) from public;
revoke all on function workspace.app_flagged_list(text) from anon, authenticated;
grant execute on function workspace.app_flagged_list(text) to kb_engine;
revoke all on function workspace.app_flagged_release(text, uuid) from public;
revoke all on function workspace.app_flagged_release(text, uuid) from anon, authenticated;
grant execute on function workspace.app_flagged_release(text, uuid) to kb_engine;
revoke all on function workspace.app_flagged_discard(text, uuid) from public;
revoke all on function workspace.app_flagged_discard(text, uuid) from anon, authenticated;
grant execute on function workspace.app_flagged_discard(text, uuid) to kb_engine;
revoke all on function workspace.app_pages_list(text, text, integer) from public;
revoke all on function workspace.app_pages_list(text, text, integer) from anon, authenticated;
grant execute on function workspace.app_pages_list(text, text, integer) to kb_engine;
revoke all on function workspace.app_page_get(text, uuid) from public;
revoke all on function workspace.app_page_get(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_get(text, uuid) to kb_engine;
revoke all on function workspace.app_page_save(text, jsonb, text) from public;
revoke all on function workspace.app_page_save(text, jsonb, text) from anon, authenticated;
grant execute on function workspace.app_page_save(text, jsonb, text) to kb_engine;
revoke all on function workspace.app_page_history(text, uuid) from public;
revoke all on function workspace.app_page_history(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_history(text, uuid) to kb_engine;
revoke all on function workspace.app_page_version(text, uuid) from public;
revoke all on function workspace.app_page_version(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_version(text, uuid) to kb_engine;
revoke all on function workspace.app_page_restore(text, uuid, text) from public;
revoke all on function workspace.app_page_restore(text, uuid, text) from anon, authenticated;
grant execute on function workspace.app_page_restore(text, uuid, text) to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select workspace.engine_templates_get();
-- select has_function_privilege('anon', 'workspace.app_review_decide(text, uuid, boolean)', 'execute'); -- false
--
-- ROLLBACK ----------------------------------------------------------------
-- (re-run 0053's definitions of curator_review_decide, source_item_release,
--  curator_review_list and curator_settings_get; add back curator_settings.templates)
