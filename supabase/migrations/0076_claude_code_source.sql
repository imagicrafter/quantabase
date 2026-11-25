-- 0076_claude_code_source.sql
--
-- Claude Code session notes as a source, sent by hand (the plugin's
-- kb-send-session skill). At the end of a session the owner's own Claude
-- writes a short note: labelled items (decided, fact, status, how-to, idea),
-- each with exact quotes from the session and hints about which pages it
-- concerns. The service validates the note (engine sources/session-note.ts),
-- renders it as the item's body and keeps the parsed note in metadata.note;
-- the curator reads both (engine curator/session-note.ts).
--
--   source_item_record        0063's, with 'claude-code' added to the sources
--                             it takes. It is a tag source like Drive: its one
--                             tag is the project (kind 'project'), noted
--                             switched off, so a note stays with its owner
--                             (only them) unless that project tag is turned
--                             into a topic. No account, no rules. One item per
--                             session (source id = the session id): the same
--                             note is 'unchanged', a changed note is a new
--                             version (an older version still waiting is
--                             closed as 'superseded' by the curator's claim,
--                             0057).
--   app_source_summary(email, source)
--                             the caller's own items from one source: how many
--                             (distinct source ids), how many versions, and
--                             when the last arrived. For the Subscriptions
--                             screen. Never text, never another person's.
--
-- A later Claude.ai "save this chat" source is one more name in the list
-- below and in engine RECORD_SOURCES / NOTE_SOURCES.

-- record_source_item: 0063's, plus 'claude-code' (a tag source, like Drive).
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
    v_acct      workspace.source_accounts%rowtype;
    v_cur       record;
    v_meta      jsonb;
    v_decision  jsonb;
    v_cursor    text;
    v_set_ver   integer;
begin
    if v_principal is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    if p_item is null or jsonb_typeof(p_item) <> 'object' then
        raise exception 'item must be an object' using errcode = '22023';
    end if;

    v_source := lower(btrim(coalesce(p_item->>'source', '')));
    -- Only the sources the Engine knows: mail sent under another name would
    -- skip the rules.
    if v_source not in ('gmail', 'fireflies', 'drive', 'calendar', 'claude-code') then
        raise exception 'source must be gmail, fireflies, drive, calendar or claude-code' using errcode = '22023';
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
    v_cursor := left(nullif(btrim(p_item->>'cursor'), ''), 500);
    v_granted := coalesce(workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);
    v_metadata := coalesce(nullif(p_item->'metadata', 'null'::jsonb), '{}'::jsonb)
                  - 'provider' - 'rule' - 'private' - 'source_tags';

    if v_source in ('gmail', 'fireflies') then
        if nullif(btrim(coalesce(p_item->>'account', '')), '') is null then
            raise exception 'account is required for %: pass the address of the account this item came from (update the plugin)', v_source
                using errcode = '22023';
        end if;
        if jsonb_typeof(p_item->'provider') is distinct from 'object' then
            raise exception 'provider (the item''s metadata) is required for %', v_source using errcode = '22023';
        end if;
        v_acct := workspace._src_account_for(v_principal, v_source, p_item->>'account', v_principal);
        select * into v_cur from workspace._src_current(v_acct.id);
        v_set_ver := v_cur.version;
        v_meta := workspace._src_meta(v_source, p_item->'provider');
        v_decision := workspace._source_rules_eval(
            v_source, v_cur.rules, v_meta, workspace._src_live_labels(v_acct.id), workspace._src_held(v_principal));

        if v_decision->>'decision' <> 'include' then
            -- Not kept: count it, move the cursor, store nothing.
            update workspace.source_accounts a set
                items_received = a.items_received + 1,
                items_skipped = a.items_skipped + 1,
                last_seen_id = coalesce(v_cursor, a.last_seen_id),
                last_received_at = now()
            where a.id = v_acct.id;
            return jsonb_build_object('id', null, 'version', null, 'status', 'not_included',
                                      'reason', v_decision->>'reason');
        end if;
        v_topics := workspace._src_decision_topics(v_decision);
        v_metadata := v_metadata || jsonb_build_object(
            'provider', v_meta,
            'account', v_acct.account,
            'private', coalesce((v_decision->>'private')::boolean, false),
            'rule', jsonb_build_object('id', v_decision->>'rule_id', 'version', (v_decision->>'rule_version')::int,
                                       'set_version', v_set_ver, 'name', v_decision->>'name'));
    else
        v_tag_ids := workspace._source_tags_note(v_principal, v_source, p_item->'tags');
        v_topics := array(
            select distinct t.topic
            from workspace.source_tags t
            where t.owner_principal_id = v_principal
              and t.source = v_source
              and t.tag_id = any (v_tag_ids)
              and t.enabled
              and t.topic = any (v_granted)
            order by 1);
        v_metadata := v_metadata || jsonb_build_object('source_tags', to_jsonb(v_tag_ids));
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
            title, body, topics, metadata, source_created_at,
            account_id, rule_id, rule_version, ruleset_version)
        values (
            v_principal, v_source, v_source_id, v_version, v_hash, v_title, v_body,
            v_topics, v_metadata, (p_item->>'source_created_at')::timestamptz,
            v_acct.id, (v_decision->>'rule_id')::uuid, (v_decision->>'rule_version')::int,
            v_set_ver)
        returning s.id into v_id;
    end if;

    if v_acct.id is not null then
        update workspace.source_accounts a set
            items_received = a.items_received + 1,
            items_saved = a.items_saved + case when v_status = 'unchanged' then 0 else 1 end,
            last_seen_id = coalesce(v_cursor, v_source_id),
            last_received_at = now()
        where a.id = v_acct.id;
    end if;

    insert into workspace.source_cursors as c
        (owner_principal_id, source, last_seen_id, last_received_at,
         items_received, items_saved, updated_at)
    values (v_principal, v_source, coalesce(v_cursor, v_source_id),
            now(), 1, case when v_status = 'unchanged' then 0 else 1 end, now())
    on conflict (owner_principal_id, source) do update set
        last_seen_id     = coalesce(v_cursor, c.last_seen_id),
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
    'Store one raw item handed over by the caller''s Claude, if the caller''s '
    'own rules for that account include it (gmail, fireflies); drive, calendar '
    'and claude-code items are kept and filed by their switched-on tags. The '
    'Engine sets the topic; any topic or owner passed is ignored. Items no '
    'rule includes are counted and not stored. Returns {id, version, status}.';

