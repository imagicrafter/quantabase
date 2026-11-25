-- 0060_source_tags.sql
--
-- Topics come from the tags in a person's own sources, never from a typed
-- name (decision 2026-11-21).
--
--   source_tags   every tag an ingest run has handed over with an item: a mail
--                 label, a Drive folder or description tag, a Fireflies
--                 channel. One row per (owner, source, tag id), with the name
--                 the source shows. Off by default: a tag nobody switched on
--                 gives no topic, so the item stays with its owner.
--   switching on  the tag's owner (and nobody else) turns a tag into a topic
--                 on Topics and people, "Found in your sources". The topic id
--                 is made from the tag's name; a topic with that id already
--                 there is reused (the preview says who holds it). The owner
--                 is granted the topic. Turning it off stops new items getting
--                 it; items already filed keep their topics.
--   stamping      source_item_record (replaced here) refuses `topics` and
--                 files an item under exactly the topics of its switched-on
--                 tags that the owner still holds. Nothing else decides.
--   free text     app_topic_add (0054) is no longer callable by the service.
--                 Topics declared in the config file (domains:) stay as the
--                 path for the wiki, Drive and Fireflies pullers and for
--                 migration; domains_apply (replaced here) never removes a
--                 topic a source tag uses.

create table if not exists workspace.source_tags (
    id                  uuid        primary key default gen_random_uuid(),
    owner_principal_id  uuid        not null
        references workspace.principals(id) on delete cascade,
    source              text        not null,
    tag_id              text        not null,
    kind                text        not null,
    display_name        text        not null,
    enabled             boolean     not null default false,
    topic               text
        references workspace.domains(domain) on delete restrict,
    seen_count          bigint      not null default 0,
    first_seen_at       timestamptz not null default now(),
    last_seen_at        timestamptz not null default now(),
    changed_at          timestamptz,
    constraint source_tags_source_shape check (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
    constraint source_tags_kind_shape check (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
    constraint source_tags_tag_id_len check (length(tag_id) between 1 and 300),
    constraint source_tags_name_len check (length(display_name) between 1 and 200),
    constraint source_tags_on_has_topic check (not enabled or topic is not null),
    constraint source_tags_uniq unique (owner_principal_id, source, tag_id)
);

comment on table workspace.source_tags is
    'Tags found in a person''s sources (labels, folders, channels) and the '
    'topic each one files items under once its owner switches it on.';

create index if not exists source_tags_topic on workspace.source_tags (topic) where topic is not null;

alter table workspace.source_tags enable row level security;
revoke all on workspace.source_tags from public;
revoke all on workspace.source_tags from anon, authenticated;


-- A topic id from a tag's name: lower case, runs of anything else become one
-- dash, at most 40 characters, starting with a letter. A name with no usable
-- letters gets "tag-" and a short hash of the tag id.
create or replace function workspace._topic_slug(p_name text, p_tag_id text)
returns text
language plpgsql
immutable
set search_path = workspace, pg_temp
as $$
declare
    v text := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-');
begin
    if v = '' then
        return 'tag-' || left(md5(coalesce(p_tag_id, '')), 8);
    end if;
    if v !~ '^[a-z]' then
        v := 't-' || v;
    end if;
    if v = 'unclassified' then
        v := 'unclassified-tag';
    end if;
    return btrim(left(v, 40), '-');
end;
$$;


-- Note the tags handed over with one item; returns their ids. Not callable by
-- the service: only source_item_record uses it.
create or replace function workspace._source_tags_note(
    p_owner  uuid,
    p_source text,
    p_tags   jsonb
)
returns text[]
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_tag  jsonb;
    v_id   text;
    v_name text;
    v_kind text;
    v_ids  text[] := array[]::text[];
begin
    if p_tags is null or p_tags = 'null'::jsonb then
        return v_ids;
    end if;
    if jsonb_typeof(p_tags) <> 'array' or jsonb_array_length(p_tags) > 50 then
        raise exception 'tags must be a list of at most 50 tags' using errcode = '22023';
    end if;
    for v_tag in select * from jsonb_array_elements(p_tags) loop
        if jsonb_typeof(v_tag) <> 'object' then
            raise exception 'each tag is an object with id, name and kind' using errcode = '22023';
        end if;
        v_id := btrim(coalesce(v_tag->>'id', ''));
        v_name := btrim(coalesce(v_tag->>'name', ''));
        v_kind := lower(btrim(coalesce(v_tag->>'kind', '')));
        if length(v_id) not between 1 and 300 or length(v_name) not between 1 and 200
           or v_kind !~ '^[a-z][a-z0-9_]{0,31}$' then
            raise exception 'each tag needs an id (1 to 300), a name (1 to 200) and a kind' using errcode = '22023';
        end if;
        if v_id = any (v_ids) then
            continue;
        end if;
        v_ids := v_ids || v_id;
        insert into workspace.source_tags as t
            (owner_principal_id, source, tag_id, kind, display_name, seen_count)
        values (p_owner, p_source, v_id, v_kind, v_name, 1)
        on conflict (owner_principal_id, source, tag_id) do update set
            display_name = excluded.display_name,
            kind         = excluded.kind,
            seen_count   = t.seen_count + 1,
            last_seen_at = now();
    end loop;
    return v_ids;
end;
$$;


-- record_source_item, now with tags. Same as 0052 except: `topics` is refused,
-- `tags` are noted, and the item's topics are those of its switched-on tags
-- (that the owner still holds). The tag ids are kept in metadata.source_tags.
create or replace function workspace.source_item_record(
    p_oauth_subject text,
    p_item          jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_granted   text[];
    v_source    text;
    v_source_id text;
    v_body      text;
    v_title     text;
    v_tag_ids   text[];
    v_topics    text[];
    v_metadata  jsonb;
    v_hash      text;
    v_found     workspace.source_items%rowtype;
    v_version   integer;
    v_id        uuid;
    v_status    text;
begin
    if v_principal is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    if p_item is null or jsonb_typeof(p_item) <> 'object' then
        raise exception 'item must be an object' using errcode = '22023';
    end if;
    if p_item ? 'topics' then
        raise exception 'topics are not passed: an item gets a topic only from a source tag its owner switched on'
            using errcode = '22023';
    end if;

    v_source := lower(btrim(coalesce(p_item->>'source', '')));
    if v_source !~ '^[a-z][a-z0-9_-]{0,31}$' then
        raise exception 'source must be a short name such as gmail' using errcode = '22023';
    end if;
    v_source_id := btrim(coalesce(p_item->>'source_id', ''));
    if length(v_source_id) not between 1 and 500 then
        raise exception 'source_id must be 1 to 500 characters' using errcode = '22023';
    end if;
    v_body := coalesce(p_item->>'body', '');
    if length(v_body) > 500000 then
        raise exception 'body is too long (500000)' using errcode = '22023';
    end if;
    v_title := left(nullif(btrim(coalesce(p_item->>'title', '')), ''), 500);
    if coalesce(jsonb_typeof(p_item->'metadata'), 'object') not in ('object', 'null') then
        raise exception 'metadata must be an object' using errcode = '22023';
    end if;

    v_tag_ids := workspace._source_tags_note(v_principal, v_source, p_item->'tags');
    v_granted := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);
    v_topics := array(
        select distinct t.topic
        from workspace.source_tags t
        where t.owner_principal_id = v_principal
          and t.source = v_source
          and t.tag_id = any (v_tag_ids)
          and t.enabled
          and t.topic = any (v_granted)
        order by 1);
    v_metadata := coalesce(nullif(p_item->'metadata', 'null'::jsonb), '{}'::jsonb)
                  || jsonb_build_object('source_tags', to_jsonb(v_tag_ids));

    v_hash := encode(sha256(convert_to(v_body, 'UTF8')), 'hex');

    -- Serialise writers on the same item.
    perform pg_advisory_xact_lock(hashtext(v_principal::text || '|' || v_source || '|' || v_source_id));

    select * into v_found
    from workspace.source_items s
    where s.owner_principal_id = v_principal and s.source = v_source
      and s.source_id = v_source_id and s.content_hash = v_hash;

    if found then
        v_id := v_found.id;
        v_version := v_found.version;
        v_status := 'unchanged';
    else
        select coalesce(max(s.version), 0) + 1 into v_version
        from workspace.source_items s
        where s.owner_principal_id = v_principal and s.source = v_source
          and s.source_id = v_source_id;
        v_status := case when v_version = 1 then 'new' else 'new_version' end;

        insert into workspace.source_items as s (
            owner_principal_id, source, source_id, version, content_hash,
            title, body, topics, metadata, source_created_at)
        values (
            v_principal, v_source, v_source_id, v_version, v_hash, v_title, v_body,
            v_topics, v_metadata, (p_item->>'source_created_at')::timestamptz)
        returning s.id into v_id;
    end if;

    insert into workspace.source_cursors as c
        (owner_principal_id, source, last_seen_id, last_received_at,
         items_received, items_saved, updated_at)
    values (v_principal, v_source,
            left(coalesce(nullif(btrim(p_item->>'cursor'), ''), v_source_id), 500),
            now(), 1, case when v_status = 'unchanged' then 0 else 1 end, now())
    on conflict (owner_principal_id, source) do update set
        last_seen_id     = coalesce(left(nullif(btrim(p_item->>'cursor'), ''), 500),
                                    c.last_seen_id),
        last_received_at = now(),
        items_received   = c.items_received + 1,
        items_saved      = c.items_saved + case when v_status = 'unchanged' then 0 else 1 end,
        updated_at       = now();

    return jsonb_build_object('id', v_id, 'version', v_version, 'status', v_status);
exception
    when invalid_datetime_format or datetime_field_overflow then
        raise exception 'source_created_at must be a date and time' using errcode = '22023';
end;
$$;

comment on function workspace.source_item_record(text, jsonb) is
    'Store one raw item handed over by the caller''s Claude, versioned by '
    'source id and content hash. Always untrusted. Notes its tags; its topics '
    'come only from tags the caller switched on. Returns {id, version, status}.';


-- The caller's own tags, newest first.
create or replace function workspace.app_source_tags_list(p_email text)
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
            'id', t.id, 'source', t.source, 'kind', t.kind, 'tag_id', t.tag_id,
            'name', t.display_name, 'enabled', t.enabled, 'topic', t.topic,
            'seen', t.seen_count, 'last_seen_at', t.last_seen_at)
            order by t.enabled desc, t.last_seen_at desc, t.display_name)
        from workspace.source_tags t
        where t.owner_principal_id = v_who.id), '[]'::jsonb);
