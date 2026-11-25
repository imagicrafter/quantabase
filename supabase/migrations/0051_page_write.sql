-- 0051_page_write.sql
--
-- page_save: the one way a page is created or changed.
--
-- WHO MAY WRITE
--   The owner is always the signed-in caller (resolved from the verified
--   OAuth subject the service passes). There is no owner argument, so no
--   caller can write another person's page, and an administrator is no
--   exception. Every topic named on the page must be one the caller holds.
--
-- NO SILENT OVERWRITE
--   A save on a key the caller already has a page for must carry that page's
--   content_hash as p_expected_hash (from find_entity). A missing or stale
--   hash is refused, so two writers cannot clobber each other.
--
-- ON A SAVE THAT CHANGES THE CONTENT HASH
--   * the row is written and updated_at bumped (a review is undone on its own)
--   * summary_queued_at is set: the curator (Step C) writes the summary and
--     embedding later; the old summary stays until then
--   * one history row is written with the full new version
--   * the page's links are rewritten, and links that named this page by its
--     title or an alias are pointed at its key
-- A save that changes nothing writes nothing and reports changed = false.

-- ── helpers (no grants) ──────────────────────────────────────────────────────

-- A JSON array of strings as text[]; null means empty. Anything else refused.
create or replace function workspace._jsonb_text_array(p_value jsonb, p_name text)
returns text[]
language plpgsql
immutable
set search_path = workspace, pg_temp
as $$
begin
    if p_value is null or jsonb_typeof(p_value) = 'null' then
        return array[]::text[];
    end if;
    if jsonb_typeof(p_value) <> 'array'
       or exists (select 1 from jsonb_array_elements(p_value) e
                  where jsonb_typeof(e) <> 'string') then
        raise exception '% must be a list of text', p_name using errcode = '22023';
    end if;
    return array(select btrim(e) from jsonb_array_elements_text(p_value) e
                 where length(btrim(e)) > 0);
end;
$$;

-- The key a link text points at: a page whose key, title or alias matches it
-- (the writer's own pages first), else the text itself, lower case.
create or replace function workspace._link_target_key(p_text text, p_owner uuid)
returns text
language sql
stable
set search_path = workspace, pg_temp
as $$
    with t as (
        select left(lower(btrim(
            regexp_replace(regexp_replace(p_text, '^\[\[|\]\]$', '', 'g'), '[|#].*$', '')
        )), 200) as v
    )
    select coalesce(
        (select p.key
         from workspace.pages p, t
         where p.deleted_at is null
           and (p.key = t.v or lower(p.title) = t.v
                or exists (select 1 from unnest(p.aliases) a where lower(a) = t.v))
         order by (p.owner_principal_id = p_owner) desc, (p.key = t.v) desc
         limit 1),
        (select nullif(t.v, '') from t));
$$;

create or replace function workspace._page_links_rewrite(p_page_id uuid)
returns void
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_page  workspace.pages%rowtype;
    v_names text[];
begin
    select * into v_page from workspace.pages where id = p_page_id;

    delete from workspace.page_links where page_id = p_page_id;

    insert into workspace.page_links (page_id, target_key, reason)
    select distinct p_page_id, k.target, k.reason
    from (
        select workspace._link_target_key(r, v_page.owner_principal_id) as target,
               'related'::text as reason
        from unnest(v_page.related) r
        union all
        select workspace._link_target_key(m[1], v_page.owner_principal_id), 'wikilink'
        from regexp_matches(v_page.body, '\[\[([^\]|#]+)[^\]]*\]\]', 'g') m
        union all
        select left(lower(btrim(t)), 200), 'tag'
        from unnest(v_page.tags) t
    ) k
    where k.target is not null
      and length(k.target) > 0
      and k.target <> v_page.key
    on conflict do nothing;

    -- Links written before this page existed may name it by title or alias.
    v_names := array(
        select distinct lower(btrim(n))
        from unnest(array_append(v_page.aliases, v_page.title)) n
        where length(btrim(n)) > 0 and lower(btrim(n)) <> v_page.key);
    if cardinality(v_names) > 0 then
        insert into workspace.page_links (page_id, target_key, reason)
        select l.page_id, v_page.key, l.reason
        from workspace.page_links l
        where l.target_key = any(v_names) and l.reason in ('related', 'wikilink')
        on conflict do nothing;
        delete from workspace.page_links l
        where l.target_key = any(v_names) and l.reason in ('related', 'wikilink');
    end if;
end;
$$;

revoke all on function workspace._jsonb_text_array(jsonb, text) from public;
revoke all on function workspace._jsonb_text_array(jsonb, text) from anon, authenticated;
revoke all on function workspace._link_target_key(text, uuid) from public;
revoke all on function workspace._link_target_key(text, uuid) from anon, authenticated;
revoke all on function workspace._page_links_rewrite(uuid) from public;
revoke all on function workspace._page_links_rewrite(uuid) from anon, authenticated;


-- ── page_save ────────────────────────────────────────────────────────────────

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
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_granted   text[];
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
    if v_principal is null then
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
    v_granted := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);
    if not (v_topics <@ v_granted) then
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
    where p.owner_principal_id = v_principal and p.key = v_key and p.deleted_at is null
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
            v_principal, v_drawer, v_key, v_content->>'template', v_title,
            workspace._jsonb_text_array(v_content->'aliases', 'aliases'),
            v_content->>'description', v_content->'fields', v_topics, v_status,
            workspace._jsonb_text_array(v_content->'tags', 'tags'),
            workspace._jsonb_text_array(v_content->'related', 'related'),
            v_content->'sources', v_content->'generated', v_content->'verified',
            v_content->>'body', v_hash, v_now, v_now, v_now)
        returning p.id into v_id;
    end if;

    insert into workspace.page_history (page_id, content_hash, snapshot, saved_by, saved_at)
    values (v_id, v_hash, v_content || jsonb_build_object('key', v_key), v_principal, v_now);

    perform workspace._page_links_rewrite(v_id);

    return query select v_id, v_key, v_hash, v_existing.id is null, true, v_now;
end;
$$;

comment on function workspace.page_save(text, jsonb, text) is
    'Create or change the caller''s own page on a key. The owner is the caller. '
    'An existing page needs its content_hash as p_expected_hash. A change '
    'writes history, rewrites links and queues the summary.';

revoke all on function workspace.page_save(text, jsonb, text) from public;
revoke all on function workspace.page_save(text, jsonb, text) from anon, authenticated;
grant execute on function workspace.page_save(text, jsonb, text) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('kb_engine',
--   'workspace.page_save(text, jsonb, text)', 'execute');   -- t
-- select has_function_privilege('anon',
--   'workspace.page_save(text, jsonb, text)', 'execute');   -- f


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.page_save(text, jsonb, text);
-- drop function if exists workspace._page_links_rewrite(uuid);
-- drop function if exists workspace._link_target_key(text, uuid);
-- drop function if exists workspace._jsonb_text_array(jsonb, text);