-- Grants are unchanged by create or replace; restated so this file says them.
revoke all on function workspace.source_item_record(text, jsonb) from public;
revoke all on function workspace.source_item_record(text, jsonb) from anon, authenticated;
grant execute on function workspace.source_item_record(text, jsonb) to kb_engine;


-- ── the caller's own items from one source (Subscriptions screen) ─────────
create or replace function workspace.app_source_summary(p_email text, p_source text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who    workspace.principals%rowtype := workspace._app_person(p_email);
    v_source text := lower(btrim(coalesce(p_source, '')));
begin
    if v_source !~ '^[a-z][a-z0-9_-]{0,31}$' then
        raise exception 'source is not a source name' using errcode = '22023';
    end if;
    return (
        select jsonb_build_object(
            'source', v_source,
            'items', count(distinct s.source_id),
            'versions', count(*),
            'last_received_at', max(s.received_at))
        from workspace.source_items s
        where s.owner_principal_id = v_who.id
          and s.source = v_source
          and s.deleted_at is null);
end;
$$;

comment on function workspace.app_source_summary(text, text) is
    'The signed-in person''s own items from one source: distinct items, '
    'versions and the last arrival. Counts only, never text.';

revoke all on function workspace.app_source_summary(text, text) from public;
revoke all on function workspace.app_source_summary(text, text) from anon, authenticated;
grant execute on function workspace.app_source_summary(text, text) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select workspace.source_item_record('<a subject>',
--   '{"source":"claude-code","source_id":"s1","body":"x"}');          -- status new
-- select has_function_privilege('anon',
--   'workspace.app_source_summary(text, text)', 'execute');            -- f


-- ROLLBACK ------------------------------------------------------------------
-- Re-run the source_item_record definition from 0063_source_rules.sql, then:
-- drop function if exists workspace.app_source_summary(text, text);