end;
$$;


-- Switch one of the caller's own tags on or off. p_confirm false previews:
-- the topic it would use, whether that topic exists, and how many people
-- hold it. Nothing changes until p_confirm is true.
create or replace function workspace.app_source_tag_set(
    p_email   text,
    p_id      uuid,
    p_enabled boolean,
    p_confirm boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who    workspace.principals%rowtype := workspace._app_person(p_email);
    v_tag    workspace.source_tags%rowtype;
    v_topic  text;
    v_exists boolean;
    v_people bigint;
begin
    select * into v_tag from workspace.source_tags t where t.id = p_id for update;
    if not found or v_tag.owner_principal_id <> v_who.id then
        raise exception 'that tag is not one of yours' using errcode = '42501';
    end if;

    v_topic := coalesce(v_tag.topic, workspace._topic_slug(v_tag.display_name, v_tag.tag_id));
    v_exists := exists (select 1 from workspace.domains d where d.domain = v_topic);
    v_people := (select count(*) from workspace.access_grants g where g.domain = v_topic);

    if not coalesce(p_confirm, false) then
        return jsonb_build_object(
            'status', 'preview', 'enabled', coalesce(p_enabled, false), 'topic', v_topic,
            'topic_exists', v_exists, 'people', v_people,
            'source', v_tag.source, 'name', v_tag.display_name);
    end if;

    if coalesce(p_enabled, false) then
        insert into workspace.domains (domain, label, sensitive)
        values (v_topic, v_tag.display_name, false)
        on conflict (domain) do nothing;
        insert into workspace.access_grants (principal_id, domain, granted_by)
        values (v_who.id, v_topic, 'source_tag')
        on conflict (principal_id, domain) do nothing;
        update workspace.source_tags
        set enabled = true, topic = v_topic, changed_at = now()
        where id = v_tag.id;
        return jsonb_build_object('status', 'on', 'topic', v_topic, 'topic_exists', v_exists);
    end if;

    update workspace.source_tags set enabled = false, changed_at = now() where id = v_tag.id;
    return jsonb_build_object('status', 'off', 'topic', v_tag.topic);
end;
$$;


-- domains_apply as in 0030, except that a topic a source tag uses is never
-- removed by a config: it was made from the source, not from the file.
create or replace function workspace.domains_apply(p_domains jsonb)
returns integer
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_item     jsonb;
    v_id       text;
    v_locked   boolean;
    v_ids      text[] := array[]::text[];
    v_stale    text;
    v_owner_id uuid;
begin
    if p_domains is null or jsonb_typeof(p_domains) <> 'array' then
        raise exception 'domains must be a list' using errcode = '22023';
    end if;

    for v_item in select * from jsonb_array_elements(p_domains) loop
        v_id := v_item->>'id';
        if v_id is null or v_id !~ '^[a-z][a-z0-9-]*$' then
            raise exception 'topic id % is not valid', coalesce(v_id, '(missing)')
                using errcode = '22023';
        end if;
        if v_id = 'unclassified' then
            raise exception '"unclassified" is reserved and may not be declared'
                using errcode = '22023';
        end if;
        if v_id = any (v_ids) then
            raise exception 'topic % is declared twice', v_id using errcode = '22023';
        end if;
        if coalesce(btrim(v_item->>'label'), '') = '' then
            raise exception 'topic % needs a label', v_id using errcode = '22023';
        end if;
        v_ids := v_ids || v_id;
        v_locked := coalesce((v_item->>'sensitive')::boolean, false);

        if not v_locked and exists (
            select 1 from workspace.domains d where d.domain = v_id and d.sensitive
        ) then
            raise exception
                'topic % is sensitive; a config cannot unlock it. '
                'Keep "sensitive: true", or have an administrator unlock it', v_id
                using errcode = '42501';
        end if;

        insert into workspace.domains (domain, label, sensitive)
        values (v_id, v_item->>'label', v_locked)
        on conflict (domain) do update
            set label = excluded.label,
                sensitive = excluded.sensitive;
    end loop;

    -- Refuse to drop a topic that is still in use; never drop one a source
    -- tag uses.
    for v_stale in
        select d.domain from workspace.domains d
        where d.domain <> 'unclassified' and d.domain <> all (v_ids)
          and not exists (select 1 from workspace.source_tags t where t.topic = d.domain)
        order by d.domain
    loop
        if exists (select 1 from workspace.documents doc where v_stale = any (doc.domains)) then
            raise exception 'topic % still has documents; retag them before removing it', v_stale
                using errcode = '23503';
        end if;
        if exists (select 1 from workspace.access_grants g where g.domain = v_stale) then
            raise exception 'topic % is still granted to someone; remove the grants first', v_stale
                using errcode = '23503';
        end if;
        delete from workspace.domains where domain = v_stale;
    end loop;

    insert into workspace.domains (domain, label, description, sensitive)
    values ('unclassified', 'Unclassified',
            'Items with no topic tag. Only the owner can see them.', true)
    on conflict (domain) do update set sensitive = true;

    select p.id into v_owner_id
    from workspace.principals p
    join workspace.engine_settings s on s.id
    where lower(btrim(p.email)) = lower(btrim(s.config #>> '{engine,owner,email}'));

    delete from workspace.access_grants g
    where g.domain = 'unclassified'
      and g.principal_id is distinct from v_owner_id;

    if v_owner_id is not null then
        insert into workspace.access_grants (principal_id, domain, granted_by)
        values (v_owner_id, 'unclassified', 'engine_config')
        on conflict (principal_id, domain) do nothing;
    end if;

    return coalesce(array_length(v_ids, 1), 0);
end;
$$;


revoke all on function workspace._topic_slug(text, text) from public;
revoke all on function workspace._source_tags_note(uuid, text, jsonb) from public;
revoke all on function workspace.source_item_record(text, jsonb) from public;
revoke all on function workspace.source_item_record(text, jsonb) from anon, authenticated;
grant execute on function workspace.source_item_record(text, jsonb) to kb_engine;
revoke all on function workspace.app_source_tags_list(text) from public;
revoke all on function workspace.app_source_tags_list(text) from anon, authenticated;
grant execute on function workspace.app_source_tags_list(text) to kb_engine;
revoke all on function workspace.app_source_tag_set(text, uuid, boolean, boolean) from public;
revoke all on function workspace.app_source_tag_set(text, uuid, boolean, boolean) from anon, authenticated;
grant execute on function workspace.app_source_tag_set(text, uuid, boolean, boolean) to kb_engine;
revoke all on function workspace.domains_apply(jsonb) from public;
grant execute on function workspace.domains_apply(jsonb) to service_role;
revoke execute on function workspace.app_topic_add(text, text, text, boolean) from kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('kb_engine',
--   'workspace.app_topic_add(text, text, text, boolean)', 'execute');   -- f
-- select count(*) from workspace.source_tags where enabled;


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply 0030 (domains_apply) and 0052 (source_item_record), then:
-- grant execute on function workspace.app_topic_add(text, text, text, boolean) to kb_engine;
-- drop function if exists workspace.app_source_tag_set(text, uuid, boolean, boolean);
-- drop function if exists workspace.app_source_tags_list(text);
-- drop function if exists workspace._source_tags_note(uuid, text, jsonb);
-- drop function if exists workspace._topic_slug(text, text);
-- drop table if exists workspace.source_tags;
