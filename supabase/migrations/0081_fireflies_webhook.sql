-- 0081_fireflies_webhook.sql
--
-- Fireflies meetings by webhook (docs/source-rules.md, "Fireflies by
-- webhook"). Until now a scheduled Claude task read each transcript through
-- the Fireflies connector and typed it into record_source_item. Now the
-- person pastes their Fireflies API key once on the Sources screen; the
-- Engine gives them a webhook address and a signing secret to paste into
-- Fireflies; each finished meeting is posted to the Engine, which fetches it
-- (one GraphQL call) and stores it through the SAME path record_source_item
-- uses, so the person's own inclusion rules decide keep or leave out.
--
--   _source_item_record_for   0076's source_item_record body, taking the
--                             owner's principal id instead of an OAuth
--                             subject (a webhook has no sign-in). Unchanged
--                             logic: rules for gmail/fireflies, tags for the
--                             rest, versions by text hash.
--   source_item_record        now a thin wrapper: subject -> principal, then
--                             _source_item_record_for. Same answers as 0076.
--   fireflies_hooks           one row per connected Fireflies source account:
--                             the webhook id (in the URL), the Fireflies
--                             address the key belongs to, the key's last 4
--                             characters, and when a delivery last arrived.
--                             The API key and the signing secret are in
--                             Supabase Vault (kbe_ff_key_<account id>,
--                             kbe_ff_sig_<account id>), never in this table.
--   fireflies_deliveries      one row per account and meeting: pending, done,
--                             failed (with a short reason code) or not_found.
--                             Never transcript text. Failed and stale pending
--                             rows are the "meetings missed" on the screen.
--   app_fireflies_*           the owner's screen: connect, read, missed ids,
--                             disconnect. The caller's OWN account only.
--   fireflies_hook_*          the service's webhook path (kb_engine only):
--                             look a webhook up, note a delivery, begin and
--                             end a fetch, read the key, record an item.
--   source_webhook_connected  for get_ingest_plan: true when the caller's
--                             Fireflies account is fed by the webhook, so the
--                             scheduled ingest skips it.

-- ── tables ──────────────────────────────────────────────────────────────────

create table if not exists workspace.fireflies_hooks (
    account_id        uuid        primary key
        references workspace.source_accounts(id) on delete cascade,
    hook_id           text        not null unique,
    fireflies_email   text        not null,
    key_last4         text        not null,
    connected_at      timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    first_delivery_at timestamptz,
    last_delivery_at  timestamptz,
    last_event        text,
    constraint fireflies_hooks_hook_id check (hook_id ~ '^[A-Za-z0-9_-]{32,64}$'),
    constraint fireflies_hooks_email
        check (fireflies_email = lower(fireflies_email) and length(fireflies_email) between 3 and 254
               and fireflies_email !~ '[[:space:]]'),
    constraint fireflies_hooks_last4 check (key_last4 ~ '^[[:graph:]]{4}$'),
    constraint fireflies_hooks_event check (last_event is null or last_event ~ '^[A-Za-z0-9 ._-]{1,64}$')
);

comment on table workspace.fireflies_hooks is
    'One row per Fireflies source account fed by webhook: the webhook id in its '
    'URL, the Fireflies address, the API key''s last 4 characters, and delivery '
    'times. The key and the signing secret are in Supabase Vault, never here.';

alter table workspace.fireflies_hooks enable row level security;
revoke all on workspace.fireflies_hooks from public;
revoke all on workspace.fireflies_hooks from anon, authenticated;

create table if not exists workspace.fireflies_deliveries (
    account_id     uuid        not null
        references workspace.fireflies_hooks(account_id) on delete cascade,
    meeting_id     text        not null,
    status         text        not null default 'pending',
    events         text[]      not null default array[]::text[],
    reprocessed_at bigint,
    reason         text,
    attempts       integer     not null default 0,
    parts          integer,
    received_at    timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    primary key (account_id, meeting_id),
    constraint fireflies_deliveries_meeting check (meeting_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    constraint fireflies_deliveries_status check (status in ('pending', 'done', 'failed', 'not_found')),
    constraint fireflies_deliveries_reason check (reason is null or reason ~ '^[a-z_]{1,40}$'),
    constraint fireflies_deliveries_parts check (parts is null or parts between 1 and 100)
);

comment on table workspace.fireflies_deliveries is
    'One row per Fireflies account and meeting the webhook (or a backfill or '
    'retry) asked for: pending, done, failed (short reason code) or not_found. '
    'Never transcript text. Failed and stale pending rows are the missed meetings.';

create index if not exists fireflies_deliveries_missed
    on workspace.fireflies_deliveries (account_id) where status in ('failed', 'pending');

alter table workspace.fireflies_deliveries enable row level security;
revoke all on workspace.fireflies_deliveries from public;
revoke all on workspace.fireflies_deliveries from anon, authenticated;

-- Connecting and disconnecting the webhook is in the account's audit.
alter table workspace.source_rule_audit drop constraint if exists source_rule_audit_action;
alter table workspace.source_rule_audit add constraint source_rule_audit_action check (action in (
    'account_added', 'rules_saved', 'rules_migrated', 'backfill', 'backfill_served', 'recheck',
    'sample_requested', 'labels_deleted', 'contacts_reported', 'webhook'));


-- ── the record path, by principal ───────────────────────────────────────────

-- 0076's source_item_record, with the owner given as a principal id. Every
-- line of the decision is the same; only who-is-calling moved to the wrapper.
create or replace function workspace._source_item_record_for(
    p_principal uuid,
    p_item      jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_who       workspace.principals%rowtype;
    v_principal uuid;
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
    select * into v_who from workspace.principals p where p.id = p_principal and p.active is true;
    if not found then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    v_principal := v_who.id;
    if p_item is null or jsonb_typeof(p_item) <> 'object' then
        raise exception 'item must be an object' using errcode = '22023';
    end if;

    v_source := lower(btrim(coalesce(p_item->>'source', '')));
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
    v_granted := coalesce(workspace._resolve_domains_for_principal(v_who), array[]::text[]);
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

comment on function workspace._source_item_record_for(uuid, jsonb) is
    'source_item_record''s body for a known owner (principal id): the caller''s '
    'own rules (gmail, fireflies) or switched-on tags decide; versions by text '
    'hash. Internal: reached through source_item_record and fireflies_hook_record.';

revoke all on function workspace._source_item_record_for(uuid, jsonb) from public;
revoke all on function workspace._source_item_record_for(uuid, jsonb) from anon, authenticated;

-- record_source_item: the signed-in subject, then the shared body above.
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
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
begin
    if v_principal is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    return workspace._source_item_record_for(v_principal, p_item);
end;
$$;

comment on function workspace.source_item_record(text, jsonb) is
    'Store one raw item handed over by the caller''s Claude, if the caller''s '
    'own rules for that account include it (gmail, fireflies); drive, calendar '
    'and claude-code items are kept and filed by their switched-on tags. The '
    'Engine sets the topic; any topic or owner passed is ignored. Items no '
    'rule includes are counted and not stored. Returns {id, version, status}.';

revoke all on function workspace.source_item_record(text, jsonb) from public;
revoke all on function workspace.source_item_record(text, jsonb) from anon, authenticated;
grant execute on function workspace.source_item_record(text, jsonb) to kb_engine;


-- ── vault helpers ───────────────────────────────────────────────────────────

create or replace function workspace._ff_vault_put(p_name text, p_value text)
returns void
language plpgsql
volatile
set search_path = workspace, pg_temp
as $$
declare
    v_id uuid;
begin
    if to_regclass('vault.secrets') is null then
        raise exception 'Supabase Vault is not available on this database' using errcode = '55000';
    end if;
    execute 'select id from vault.secrets where name = $1 limit 1' into v_id using p_name;
    if v_id is null then
        execute 'select vault.create_secret($1, $2, $3)'
            using p_value, p_name, 'Fireflies webhook (Sources screen)';
    else
        execute 'select vault.update_secret($1, $2)' using v_id, p_value;
    end if;
end;
$$;

create or replace function workspace._ff_vault_drop(p_name text)
returns void
language plpgsql
volatile
set search_path = workspace, pg_temp
as $$
begin
    if to_regclass('vault.secrets') is not null then
        execute 'delete from vault.secrets where name = $1' using p_name;
    end if;
end;
$$;

create or replace function workspace._ff_key_name(p_account uuid)
returns text language sql immutable set search_path = workspace, pg_temp
as $$ select 'kbe_ff_key_' || p_account::text $$;

create or replace function workspace._ff_sig_name(p_account uuid)
returns text language sql immutable set search_path = workspace, pg_temp
as $$ select 'kbe_ff_sig_' || p_account::text $$;

revoke all on function workspace._ff_vault_put(text, text) from public;
revoke all on function workspace._ff_vault_put(text, text) from anon, authenticated;
revoke all on function workspace._ff_vault_drop(text) from public;
revoke all on function workspace._ff_vault_drop(text) from anon, authenticated;
revoke all on function workspace._ff_key_name(uuid) from public;
revoke all on function workspace._ff_key_name(uuid) from anon, authenticated;
revoke all on function workspace._ff_sig_name(uuid) from public;
revoke all on function workspace._ff_sig_name(uuid) from anon, authenticated;


-- ── the owner's screen ──────────────────────────────────────────────────────

-- Connect (or re-connect) the caller's own Fireflies account. The service has
-- already checked the key with Fireflies and passes the address it belongs to.
-- A new connection keeps the hook id and signing secret the service made; a
-- re-connection replaces only the key (the URL and secret Fireflies holds
-- stay valid).
create or replace function workspace.app_fireflies_connect(
    p_email           text,
    p_fireflies_email text,
    p_api_key         text,
    p_hook_id         text,
    p_secret          text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct workspace.source_accounts%rowtype;
    v_new  boolean;
begin
    if p_api_key is null or length(p_api_key) not between 10 and 4096 or p_api_key ~ '[[:space:]]' then
        raise exception 'the key must be 10 to 4096 characters with no spaces' using errcode = '22023';
    end if;
    if p_hook_id is null or p_hook_id !~ '^[A-Za-z0-9_-]{32,64}$' then
        raise exception 'bad webhook id' using errcode = '22023';
    end if;
    if p_secret is null or p_secret !~ '^[A-Za-z0-9]{32}$' then
        raise exception 'bad signing secret' using errcode = '22023';
    end if;
    if to_regclass('vault.secrets') is null then
        raise exception 'Supabase Vault is not available on this database' using errcode = '55000';
    end if;
    v_acct := workspace._src_account_for(v_who.id, 'fireflies', p_fireflies_email, v_who.id);

    v_new := not exists (select 1 from workspace.fireflies_hooks h where h.account_id = v_acct.id);
    insert into workspace.fireflies_hooks as h (account_id, hook_id, fireflies_email, key_last4)
    values (v_acct.id, p_hook_id, v_acct.account, right(p_api_key, 4))
    on conflict (account_id) do update set
        key_last4 = excluded.key_last4,
        updated_at = now();

    perform workspace._ff_vault_put(workspace._ff_key_name(v_acct.id), p_api_key);
    if v_new then
        perform workspace._ff_vault_put(workspace._ff_sig_name(v_acct.id), p_secret);
    end if;

    insert into workspace.source_rule_audit (account_id, actor, action, detail)
    values (v_acct.id, v_who.id, 'webhook',
            jsonb_build_object('change', case when v_new then 'connected' else 'key_replaced' end));
    return jsonb_build_object('account_id', v_acct.id, 'account', v_acct.account, 'new', v_new);
end;
$$;

-- The webhook state of the caller's own account. The signing secret is shown
-- to the account's owner (they paste it into Fireflies); the API key never is.
create or replace function workspace.app_fireflies_get(p_email text, p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
    v_hook workspace.fireflies_hooks%rowtype;
begin
    select * into v_hook from workspace.fireflies_hooks h where h.account_id = v_acct.id;
    if not found then
        return jsonb_build_object('connected', false, 'source', v_acct.source, 'account', v_acct.account);
    end if;
    return jsonb_build_object(
        'connected', true,
        'source', v_acct.source,
        'account', v_acct.account,
        'fireflies_email', v_hook.fireflies_email,
        'key_last4', v_hook.key_last4,
        'hook_id', v_hook.hook_id,
        'secret', workspace._curator_vault_secret(workspace._ff_sig_name(v_acct.id)),
        'connected_at', v_hook.connected_at,
        'first_delivery_at', v_hook.first_delivery_at,
        'last_delivery_at', v_hook.last_delivery_at,
        'last_event', v_hook.last_event,
        'done', (select count(*) from workspace.fireflies_deliveries d
                 where d.account_id = v_acct.id and d.status = 'done'),
        'missed', (select count(*) from workspace.fireflies_deliveries d
                   where d.account_id = v_acct.id
                     and (d.status = 'failed'
                          or (d.status = 'pending' and d.updated_at < now() - interval '15 minutes'))),
        'working', (select count(*) from workspace.fireflies_deliveries d
                    where d.account_id = v_acct.id and d.status = 'pending'
                      and d.updated_at >= now() - interval '15 minutes'),
        'last_reason', (select d.reason from workspace.fireflies_deliveries d
                        where d.account_id = v_acct.id and d.status = 'failed'
                        order by d.updated_at desc limit 1));
end;
$$;

-- The missed meetings of the caller's own account (ids only), oldest first.
create or replace function workspace.app_fireflies_missed(p_email text, p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
begin
    return coalesce((
        select jsonb_agg(m.meeting_id order by m.received_at)
        from (select d.meeting_id, d.received_at
              from workspace.fireflies_deliveries d
              where d.account_id = v_acct.id
                and (d.status = 'failed'
                     or (d.status = 'pending' and d.updated_at < now() - interval '15 minutes'))
              order by d.received_at
              limit 100) m), '[]'::jsonb);
end;
$$;

-- Disconnect: the webhook stops answering, the key and secret leave the vault.
-- The account, its rules and the items already kept stay.
create or replace function workspace.app_fireflies_disconnect(p_email text, p_account_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
begin
    delete from workspace.fireflies_hooks h where h.account_id = v_acct.id;
    if not found then
        return false;
    end if;
    perform workspace._ff_vault_drop(workspace._ff_key_name(v_acct.id));
    perform workspace._ff_vault_drop(workspace._ff_sig_name(v_acct.id));
    insert into workspace.source_rule_audit (account_id, actor, action, detail)
    values (v_acct.id, v_who.id, 'webhook', jsonb_build_object('change', 'disconnected'));
    return true;
end;
$$;


-- ── the service's webhook path (kb_engine only) ─────────────────────────────

-- The account and signing secret behind a webhook id, or null. The service
-- checks the signature itself (it needs the raw bytes) and never logs it.
create or replace function workspace.fireflies_hook_lookup(p_hook_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_hook workspace.fireflies_hooks%rowtype;
    v_secret text;
begin
    if p_hook_id is null or p_hook_id !~ '^[A-Za-z0-9_-]{32,64}$' then
        return null;
    end if;
    select * into v_hook from workspace.fireflies_hooks h where h.hook_id = p_hook_id;
    if not found then
        return null;
    end if;
    v_secret := workspace._curator_vault_secret(workspace._ff_sig_name(v_hook.account_id));
    if v_secret is null then
        return null;
    end if;
    return jsonb_build_object('account_id', v_hook.account_id, 'secret', v_secret);
end;
$$;

-- A delivery with a good signature arrived (a test, a bot join or a meeting).
create or replace function workspace.fireflies_hook_seen(p_account_id uuid, p_event text)
returns void
language sql
volatile
security definer
set search_path = workspace, pg_temp
as $$
    update workspace.fireflies_hooks h set
        first_delivery_at = coalesce(h.first_delivery_at, now()),
        last_delivery_at = now(),
        last_event = case when p_event ~ '^[A-Za-z0-9 ._-]{1,64}$' then p_event else 'unknown' end
    where h.account_id = p_account_id;
$$;

-- Begin one meeting fetch. Returns 'fetch' or 'skip'.
--   a webhook event   skip when this meeting is already done for this event
--                     and the delivery is not a newer re-send (reprocessed_at)
--   'backfill'        skip when the meeting is already done
--   'retry'           always fetch
--   any but 'retry'   skip while the same meeting is being fetched (pending
--                     for under 5 minutes)
create or replace function workspace.fireflies_delivery_begin(
    p_account_id     uuid,
    p_meeting_id     text,
    p_event          text,
    p_reprocessed_at bigint
)
returns text
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_row   workspace.fireflies_deliveries%rowtype;
    v_event text := case when p_event ~ '^[A-Za-z0-9 ._-]{1,64}$' then p_event else 'unknown' end;
begin
    if not exists (select 1 from workspace.fireflies_hooks h where h.account_id = p_account_id) then
        raise exception 'that Fireflies account is not connected' using errcode = '22023';
    end if;
    if p_meeting_id is null or p_meeting_id !~ '^[A-Za-z0-9._:-]{1,128}$' then
        raise exception 'bad meeting id' using errcode = '22023';
    end if;
    select * into v_row from workspace.fireflies_deliveries d
    where d.account_id = p_account_id and d.meeting_id = p_meeting_id
    for update;
    -- A delivery for a meeting being fetched right now (Fireflies retried a
    -- slow answer) waits for that fetch; one stuck for 5 minutes is fetched again.
    if found and v_row.status = 'pending' and v_event <> 'retry'
       and v_row.updated_at > now() - interval '5 minutes' then
        return 'skip';
    end if;
    if found and v_row.status = 'done' then
        if v_event = 'backfill' then
            return 'skip';
        end if;
        if v_event <> 'retry' and v_event = any (v_row.events)
           and (p_reprocessed_at is null or p_reprocessed_at <= coalesce(v_row.reprocessed_at, 0)) then
            return 'skip';
        end if;
    end if;
    insert into workspace.fireflies_deliveries as d (account_id, meeting_id, status, attempts, reprocessed_at)
    values (p_account_id, p_meeting_id, 'pending', 1, p_reprocessed_at)
    on conflict (account_id, meeting_id) do update set
        status = 'pending',
        reason = null,
        attempts = d.attempts + 1,
        reprocessed_at = greatest(d.reprocessed_at, excluded.reprocessed_at),
        updated_at = now();
    return 'fetch';
end;
$$;

-- End one meeting fetch: done (with how many parts were stored), failed (a
-- short reason code, never text) or not_found.
create or replace function workspace.fireflies_delivery_end(
    p_account_id uuid,
    p_meeting_id text,
    p_event      text,
    p_status     text,
    p_reason     text,
    p_parts      integer
)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_event text := case when p_event ~ '^[A-Za-z0-9 ._-]{1,64}$' then p_event else 'unknown' end;
begin
    if p_status not in ('done', 'failed', 'not_found') then
        raise exception 'status must be done, failed or not_found' using errcode = '22023';
    end if;
    update workspace.fireflies_deliveries d set
        status = p_status,
        reason = case when p_status = 'done' then null
                      when p_reason ~ '^[a-z_]{1,40}$' then p_reason else 'failed' end,
        parts = case when p_status = 'done' then p_parts else d.parts end,
        events = case when p_status = 'done' and not (v_event = any (d.events))
                      then d.events || v_event else d.events end,
        updated_at = now()
    where d.account_id = p_account_id and d.meeting_id = p_meeting_id;
end;
$$;

-- The account's Fireflies API key, for the service's one fetch.
create or replace function workspace.fireflies_hook_api_key(p_account_id uuid)
returns text
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select workspace._curator_vault_secret(workspace._ff_key_name(h.account_id))
    from workspace.fireflies_hooks h where h.account_id = p_account_id;
$$;

-- Store one meeting (or one part of it) for the account's owner, through the
-- same body record_source_item uses. The account and source are the hook's,
-- whatever the item says.
create or replace function workspace.fireflies_hook_record(p_account_id uuid, p_item jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_acct workspace.source_accounts%rowtype;
begin
    select a.* into v_acct
    from workspace.source_accounts a
    join workspace.fireflies_hooks h on h.account_id = a.id
    where a.id = p_account_id;
    if not found then
        raise exception 'that Fireflies account is not connected' using errcode = '22023';
    end if;
    if p_item is null or jsonb_typeof(p_item) <> 'object' then
        raise exception 'item must be an object' using errcode = '22023';
    end if;
    return workspace._source_item_record_for(
        v_acct.owner_principal_id,
        (p_item - 'topics' - 'owner')
            || jsonb_build_object('source', 'fireflies', 'account', v_acct.account));
end;
$$;

-- For get_ingest_plan: is the caller's account of this source fed by webhook?
create or replace function workspace.source_webhook_connected(
    p_oauth_subject text,
    p_source        text,
    p_account       text
)
returns boolean
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select exists (
        select 1
        from workspace.source_accounts a
        join workspace.fireflies_hooks h on h.account_id = a.id
        where a.owner_principal_id = workspace._principal_id_for_oauth_subject(p_oauth_subject)
          and a.source = lower(btrim(coalesce(p_source, '')))
          and a.source = 'fireflies'
          and a.account = lower(btrim(coalesce(p_account, ''))));
$$;


-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace.app_fireflies_connect(text, text, text, text, text) from public;
revoke all on function workspace.app_fireflies_connect(text, text, text, text, text) from anon, authenticated;
grant execute on function workspace.app_fireflies_connect(text, text, text, text, text) to kb_engine;
revoke all on function workspace.app_fireflies_get(text, uuid) from public;
revoke all on function workspace.app_fireflies_get(text, uuid) from anon, authenticated;
grant execute on function workspace.app_fireflies_get(text, uuid) to kb_engine;
revoke all on function workspace.app_fireflies_missed(text, uuid) from public;
revoke all on function workspace.app_fireflies_missed(text, uuid) from anon, authenticated;
grant execute on function workspace.app_fireflies_missed(text, uuid) to kb_engine;
revoke all on function workspace.app_fireflies_disconnect(text, uuid) from public;
revoke all on function workspace.app_fireflies_disconnect(text, uuid) from anon, authenticated;
grant execute on function workspace.app_fireflies_disconnect(text, uuid) to kb_engine;
revoke all on function workspace.fireflies_hook_lookup(text) from public;
revoke all on function workspace.fireflies_hook_lookup(text) from anon, authenticated;
grant execute on function workspace.fireflies_hook_lookup(text) to kb_engine;
revoke all on function workspace.fireflies_hook_seen(uuid, text) from public;
revoke all on function workspace.fireflies_hook_seen(uuid, text) from anon, authenticated;
grant execute on function workspace.fireflies_hook_seen(uuid, text) to kb_engine;
revoke all on function workspace.fireflies_delivery_begin(uuid, text, text, bigint) from public;
revoke all on function workspace.fireflies_delivery_begin(uuid, text, text, bigint) from anon, authenticated;
grant execute on function workspace.fireflies_delivery_begin(uuid, text, text, bigint) to kb_engine;
revoke all on function workspace.fireflies_delivery_end(uuid, text, text, text, text, integer) from public;
revoke all on function workspace.fireflies_delivery_end(uuid, text, text, text, text, integer) from anon, authenticated;
grant execute on function workspace.fireflies_delivery_end(uuid, text, text, text, text, integer) to kb_engine;
revoke all on function workspace.fireflies_hook_api_key(uuid) from public;
revoke all on function workspace.fireflies_hook_api_key(uuid) from anon, authenticated;
grant execute on function workspace.fireflies_hook_api_key(uuid) to kb_engine;
revoke all on function workspace.fireflies_hook_record(uuid, jsonb) from public;
revoke all on function workspace.fireflies_hook_record(uuid, jsonb) from anon, authenticated;
grant execute on function workspace.fireflies_hook_record(uuid, jsonb) to kb_engine;
revoke all on function workspace.source_webhook_connected(text, text, text) from public;
revoke all on function workspace.source_webhook_connected(text, text, text) from anon, authenticated;
grant execute on function workspace.source_webhook_connected(text, text, text) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from workspace.fireflies_hooks;
-- select has_function_privilege('anon',
--   'workspace.fireflies_hook_lookup(text)', 'execute');                 -- f


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply 0076's source_item_record (its full body) first, then:
-- drop function if exists workspace.source_webhook_connected(text, text, text);
-- drop function if exists workspace.fireflies_hook_record(uuid, jsonb);
-- drop function if exists workspace.fireflies_hook_api_key(uuid);
-- drop function if exists workspace.fireflies_delivery_end(uuid, text, text, text, text, integer);
-- drop function if exists workspace.fireflies_delivery_begin(uuid, text, text, bigint);
-- drop function if exists workspace.fireflies_hook_seen(uuid, text);
-- drop function if exists workspace.fireflies_hook_lookup(text);
-- drop function if exists workspace.app_fireflies_disconnect(text, uuid);
-- drop function if exists workspace.app_fireflies_missed(text, uuid);
-- drop function if exists workspace.app_fireflies_get(text, uuid);
-- drop function if exists workspace.app_fireflies_connect(text, text, text, text, text);
-- drop function if exists workspace._ff_sig_name(uuid);
-- drop function if exists workspace._ff_key_name(uuid);
-- drop function if exists workspace._ff_vault_drop(text);
-- drop function if exists workspace._ff_vault_put(text, text);
-- drop function if exists workspace._source_item_record_for(uuid, jsonb);
-- drop table if exists workspace.fireflies_deliveries;
-- drop table if exists workspace.fireflies_hooks;
-- delete from vault.secrets where name like 'kbe\_ff\_%';
-- delete from workspace.source_rule_audit where action = 'webhook';
-- then re-add source_rule_audit_action without 'webhook' (0080).
