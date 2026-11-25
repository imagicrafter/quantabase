-- 0058_knowledge_ui.sql
--
-- The Knowledge and Indexing screens (the owner, 2026-11-20), built for
-- thousands of pages: nothing here returns every page.
--
--   app_whoami (replaced)    adds is_owner, so the menu can show
--                            owner / administrator / reviewer / reader
--   page_pins                a person's pinned pages (own pages only)
--   app_page_pin             pin or unpin one of your pages
--   app_knowledge_tree       per-drawer counts (GROUP BY), 8 most recent,
--                            up to 20 pinned: the left-hand tree
--   app_drawer_pages         one drawer, server-paginated and sorted, with
--                            search (the pages' full-text index, or a title /
--                            key match) and a topic filter; returns the total
--   app_page_view            one page with created_at, reviewed and owner
--   app_page_links           related keys and backlinks among your own pages
--   app_page_mark_reviewed   reviewed = now, status = current (own pages)
--   app_indexing             status for the Indexing screen (administrators)
--   app_page_reindex         queue one page's summary and embedding again
--   app_summaries_rerun      queue every pending summary again, wake curator
--
-- Owner screens act on the caller's OWN pages, as in 0054. Every function:
-- SECURITY DEFINER, fixed search_path, kb_engine only.

-- ── who is asking (adds is_owner) ───────────────────────────────────────────

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
        'is_owner', v_who.role = 'administrator'
                    and lower(btrim(v_who.email)) is not distinct from workspace._engine_owner_email(),
        'pending_reviews', (select count(*) from workspace.curator_reviews r
                            where r.owner_principal_id = v_who.id and r.status = 'pending'),
        'flagged', (select count(*) from workspace.source_items s
                    where s.owner_principal_id = v_who.id and s.flagged is true
                      and s.released_at is null and s.curated_at is null and s.deleted_at is null),
        'pages', (select count(*) from workspace.pages p
                  where p.owner_principal_id = v_who.id and p.deleted_at is null));
end;
$$;

-- ── pins ────────────────────────────────────────────────────────────────────

create table if not exists workspace.page_pins (
    principal_id uuid        not null references workspace.principals(id) on delete cascade,
    page_id      uuid        not null references workspace.pages(id) on delete cascade,
    pinned_at    timestamptz not null default now(),
    primary key (principal_id, page_id)
);

comment on table workspace.page_pins is
    'Pages a person pinned in the Knowledge menu. Own pages only.';

alter table workspace.page_pins enable row level security;
revoke all on workspace.page_pins from public;
revoke all on workspace.page_pins from anon, authenticated;

create or replace function workspace.app_page_pin(p_email text, p_id uuid, p_pin boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    if not exists (select 1 from workspace.pages p
                   where p.id = p_id and p.owner_principal_id = v_who.id and p.deleted_at is null) then
        return false;
    end if;
    if p_pin then
        insert into workspace.page_pins (principal_id, page_id) values (v_who.id, p_id)
        on conflict do nothing;
    else
        delete from workspace.page_pins where principal_id = v_who.id and page_id = p_id;
    end if;
    return true;
end;
$$;

-- ── the tree ────────────────────────────────────────────────────────────────

create or replace function workspace.app_knowledge_tree(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    return jsonb_build_object(
        'counts', coalesce((
            select jsonb_object_agg(c.drawer, c.n)
            from (select p.drawer, count(*) as n from workspace.pages p
                  where p.owner_principal_id = v_who.id and p.deleted_at is null
                  group by p.drawer) c), '{}'::jsonb),
        'recent', coalesce((
            select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'drawer', r.drawer) order by r.updated_at desc)
            from (select p.id, p.title, p.drawer, p.updated_at from workspace.pages p
                  where p.owner_principal_id = v_who.id and p.deleted_at is null
                  order by p.updated_at desc limit 8) r), '[]'::jsonb),
        'pinned', coalesce((
            select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'drawer', r.drawer) order by r.pinned_at desc)
            from (select p.id, p.title, p.drawer, x.pinned_at
                  from workspace.page_pins x join workspace.pages p on p.id = x.page_id
                  where x.principal_id = v_who.id and p.owner_principal_id = v_who.id
                    and p.deleted_at is null
                  order by x.pinned_at desc limit 20) r), '[]'::jsonb));
end;
$$;

-- ── one drawer, a page at a time ────────────────────────────────────────────

