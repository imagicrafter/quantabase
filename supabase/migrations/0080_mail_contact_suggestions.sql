-- 0080_mail_contact_suggestions.sql
--
-- Suggested rules from the owner's own mail (docs/source-rules.md,
-- "Suggested from your mail").
--
-- Writing Gmail inclusion rules meant digging through the mailbox to work out
-- which people and domains matter. Now the owner runs the plugin's
-- suggest-rules skill in their own Claude. It reads ONLY header metadata
-- (from, to, cc, date, label ids) of the last ~90 days through the owner's
-- own Gmail connector, counts it on the owner's machine, and hands the Engine
-- counts per address and per domain:
--
--   sent_to        messages the owner sent to them (the strongest signal)
--   received_from  messages they sent the owner
--   threads        threads they were in
--   replied        threads they wrote in that the owner answered
--   last_seen      the newest of those messages
--   chosen         what the owner picked when the skill asked them in Claude
--                  (true / false), or null when they made no choice
--
-- Never a name, subject, snippet, body or message id (the service's schema
-- refuses any other key; this function stores only the columns below). The
-- Engine never holds a mailbox token: the counts come from the owner's Claude.
--
--   source_contact_suggestions   one row per account, kind and value. A new
--                                report replaces the account's rows. Closed
--                                (RLS on, no grants): read and written only
--                                through the two functions below.
--   source_contacts_report       the run hands the counts over, for the
--                                caller's OWN gmail account (made on first
--                                use, as source_ingest_plan does).
--   app_source_contacts_get      the caller's OWN account's suggestions for
--                                the rule screen, strongest first. Another
--                                person, an administrator included, is refused.
--
-- Suggestions are not rules, and Claude never makes a rule. The rule screen
-- starts with the owner's picks ticked and turns the ones they save into rules
-- through app_source_rules_save (0063), with its checks, dry-run and yes.

-- ── tables ──────────────────────────────────────────────────────────────────

create table if not exists workspace.source_contact_suggestions (
    account_id    uuid        not null references workspace.source_accounts(id) on delete cascade,
    kind          text        not null,
    value         text        not null,
    sent_to       integer     not null default 0,
    received_from integer     not null default 0,
    threads       integer     not null default 0,
    replied       integer     not null default 0,
    people        integer     not null default 1,
    free_mail     boolean     not null default false,
    chosen        boolean,
    last_seen     timestamptz,
    primary key (account_id, kind, value),
    constraint source_contact_suggestions_kind check (kind in ('address', 'domain')),
    constraint source_contact_suggestions_value
        check (value = lower(value) and length(value) between 3 and 254 and value !~ '[[:space:]]'),
    constraint source_contact_suggestions_counts
        check (sent_to >= 0 and received_from >= 0 and threads >= 0 and replied >= 0 and people >= 0)
);

comment on table workspace.source_contact_suggestions is
    'Counts per address and per domain from the owner''s own mail headers (sent to, '
    'received from, threads, replied, last seen), reported by the suggest-rules skill. '
    'Feeds the rule screen''s suggestions. No names, subjects, text or message ids.';

alter table workspace.source_contact_suggestions enable row level security;
revoke all on workspace.source_contact_suggestions from public;
revoke all on workspace.source_contact_suggestions from anon, authenticated;

alter table workspace.source_accounts
    add column if not exists contacts_reported_at timestamptz,
    add column if not exists contacts_days        integer,
    add column if not exists contacts_messages    integer;

alter table workspace.source_rule_audit drop constraint if exists source_rule_audit_action;
alter table workspace.source_rule_audit add constraint source_rule_audit_action check (action in (
    'account_added', 'rules_saved', 'rules_migrated', 'backfill', 'backfill_served', 'recheck',
    'sample_requested', 'labels_deleted', 'contacts_reported'));


-- ── helpers (no grants) ─────────────────────────────────────────────────────

-- One reported row, checked and cleaned, or 22023.
create or replace function workspace._src_contact_row(p_row jsonb)
returns workspace.source_contact_suggestions
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v   workspace.source_contact_suggestions%rowtype;
    n   text;
