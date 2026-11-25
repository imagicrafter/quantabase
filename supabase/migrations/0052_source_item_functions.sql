-- 0052_source_item_functions.sql
--
-- record_source_item and the owner's read of one raw item.
--
-- source_item_record(subject, item)
--   The owner is the signed-in caller. Topics must be ones the caller holds
--   (an item with no topic is the caller's alone). The content hash is taken
--   over the body (the text a reply or an edit changes):
--     same source id, same hash      -> 'unchanged', nothing written
--     same source id, new hash       -> 'new_version', version + 1
--     new source id                  -> 'new', version 1
--   kind and untrusted are fixed ('source_data', true): nothing the caller
--   sends can mark source text as trusted. The caller's cursor for that
--   source moves to `cursor` (or the source id) and its counts go up.
--
-- source_item_get(subject, id)
--   The owner only, in this step: the curator (Step C) works on its owner's
--   items. The service hands the body back only inside
--   `untrusted_source_text` with a fixed notice.

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
    v_topics    text[];
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

    v_topics := array(select distinct lower(t)
                      from unnest(workspace._jsonb_text_array(p_item->'topics', 'topics')) t
                      order by 1);
    v_granted := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);
    if not (v_topics <@ v_granted) then
        raise exception 'an item can only be filed under topics you hold' using errcode = '22023';
    end if;

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
            v_topics, coalesce(nullif(p_item->'metadata', 'null'::jsonb), '{}'::jsonb),
            (p_item->>'source_created_at')::timestamptz)
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
    'source id and content hash. Always untrusted. Returns {id, version, status}.';


create or replace function workspace.source_item_get(
    p_oauth_subject text,
    p_id            uuid
)
returns table (
    id                uuid,
    source            text,
    source_id         text,
    version           integer,
    kind              text,
    untrusted         boolean,
    flagged           boolean,
    title             text,
    body              text,
    topics            text[],
    metadata          jsonb,
    source_created_at timestamptz,
    received_at       timestamptz,
    curated_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
begin
    if v_principal is null then
        return;
    end if;
    return query
    select s.id, s.source, s.source_id, s.version, s.kind, s.untrusted, s.flagged,
           s.title, s.body, s.topics, s.metadata, s.source_created_at,
           s.received_at, s.curated_at
    from workspace.source_items s
    where s.id = p_id
      and s.owner_principal_id = v_principal
      and s.deleted_at is null;
end;
$$;

comment on function workspace.source_item_get(text, uuid) is
    'One raw item, to its owner only. The service returns the body inside '
    'untrusted_source_text.';

revoke all on function workspace.source_item_record(text, jsonb) from public;
revoke all on function workspace.source_item_record(text, jsonb) from anon, authenticated;
grant execute on function workspace.source_item_record(text, jsonb) to kb_engine;
revoke all on function workspace.source_item_get(text, uuid) from public;
revoke all on function workspace.source_item_get(text, uuid) from anon, authenticated;
grant execute on function workspace.source_item_get(text, uuid) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('anon',
--   'workspace.source_item_record(text, jsonb)', 'execute');   -- f


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.source_item_get(text, uuid);
-- drop function if exists workspace.source_item_record(text, jsonb);