create or replace function workspace.app_drawer_pages(
    p_email  text,
    p_drawer text,
    p_query  text    default null,
    p_topic  text    default null,
    p_sort   text    default 'updated',
    p_desc   boolean default true,
    p_offset integer default 0,
    p_limit  integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who    workspace.principals%rowtype := workspace._app_person(p_email);
    v_q      text := nullif(lower(btrim(coalesce(p_query, ''))), '');
    v_tsq    tsquery;
    v_topic  text := nullif(btrim(coalesce(p_topic, '')), '');
    v_limit  integer := greatest(1, least(coalesce(p_limit, 50), 200));
    v_offset integer := greatest(0, least(coalesce(p_offset, 0), 100000));
    v_sort   text := case when p_sort in ('title', 'key', 'updated') then p_sort else 'updated' end;
    v_total  bigint;
    v_rows   jsonb;
    v_topics jsonb;
begin
    if p_drawer is null or p_drawer !~ '^[a-z][a-z0-9-]{0,62}$' then
        raise exception 'unknown drawer' using errcode = '22023';
    end if;
    if v_q is not null then
        v_q := left(v_q, 100);
        v_tsq := websearch_to_tsquery('english', v_q);
    end if;

    with hits as (
        select p.id, p.key, p.title, p.description, p.topics, p.status, p.updated_at, p.fields,
               p.summary_queued_at
        from workspace.pages p
        where p.owner_principal_id = v_who.id and p.deleted_at is null and p.drawer = p_drawer
          and (v_topic is null or v_topic = any(p.topics))
          and (v_q is null
               or (v_tsq is not null and numnode(v_tsq) > 0 and p.tsv @@ v_tsq)
               or strpos(lower(p.title), v_q) > 0 or strpos(p.key, v_q) > 0)
    )
    select (select count(*) from hits),
           coalesce((
               select jsonb_agg(jsonb_build_object(
                   'id', h.id, 'key', h.key, 'title', h.title, 'description', h.description,
                   'topics', to_jsonb(h.topics), 'status', h.status, 'updated_at', h.updated_at,
                   'fields', h.fields,
                   'summary_pending', h.summary_queued_at is not null,
                   'stale', h.updated_at < now() - interval '90 days'))
               from (select * from hits
                     order by
                       case when v_sort = 'title' and not p_desc then lower(hits.title) end asc,
                       case when v_sort = 'title' and p_desc then lower(hits.title) end desc,
                       case when v_sort = 'key' and not p_desc then hits.key end asc,
                       case when v_sort = 'key' and p_desc then hits.key end desc,
                       case when v_sort = 'updated' and not p_desc then hits.updated_at end asc,
                       case when v_sort = 'updated' and p_desc then hits.updated_at end desc,
                       hits.id
                     offset v_offset limit v_limit) h), '[]'::jsonb)
      into v_total, v_rows
    from (select 1) one;

    select coalesce(jsonb_agg(t.topic order by t.topic), '[]'::jsonb) into v_topics
    from (select distinct unnest(p.topics) as topic from workspace.pages p
          where p.owner_principal_id = v_who.id and p.deleted_at is null and p.drawer = p_drawer) t;

    return jsonb_build_object('total', v_total, 'rows', v_rows, 'topics', v_topics,
                              'offset', v_offset, 'limit', v_limit);
end;
$$;

-- ── one page ────────────────────────────────────────────────────────────────

create or replace function workspace.app_page_view(p_email text, p_id uuid)
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
        'reviewed', p.reviewed,
        'tags', to_jsonb(p.tags), 'related', to_jsonb(p.related), 'sources', p.sources,
        'generated', p.generated, 'verified', p.verified, 'body', p.body,
        'content_hash', p.content_hash, 'created_at', p.created_at, 'updated_at', p.updated_at,
        'summary_pending', p.summary_queued_at is not null,
        'owner', v_who.email,
        'pinned', exists (select 1 from workspace.page_pins x
                          where x.principal_id = v_who.id and x.page_id = p.id))
      into v_out
    from workspace.pages p
    where p.id = p_id and p.owner_principal_id = v_who.id and p.deleted_at is null;
    return v_out;
end;
$$;