begin
    if jsonb_typeof(p_row) <> 'object' then
        raise exception 'each suggestion is an object' using errcode = '22023';
    end if;
    v.kind := coalesce(p_row->>'kind', '');
    v.value := lower(btrim(coalesce(p_row->>'value', '')));
    if v.kind = 'address' and v.value !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' then
        raise exception 'a suggested address is not an email address' using errcode = '22023';
    elsif v.kind = 'domain' and v.value !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then
        raise exception 'a suggested domain is not a domain' using errcode = '22023';
    elsif v.kind not in ('address', 'domain') then
        raise exception 'a suggestion is an address or a domain' using errcode = '22023';
    end if;
    if length(v.value) > 254 then
        raise exception 'a suggested value is too long' using errcode = '22023';
    end if;
    foreach n in array array['sent_to', 'received_from', 'threads', 'replied', 'people'] loop
        if p_row ? n and (jsonb_typeof(p_row->n) <> 'number' or (p_row->>n) !~ '^\d{1,7}$') then
            raise exception 'a suggestion count is not a whole number from 0 to 9999999' using errcode = '22023';
        end if;
    end loop;
    v.sent_to := coalesce((p_row->>'sent_to')::integer, 0);
    v.received_from := coalesce((p_row->>'received_from')::integer, 0);
    v.threads := coalesce((p_row->>'threads')::integer, 0);
    v.replied := coalesce((p_row->>'replied')::integer, 0);
    v.people := coalesce((p_row->>'people')::integer, 1);
    v.free_mail := coalesce((p_row->>'free_mail')::boolean, false);
    if p_row ? 'chosen' and jsonb_typeof(p_row->'chosen') not in ('boolean', 'null') then
        raise exception 'a suggestion''s chosen is not true or false' using errcode = '22023';
    end if;
    v.chosen := (p_row->>'chosen')::boolean;
    v.last_seen := case when (p_row->>'last_seen') ~ '^\d{4}-\d{2}-\d{2}' then (p_row->>'last_seen')::timestamptz end;
    return v;
exception
    when invalid_datetime_format or datetime_field_overflow then
        raise exception 'a suggestion''s last_seen is not a date and time' using errcode = '22023';
    when invalid_text_representation then
        raise exception 'a suggestion''s free_mail is not true or false' using errcode = '22023';
end;
$$;

-- Common free-mail domains: a person there is a person, never a whole domain.
-- The same list as engine sources/mail-contacts.ts FREE_MAIL_DOMAINS.
create or replace function workspace._src_free_mail(p_domain text)
returns boolean
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select lower(p_domain) = any (array[
        'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
        'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
        'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com',
        'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com', 'tutanota.com', 'qq.com', '163.com',
        'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net']);
$$;


-- ── the run (by signed-in subject, kb_engine) ───────────────────────────────

create or replace function workspace.source_contacts_report(
    p_oauth_subject text, p_account text, p_days integer, p_messages integer, p_contacts jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_owner uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_acct  workspace.source_accounts%rowtype;
    v_row   workspace.source_contact_suggestions%rowtype;
    v_c     jsonb;
    v_addr  integer := 0;
    v_dom   integer := 0;
begin
    if v_owner is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    if p_days is null or p_days not between 1 and 365 or p_messages is null or p_messages not between 0 and 100000 then
        raise exception 'days is 1 to 365 and messages 0 to 100000' using errcode = '22023';
    end if;
    if coalesce(jsonb_typeof(p_contacts), 'null') <> 'array' then
        raise exception 'contacts is a list' using errcode = '22023';
    end if;
    if jsonb_array_length(p_contacts) > 800 then
        raise exception 'at most 800 suggestions (500 people and 300 domains)' using errcode = '22023';
    end if;
    v_acct := workspace._src_account_for(v_owner, 'gmail', p_account, v_owner);

    delete from workspace.source_contact_suggestions s where s.account_id = v_acct.id;
    for v_c in select * from jsonb_array_elements(p_contacts) loop
        v_row := workspace._src_contact_row(v_c);
        if v_row.kind = 'domain' and workspace._src_free_mail(v_row.value) then
            continue;
        end if;
        if v_row.kind = 'address' and v_row.value = v_acct.account then
            continue;
        end if;
        insert into workspace.source_contact_suggestions
            (account_id, kind, value, sent_to, received_from, threads, replied, people, free_mail, chosen, last_seen)
        values (v_acct.id, v_row.kind, v_row.value, v_row.sent_to, v_row.received_from, v_row.threads,
                v_row.replied, v_row.people,
                v_row.kind = 'address' and workspace._src_free_mail(split_part(v_row.value, '@', 2)),
                v_row.chosen, v_row.last_seen)
        on conflict (account_id, kind, value) do nothing;
        if found then
            if v_row.kind = 'address' then v_addr := v_addr + 1; else v_dom := v_dom + 1; end if;
        end if;
    end loop;

    update workspace.source_accounts
       set contacts_reported_at = now(), contacts_days = p_days, contacts_messages = p_messages
     where id = v_acct.id;
    insert into workspace.source_rule_audit (account_id, actor, action, detail)
    values (v_acct.id, v_owner, 'contacts_reported',
            jsonb_build_object('addresses', v_addr, 'domains', v_dom, 'days', p_days, 'messages', p_messages));
    return jsonb_build_object('addresses', v_addr, 'domains', v_dom);
end;
$$;

comment on function workspace.source_contacts_report(text, text, integer, integer, jsonb) is
    'The suggest-rules skill hands over counts per address and domain from the caller''s '
    'own Gmail headers. Replaces the account''s last report. Counts only.';


-- ── the owner's rule screen (by email, kb_engine) ───────────────────────────

create or replace function workspace.app_source_contacts_get(p_email text, p_account_id uuid)
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
    if v_acct.source <> 'gmail' then
        raise exception 'suggestions from mail exist for gmail accounts only' using errcode = '22023';
    end if;
    return jsonb_build_object(
        'reported_at', v_acct.contacts_reported_at,
        'days', v_acct.contacts_days,
        'messages', v_acct.contacts_messages,
        'contacts', coalesce((
            select jsonb_agg(jsonb_build_object(
                'kind', s.kind, 'value', s.value, 'sent_to', s.sent_to, 'received_from', s.received_from,
                'threads', s.threads, 'replied', s.replied, 'people', s.people, 'free_mail', s.free_mail,
                'chosen', s.chosen, 'last_seen', s.last_seen)
                order by s.sent_to * 3 + s.replied * 2 + s.received_from desc, s.value)
            from workspace.source_contact_suggestions s
            where s.account_id = v_acct.id), '[]'::jsonb));
end;
$$;

comment on function workspace.app_source_contacts_get(text, uuid) is
    'The signed-in person''s own Gmail account''s suggested contacts, strongest first. '
    'Counts only. Refuses an account that is not the caller''s.';


-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._src_contact_row(jsonb) from public;
revoke all on function workspace._src_contact_row(jsonb) from anon, authenticated;
revoke all on function workspace._src_free_mail(text) from public;
revoke all on function workspace._src_free_mail(text) from anon, authenticated;
revoke all on function workspace.source_contacts_report(text, text, integer, integer, jsonb) from public;
revoke all on function workspace.source_contacts_report(text, text, integer, integer, jsonb) from anon, authenticated;
grant execute on function workspace.source_contacts_report(text, text, integer, integer, jsonb) to kb_engine;
revoke all on function workspace.app_source_contacts_get(text, uuid) from public;
revoke all on function workspace.app_source_contacts_get(text, uuid) from anon, authenticated;
grant execute on function workspace.app_source_contacts_get(text, uuid) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from workspace.source_contact_suggestions;
-- select has_function_privilege('anon',
--   'workspace.app_source_contacts_get(text, uuid)', 'execute');        -- f


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.app_source_contacts_get(text, uuid);
-- drop function if exists workspace.source_contacts_report(text, text, integer, integer, jsonb);
-- drop function if exists workspace._src_free_mail(text);
-- drop function if exists workspace._src_contact_row(jsonb);
-- drop table if exists workspace.source_contact_suggestions;
-- alter table workspace.source_accounts drop column if exists contacts_reported_at,
--   drop column if exists contacts_days, drop column if exists contacts_messages;
-- delete from workspace.source_rule_audit where action = 'contacts_reported';
-- then re-add source_rule_audit_action without 'contacts_reported' (0063).