-- Pages linked from this page (its related keys and [[links]]) and pages
-- that link to it, among the caller's own pages. Keys with no page of yours
-- come back with a null id so the screen can still show them.
create or replace function workspace.app_page_links(p_email text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_page workspace.pages%rowtype;
begin
    select * into v_page from workspace.pages p
    where p.id = p_id and p.owner_principal_id = v_who.id and p.deleted_at is null;
    if v_page.id is null then
        return null;
    end if;
    return jsonb_build_object(
        'out', coalesce((
            select jsonb_agg(jsonb_build_object('key', l.target_key, 'reason', l.reason,
                                                'id', t.id, 'title', t.title, 'drawer', t.drawer)
                             order by l.target_key)
            from (select distinct on (target_key) target_key, reason
                  from workspace.page_links where page_id = v_page.id
                  order by target_key, reason) l
            left join workspace.pages t
              on t.key = l.target_key and t.owner_principal_id = v_who.id and t.deleted_at is null
        ), '[]'::jsonb),
        'in', coalesce((
            select jsonb_agg(jsonb_build_object('id', b.id, 'key', b.key, 'title', b.title, 'drawer', b.drawer)
                             order by b.title)
            from (select distinct p.id, p.key, p.title, p.drawer
                  from workspace.page_links l join workspace.pages p on p.id = l.page_id
                  where l.target_key = any(array_append(v_page.aliases, v_page.key))
                    and p.id <> v_page.id
                    and p.owner_principal_id = v_who.id and p.deleted_at is null
                  limit 100) b
        ), '[]'::jsonb));
end;
$$;

-- Mark one of your pages reviewed: reviewed = now, status = current. Not a
-- content change (no new version, hash unchanged).
create or replace function workspace.app_page_mark_reviewed(p_email text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    update workspace.pages set reviewed = now(), status = 'current'
    where id = p_id and owner_principal_id = v_who.id and deleted_at is null;
    return found;
end;
$$;

-- ── indexing (administrators) ───────────────────────────────────────────────

create or replace function workspace.app_indexing(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_run jsonb;
begin
    perform workspace._admin_require(p_email);
    select jsonb_build_object('started_at', r.started_at, 'finished_at', r.finished_at,
                              'status', r.status, 'stats', r.stats)
      into v_run
    from workspace.curator_runs r order by r.started_at desc limit 1;
    return jsonb_build_object(
        'pages', (select count(*) from workspace.pages p where p.deleted_at is null),
        'summaries_pending', (select count(*) from workspace.pages p
                              where p.deleted_at is null and p.summary_queued_at is not null),
        'items_waiting', (select count(*) from workspace.source_items s
                          where s.deleted_at is null and s.curated_at is null
                            and (s.flagged is false or s.released_at is not null)),
        'items_flagged', (select count(*) from workspace.source_items s
                          where s.deleted_at is null and s.curated_at is null
                            and s.flagged is true and s.released_at is null),
        'items_failed', (select count(*) from workspace.source_items s
                         where s.deleted_at is null and s.curator_outcome = 'failed'),
        'last_run', v_run,
        'curator', (select jsonb_build_object('enabled', s.enabled, 'model', s.model,
                                              'last_wake_at', s.last_wake_at,
                                              'has_engine_url', s.engine_url is not null)
                    from workspace.curator_settings s where s.id),
        'has_model_key', workspace._curator_vault_secret('kbe_model_key') is not null,
        'backup', (select jsonb_build_object('enabled', b.enabled, 'last_finished_at', b.last_finished_at,
                                             'last_status', b.last_status)
                   from workspace.backup_settings b where b.id));
end;
$$;

create or replace function workspace.app_page_reindex(p_email text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._admin_require(p_email);
    update workspace.pages set summary_queued_at = now()
    where id = p_id and deleted_at is null;
    return found;
end;
$$;

create or replace function workspace.app_summaries_rerun(p_email text)
returns integer
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_n integer;
begin
    perform workspace._admin_require(p_email);
    -- Re-stamp so the oldest-first queue starts over; the wake is best effort.
    update workspace.pages set summary_queued_at = now()
    where deleted_at is null and summary_queued_at is not null;
    get diagnostics v_n = row_count;
    begin
        perform workspace.curator_wake(false);
    exception when others then
        raise warning 'curator wake skipped (%)', sqlstate;
    end;
    return v_n;
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace.app_whoami(text) from public;
revoke all on function workspace.app_whoami(text) from anon, authenticated;
grant execute on function workspace.app_whoami(text) to kb_engine;
revoke all on function workspace.app_page_pin(text, uuid, boolean) from public;
revoke all on function workspace.app_page_pin(text, uuid, boolean) from anon, authenticated;
grant execute on function workspace.app_page_pin(text, uuid, boolean) to kb_engine;
revoke all on function workspace.app_knowledge_tree(text) from public;
revoke all on function workspace.app_knowledge_tree(text) from anon, authenticated;
grant execute on function workspace.app_knowledge_tree(text) to kb_engine;
revoke all on function workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer) from public;
revoke all on function workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer) from anon, authenticated;
grant execute on function workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer) to kb_engine;
revoke all on function workspace.app_page_view(text, uuid) from public;
revoke all on function workspace.app_page_view(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_view(text, uuid) to kb_engine;
revoke all on function workspace.app_page_links(text, uuid) from public;
revoke all on function workspace.app_page_links(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_links(text, uuid) to kb_engine;
revoke all on function workspace.app_page_mark_reviewed(text, uuid) from public;
revoke all on function workspace.app_page_mark_reviewed(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_mark_reviewed(text, uuid) to kb_engine;
revoke all on function workspace.app_indexing(text) from public;
revoke all on function workspace.app_indexing(text) from anon, authenticated;
grant execute on function workspace.app_indexing(text) to kb_engine;
revoke all on function workspace.app_page_reindex(text, uuid) from public;
revoke all on function workspace.app_page_reindex(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_reindex(text, uuid) to kb_engine;
revoke all on function workspace.app_summaries_rerun(text) from public;
revoke all on function workspace.app_summaries_rerun(text) from anon, authenticated;
grant execute on function workspace.app_summaries_rerun(text) to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select workspace.app_knowledge_tree('owner@example.com');
-- select workspace.app_drawer_pages('owner@example.com', 'people');
--
-- ROLLBACK ----------------------------------------------------------------
-- drop function workspace.app_page_pin(text, uuid, boolean), workspace.app_knowledge_tree(text),
--   workspace.app_drawer_pages(text, text, text, text, text, boolean, integer, integer),
--   workspace.app_page_view(text, uuid), workspace.app_page_links(text, uuid),
--   workspace.app_indexing(text), workspace.app_page_reindex(text, uuid),
--   workspace.app_summaries_rerun(text);
-- drop table workspace.page_pins;
-- re-run 0054's app_whoami.
