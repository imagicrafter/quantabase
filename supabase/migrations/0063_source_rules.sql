-- 0063_source_rules.sql
--
-- Source inclusion rules (decision 2026-11-21, security architect's design).
--
-- An ingest run used to hand over ALL mail since the cursor. Now each person
-- writes rules for each of THEIR OWN source accounts (gmail:<address>,
-- fireflies:<account>), and the Engine enforces them:
--
--   default-deny     an item no include rule matches is not kept: it is
--                    counted on the account and its text is never stored
--   exclude first    an exclude rule that matches always wins
--   first match      include rules are tried in order; the first match decides
--   one topic        each include rule maps to exactly ONE topic the author
--                    holds, or is "private" (kept, owner-only)
--   fields AND       within a rule every field must match; within a field any
--                    value may match
--   labels by id     a Gmail label (or Fireflies channel) is matched by the
--                    provider's id; a rename is safe; a label that is gone
--                    (a complete label list without it) makes its rule
--                    "broken", and a broken include rule matches nothing
--   server decides   record_source_item evaluates the rules itself from the
--                    item's provider metadata (from/to/cc, label ids, channel
--                    ids, participants), sets the topic itself and ignores any
--                    topic or owner the plugin claims
--   versions         rule sets are append-only versions; every item stamps
--                    rule_id, rule_version and ruleset_version; every change
--                    is in source_rule_audit
--   narrowing        saving a rule set that takes a topic away from items
--                    already kept (another topic, private, or no longer
--                    included) re-files them owner-only at once (rule_state
--                    'recheck') and flags the pages built from them; the
--                    owner then re-checks. Widening applies to new items only,
--                    unless the owner asks for a backfill.
--   picker           labels and channels an ingest run reports per account
--                    (source_account_labels) feed the rule builder; the
--                    0060 tag switch no longer makes topics. Topics are made
--                    by administrators only (app_topic_add is the service's
--                    again; app_source_tag_set is not).
--   preview          a run may report a metadata-only sample of the last 7
--                    days (source_candidates); the owner's dry-run evaluates
--                    draft rules against it. No subject or body is kept.
--
-- WHO SEES WHAT
--   Every person (administrators included) reads and edits only their own
--   accounts and rules. An administrator sees, for other people, a count of
--   rules per person and nothing else (app_people_rule_counts).
--
-- ONE TOPIC PER PAGE
--   pages may now hold one live page per owner, key and topic set. The
--   curator offers an item only pages with exactly the item's topics, and
--   writes only pages with exactly those topics; facts from an item in
--   another topic go to a separate page (curator_candidates,
--   curator_page_save, _page_save_as replaced here).
--
-- Sources without rules yet (Drive, Calendar) keep the 0060 behaviour for
-- tags already switched on; no new tag can be switched on.

-- ── tables ──────────────────────────────────────────────────────────────────

create table if not exists workspace.source_accounts (
    id                  uuid        primary key default gen_random_uuid(),
    owner_principal_id  uuid        not null
        references workspace.principals(id) on delete restrict,
    source              text        not null,
    account             text        not null,
    last_seen_id        text,
    last_received_at    timestamptz,
    items_received      bigint      not null default 0,
    items_saved         bigint      not null default 0,
    items_skipped       bigint      not null default 0,
    sample_requested_at timestamptz default now(),
    sample_reported_at  timestamptz,
    labels_reported_at  timestamptz,
    backfill_from       timestamptz,
    created_at          timestamptz not null default now(),
    constraint source_accounts_source_values check (source in ('gmail', 'fireflies')),
    constraint source_accounts_account_shape
        check (account = lower(account) and length(account) between 3 and 254 and account !~ '[[:space:]]'),
    constraint source_accounts_uniq unique (owner_principal_id, source, account)
);

comment on table workspace.source_accounts is
    'One row per person per source account (gmail:<address>, fireflies:<account>): '
    'its cursor, counts (saved, skipped by the rules) and preview/backfill requests.';

create table if not exists workspace.source_account_labels (
    account_id    uuid        not null references workspace.source_accounts(id) on delete restrict,
    label_id      text        not null,
    kind          text        not null,
    name          text        not null,
    first_seen_at timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    deleted_at    timestamptz,
    primary key (account_id, label_id),
    constraint source_account_labels_kind check (kind in ('label', 'channel')),
    constraint source_account_labels_id_len check (length(label_id) between 1 and 300),
    constraint source_account_labels_name_len check (length(name) between 1 and 200)
);

comment on table workspace.source_account_labels is
    'Labels (Gmail) and channels (Fireflies) an ingest run reported for one account: '
    'the picker for rule building. Matched by id; deleted_at set when a complete '
    'list no longer has it.';

create table if not exists workspace.source_rule_sets (
    account_id  uuid        not null references workspace.source_accounts(id) on delete restrict,
    version     integer     not null,
    rules       jsonb       not null,
    created_by  uuid        references workspace.principals(id) on delete restrict,
    created_at  timestamptz not null default now(),
    primary key (account_id, version),
    constraint source_rule_sets_version_positive check (version >= 1),
    constraint source_rule_sets_rules_array check (jsonb_typeof(rules) = 'array')
);

comment on table workspace.source_rule_sets is
    'Append-only: every saved rule list for one account, in order. The newest '
    'version is in force. Rows are never changed or removed.';

create or replace function workspace._source_rule_sets_frozen()
returns trigger
language plpgsql
set search_path = workspace, pg_temp
as $$
begin
    raise exception 'rule set versions are append-only' using errcode = '42501';
end;
$$;

drop trigger if exists source_rule_sets_frozen on workspace.source_rule_sets;
create trigger source_rule_sets_frozen
    before update or delete on workspace.source_rule_sets
    for each row execute function workspace._source_rule_sets_frozen();

create table if not exists workspace.source_rule_audit (
    id              bigserial   primary key,
    account_id      uuid        not null references workspace.source_accounts(id) on delete restrict,
    actor           uuid        references workspace.principals(id) on delete restrict,
    action          text        not null,
    ruleset_version integer,
    detail          jsonb       not null default '{}'::jsonb,
    at              timestamptz not null default now(),
    constraint source_rule_audit_action check (action in (
        'account_added', 'rules_saved', 'rules_migrated', 'backfill', 'backfill_served', 'recheck',
        'sample_requested', 'labels_deleted'))
);

create index if not exists source_rule_audit_account on workspace.source_rule_audit (account_id, at desc);

create table if not exists workspace.source_candidates (
    id          bigserial   primary key,
    account_id  uuid        not null references workspace.source_accounts(id) on delete cascade,
    item_ref    text        not null,
    meta        jsonb       not null,
    item_date   timestamptz,
    reported_at timestamptz not null default now()
);

create index if not exists source_candidates_account on workspace.source_candidates (account_id, item_date desc);

comment on table workspace.source_candidates is
    'Metadata-only sample of recent items per account (from, to, cc, label or '
    'channel ids, participants, date). No subject, no body. Feeds the dry-run.';

alter table workspace.source_accounts enable row level security;
revoke all on workspace.source_accounts from public;
revoke all on workspace.source_accounts from anon, authenticated;
alter table workspace.source_account_labels enable row level security;
revoke all on workspace.source_account_labels from public;
revoke all on workspace.source_account_labels from anon, authenticated;
alter table workspace.source_rule_sets enable row level security;
revoke all on workspace.source_rule_sets from public;
revoke all on workspace.source_rule_sets from anon, authenticated;
alter table workspace.source_rule_audit enable row level security;
revoke all on workspace.source_rule_audit from public;
revoke all on workspace.source_rule_audit from anon, authenticated;
alter table workspace.source_candidates enable row level security;
revoke all on workspace.source_candidates from public;
revoke all on workspace.source_candidates from anon, authenticated;

alter table workspace.source_items
    add column if not exists account_id      uuid references workspace.source_accounts(id) on delete restrict,
    add column if not exists rule_id         uuid,
    add column if not exists rule_version    integer,
    add column if not exists ruleset_version integer,
    add column if not exists rule_state      text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'source_items_rule_state_values') then
        alter table workspace.source_items
            add constraint source_items_rule_state_values check (rule_state is null or rule_state = 'recheck');
    end if;
end $$;

create index if not exists source_items_account on workspace.source_items (account_id) where deleted_at is null;

alter table workspace.pages
    add column if not exists recheck_at     timestamptz,
    add column if not exists recheck_reason text;

comment on column workspace.pages.recheck_at is
    'Set when a rule change re-filed an item this page was built from: the page '
    'needs re-curation. Cleared by its owner.';

-- One live page per owner, key AND topic set (one topic per page).
drop index if exists workspace.pages_owner_key_live;
create unique index if not exists pages_owner_key_topics_live
    on workspace.pages (owner_principal_id, key, topics)
    where deleted_at is null;


-- ── helpers (no grants) ─────────────────────────────────────────────────────

-- Every email address in a JSON string or list of strings, lower case.
create or replace function workspace._src_emails(p_value jsonb)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select coalesce(array_agg(distinct m[1]), array[]::text[])
    from (
        select case jsonb_typeof(p_value)
                   when 'string' then p_value #>> '{}'
                   when 'array' then (select string_agg(e #>> '{}', ' ')
                                      from jsonb_array_elements(p_value) e
                                      where jsonb_typeof(e) = 'string')
               end as txt
    ) s,
    lateral regexp_matches(lower(coalesce(s.txt, '')),
                           '([a-z0-9._%+''-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)', 'g') m;
$$;

-- A JSON list of strings as text[] (other values dropped), at most 200.
create or replace function workspace._src_ids(p_value jsonb)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select coalesce(array_agg(distinct left(btrim(e #>> '{}'), 300)), array[]::text[])
    from (select e from jsonb_array_elements(
              case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end) e
          limit 200) x
    where jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> '';
$$;

-- One address-or-domain value from a rule: an address stays as is; a domain
-- becomes "@domain". Null when it is neither.
create or replace function workspace._src_addr_value(p_value text)
returns text
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select case
        when v ~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' then v
        when v ~ '^@?[a-z0-9-]+(\.[a-z0-9-]+)+$' then '@' || ltrim(v, '@')
    end
    from (select lower(btrim(coalesce(p_value, ''))) as v) s;
$$;

-- True when any address matches any value (an address exactly; "@domain" the
-- domain or any of its subdomains).
create or replace function workspace._src_addr_hit(p_addrs text[], p_values text[])
returns boolean
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select exists (
        select 1
        from unnest(coalesce(p_addrs, array[]::text[])) a,
             unnest(coalesce(p_values, array[]::text[])) v
        where (left(v, 1) <> '@' and a = v)
           or (left(v, 1) = '@' and (split_part(a, '@', 2) = substr(v, 2)
                                     or split_part(a, '@', 2) like '%.' || substr(v, 2))));
$$;

-- The provider metadata the Engine reads, from what the run passed. Only
-- these keys are kept; nothing else (no subject, no body).
create or replace function workspace._src_meta(p_source text, p_provider jsonb)
returns jsonb
language plpgsql
immutable
set search_path = workspace, pg_temp
as $$
declare
    p jsonb := case when jsonb_typeof(p_provider) = 'object' then p_provider else '{}'::jsonb end;
begin
    if p_source = 'gmail' then
        return jsonb_build_object(
            'message_id', left(p->>'message_id', 300),
            'thread_id',  left(p->>'thread_id', 300),
            'date',       left(p->>'date', 64),
            'from',       to_jsonb(workspace._src_emails(p->'from')),
            'to',         to_jsonb(workspace._src_emails(p->'to')),
            'cc',         to_jsonb(workspace._src_emails(p->'cc')),
            'labels',     to_jsonb(workspace._src_ids(p->'label_ids')));
    end if;
    return jsonb_build_object(
        'meeting_id',   left(coalesce(p->>'meeting_id', p->>'message_id'), 300),
        'date',         left(p->>'date', 64),
        'participants', to_jsonb(workspace._src_emails(
                            coalesce(p->'participants', '[]'::jsonb)
                            || coalesce(case when jsonb_typeof(p->'organizer_email') = 'string'
                                             then jsonb_build_array(p->'organizer_email') end, '[]'::jsonb))),
        'channels',     to_jsonb(workspace._src_ids(p->'channel_ids')));
end;
$$;

create or replace function workspace._src_jtext(p_value jsonb)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select coalesce(array_agg(e #>> '{}'), array[]::text[])
    from jsonb_array_elements(case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end) e;
$$;

-- The ids of a rule's labels or channels.
create or replace function workspace._src_rule_label_ids(p_rule jsonb)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select coalesce(array_agg(l->>'id'), array[]::text[])
    from jsonb_array_elements(coalesce(p_rule->'match'->'labels', '[]'::jsonb)
                              || coalesce(p_rule->'match'->'channels', '[]'::jsonb)) l;
$$;

-- A rule is broken when a label or channel it names is gone, or (include)
-- when its author no longer holds its topic. A broken include matches nothing.
create or replace function workspace._src_rule_broken(p_rule jsonb, p_live text[], p_held text[])
returns boolean
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select (p_live is not null and not (workspace._src_rule_label_ids(p_rule) <@ p_live))
        or (p_rule->>'kind' = 'include' and p_rule->>'topic' is not null
            and not ((p_rule->>'topic') = any (coalesce(p_held, array[]::text[]))));
$$;

-- Does one rule match one item's metadata? Every field must; any value may.
create or replace function workspace._src_rule_hits(p_rule jsonb, p_meta jsonb)
returns boolean
language plpgsql
immutable
set search_path = workspace, pg_temp
as $$
declare
    v_field text;
    v_vals  jsonb;
    v_any   boolean := false;
    v_ok    boolean;
begin
    for v_field, v_vals in select * from jsonb_each(coalesce(p_rule->'match', '{}'::jsonb)) loop
        if jsonb_typeof(v_vals) <> 'array' or jsonb_array_length(v_vals) = 0 then
            continue;
        end if;
        v_any := true;
        v_ok := case v_field
            when 'any_address' then workspace._src_addr_hit(
                workspace._src_jtext(p_meta->'from') || workspace._src_jtext(p_meta->'to')
                || workspace._src_jtext(p_meta->'cc'), workspace._src_jtext(v_vals))
            when 'from' then workspace._src_addr_hit(workspace._src_jtext(p_meta->'from'), workspace._src_jtext(v_vals))
            when 'to' then workspace._src_addr_hit(workspace._src_jtext(p_meta->'to'), workspace._src_jtext(v_vals))
            when 'cc' then workspace._src_addr_hit(workspace._src_jtext(p_meta->'cc'), workspace._src_jtext(v_vals))
            when 'participants' then workspace._src_addr_hit(workspace._src_jtext(p_meta->'participants'), workspace._src_jtext(v_vals))
            when 'labels' then workspace._src_rule_label_ids(jsonb_build_object('match', jsonb_build_object('labels', v_vals)))
                               && workspace._src_jtext(p_meta->'labels')
            when 'channels' then workspace._src_rule_label_ids(jsonb_build_object('match', jsonb_build_object('channels', v_vals)))
                               && workspace._src_jtext(p_meta->'channels')
            else false
        end;
        if not v_ok then
            return false;
        end if;
    end loop;
    return v_any;
end;
$$;

-- The decision for one item: exclude rules first (any match wins), then
-- include rules in order (first match wins), else nothing.
create or replace function workspace._source_rules_eval(
    p_source text, p_rules jsonb, p_meta jsonb, p_live text[], p_held text[])
returns jsonb
language plpgsql
immutable
set search_path = workspace, pg_temp
as $$
declare
    v_rule jsonb;
begin
    for v_rule in select r from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) r
                  where r->>'kind' = 'exclude' loop
        if workspace._src_rule_hits(v_rule, p_meta) then
            return jsonb_build_object('decision', 'exclude', 'reason', 'excluded',
                                      'rule_id', v_rule->>'id', 'rule_version', (v_rule->>'version')::int,
                                      'name', v_rule->>'name');
        end if;
    end loop;
    for v_rule in select r from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) r
                  where r->>'kind' = 'include' loop
        if not workspace._src_rule_broken(v_rule, p_live, p_held)
           and workspace._src_rule_hits(v_rule, p_meta) then
            return jsonb_build_object('decision', 'include',
                                      'rule_id', v_rule->>'id', 'rule_version', (v_rule->>'version')::int,
                                      'name', v_rule->>'name',
                                      'topic', v_rule->>'topic',
                                      'private', coalesce((v_rule->>'private')::boolean, false));
        end if;
    end loop;
    return jsonb_build_object('decision', 'none', 'reason', 'no_rule');
end;
$$;

-- The topics a decision files an item under; null when not included.
create or replace function workspace._src_decision_topics(p_decision jsonb)
returns text[]
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select case
        when p_decision->>'decision' <> 'include' then null
        when (p_decision->>'private')::boolean then array[]::text[]
        else array[p_decision->>'topic']
    end;
$$;

create or replace function workspace._src_account_value(p_source text, p_account text)
returns text
language plpgsql
immutable
set search_path = workspace, pg_temp
as $$
declare
    v text := lower(btrim(coalesce(p_account, '')));
begin
    if p_source not in ('gmail', 'fireflies') then
        raise exception 'rules exist for gmail and fireflies only' using errcode = '22023';
    end if;
    if v !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' or length(v) > 254 then
        raise exception 'account must be the email address of the % account', p_source using errcode = '22023';
    end if;
    return v;
end;
$$;

-- The caller's account row for (source, account), made on first use.
create or replace function workspace._src_account_for(p_owner uuid, p_source text, p_account text, p_actor uuid)
returns workspace.source_accounts
language plpgsql
volatile
set search_path = workspace, pg_temp
as $$
declare
    v_value text := workspace._src_account_value(p_source, p_account);
    v_row   workspace.source_accounts%rowtype;
begin
    select * into v_row from workspace.source_accounts a
    where a.owner_principal_id = p_owner and a.source = p_source and a.account = v_value;
    if found then
        return v_row;
    end if;
    if (select count(*) from workspace.source_accounts a where a.owner_principal_id = p_owner) >= 20 then
        raise exception 'at most 20 source accounts per person' using errcode = '22023';
    end if;
    insert into workspace.source_accounts (owner_principal_id, source, account)
    values (p_owner, p_source, v_value)
    on conflict (owner_principal_id, source, account) do nothing;
    select * into v_row from workspace.source_accounts a
    where a.owner_principal_id = p_owner and a.source = p_source and a.account = v_value;
    insert into workspace.source_rule_audit (account_id, actor, action, detail)
    values (v_row.id, p_actor, 'account_added', jsonb_build_object('source', p_source));
    return v_row;
end;
$$;

-- The caller's own account by id, or 42501.
create or replace function workspace._src_own_account(p_owner uuid, p_account_id uuid)
returns workspace.source_accounts
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_row workspace.source_accounts%rowtype;
begin
    select * into v_row from workspace.source_accounts a where a.id = p_account_id;
    if not found or v_row.owner_principal_id <> p_owner then
        raise exception 'that source account is not one of yours' using errcode = '42501';
    end if;
    return v_row;
end;
$$;

create or replace function workspace._src_current(p_account_id uuid)
returns table (version integer, rules jsonb)
language sql
stable
set search_path = workspace, pg_temp
as $$
    select coalesce(max(s.version), 0),
           coalesce((select s2.rules from workspace.source_rule_sets s2
                     where s2.account_id = p_account_id order by s2.version desc limit 1), '[]'::jsonb)
    from workspace.source_rule_sets s
    where s.account_id = p_account_id;
$$;

create or replace function workspace._src_live_labels(p_account_id uuid)
returns text[]
language sql
stable
set search_path = workspace, pg_temp
as $$
    select coalesce(array_agg(l.label_id), array[]::text[])
    from workspace.source_account_labels l
    where l.account_id = p_account_id and l.deleted_at is null;
$$;

create or replace function workspace._src_held(p_owner uuid)
returns text[]
language sql
stable
set search_path = workspace, pg_temp
as $$
    select array(select t from unnest(coalesce(workspace._resolve_domains_for_principal(p), array[]::text[])) t
                 where t <> 'unclassified' order by 1)
    from workspace.principals p where p.id = p_owner and p.active is true;
$$;

-- Validate and normalise a rule list for one account (the JSON schema lives
-- here). Keeps each known rule's id; bumps a rule's version when what it does
-- changed. Raises 22023 on a bad rule, 42501 on a topic the author does not hold.
create or replace function workspace._source_rules_normalize(
    p_account workspace.source_accounts, p_rules jsonb, p_prev jsonb, p_held text[])
returns jsonb
language plpgsql
volatile
set search_path = workspace, pg_temp
as $$
declare
    v_allowed text[] := case p_account.source
                            when 'gmail' then array['any_address', 'from', 'to', 'cc', 'labels']
                            else array['participants', 'channels'] end;
    v_kind_of text := case p_account.source when 'gmail' then 'label' else 'channel' end;
    v_rule    jsonb;
    v_ord     bigint;
    v_out     jsonb := '[]'::jsonb;
    v_kind    text;
    v_name    text;
    v_topic   text;
    v_private boolean;
    v_match   jsonb;
    v_field   text;
    v_vals    jsonb;
    v_norm    jsonb;
    v_val     jsonb;
    v_addr    text;
    v_lid     text;
    v_lname   text;
    v_id      uuid;
    v_prev    jsonb;
    v_version integer;
    v_ids     uuid[] := array[]::uuid[];
begin
    if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
        raise exception 'rules must be a list' using errcode = '22023';
    end if;
    if jsonb_array_length(p_rules) > 100 then
        raise exception 'at most 100 rules per account' using errcode = '22023';
    end if;
    for v_rule, v_ord in select * from jsonb_array_elements(p_rules) with ordinality loop
        if jsonb_typeof(v_rule) <> 'object' then
            raise exception 'rule %: each rule is an object', v_ord using errcode = '22023';
        end if;
        if exists (select 1 from jsonb_object_keys(v_rule) k
                   where k not in ('id', 'version', 'kind', 'name', 'match', 'topic', 'private', 'broken')) then
            raise exception 'rule %: unknown key', v_ord using errcode = '22023';
        end if;
        v_kind := v_rule->>'kind';
        if v_kind is null or v_kind not in ('include', 'exclude') then
            raise exception 'rule %: kind is include or exclude', v_ord using errcode = '22023';
        end if;
        v_name := left(btrim(coalesce(v_rule->>'name', '')), 80);
        v_topic := nullif(lower(btrim(coalesce(v_rule->>'topic', ''))), '');
        if jsonb_typeof(v_rule->'private') not in ('boolean', 'null') and v_rule ? 'private' then
            raise exception 'rule %: private is true or false', v_ord using errcode = '22023';
        end if;
        v_private := coalesce((v_rule->>'private')::boolean, false);
        if v_kind = 'include' then
            if (v_topic is null) = (not v_private) then
                raise exception 'rule %: an include rule maps to exactly one topic, or is private', v_ord
                    using errcode = '22023';
            end if;
            if v_topic is not null and not (v_topic = any (coalesce(p_held, array[]::text[]))) then
                raise exception 'rule %: you can only map a rule to a topic you hold', v_ord using errcode = '42501';
            end if;
        elsif v_topic is not null or v_private then
            raise exception 'rule %: an exclude rule has no topic and is not private', v_ord using errcode = '22023';
        end if;

        v_match := v_rule->'match';
        if v_match is null or jsonb_typeof(v_match) <> 'object' then
            raise exception 'rule %: match must be an object', v_ord using errcode = '22023';
        end if;
        v_norm := '{}'::jsonb;
        for v_field, v_vals in select * from jsonb_each(v_match) loop
            if not (v_field = any (v_allowed)) then
                raise exception 'rule %: % cannot match on %', v_ord, p_account.source, v_field using errcode = '22023';
            end if;
            if jsonb_typeof(v_vals) <> 'array' or jsonb_array_length(v_vals) > 50 then
                raise exception 'rule %: % is a list of at most 50 values', v_ord, v_field using errcode = '22023';
            end if;
            if jsonb_array_length(v_vals) = 0 then
                continue;
            end if;
            if v_field in ('labels', 'channels') then
                v_norm := v_norm || jsonb_build_object(v_field, '[]'::jsonb);
                for v_val in select * from jsonb_array_elements(v_vals) loop
                    v_lid := btrim(coalesce(case when jsonb_typeof(v_val) = 'object' then v_val->>'id'
                                                 when jsonb_typeof(v_val) = 'string' then v_val #>> '{}' end, ''));
                    select l.name into v_lname from workspace.source_account_labels l
                    where l.account_id = p_account.id and l.label_id = v_lid and l.kind = v_kind_of;
                    if not found then
                        raise exception 'rule %: % % is not one this account reported', v_ord, v_kind_of, left(v_lid, 80)
                            using errcode = '22023';
                    end if;
                    if not (v_norm->v_field @> jsonb_build_array(jsonb_build_object('id', v_lid))) then
                        v_norm := jsonb_set(v_norm, array[v_field],
                            (v_norm->v_field) || jsonb_build_array(jsonb_build_object('id', v_lid, 'name', v_lname)));
                    end if;
                end loop;
            else
                v_norm := v_norm || jsonb_build_object(v_field, '[]'::jsonb);
                for v_val in select * from jsonb_array_elements(v_vals) loop
                    v_addr := case when jsonb_typeof(v_val) = 'string'
                                   then workspace._src_addr_value(v_val #>> '{}') end;
                    if v_addr is null then
                        raise exception 'rule %: % takes email addresses or domains', v_ord, v_field using errcode = '22023';
                    end if;
                    if not (v_norm->v_field ? v_addr) then
                        v_norm := jsonb_set(v_norm, array[v_field], (v_norm->v_field) || to_jsonb(v_addr));
                    end if;
                end loop;
            end if;
        end loop;
        if v_norm = '{}'::jsonb then
            raise exception 'rule %: match at least one field', v_ord using errcode = '22023';
        end if;

        v_prev := null;
        if v_rule ? 'id' and nullif(v_rule->>'id', '') is not null then
            begin
                v_id := (v_rule->>'id')::uuid;
            exception when invalid_text_representation then
                raise exception 'rule %: unknown id', v_ord using errcode = '22023';
            end;
            select r into v_prev from jsonb_array_elements(coalesce(p_prev, '[]'::jsonb)) r
            where r->>'id' = v_id::text;
            if v_prev is null then
                raise exception 'rule %: unknown id', v_ord using errcode = '22023';
            end if;
        else
            v_id := gen_random_uuid();
        end if;
        if v_id = any (v_ids) then
            raise exception 'rule %: listed twice', v_ord using errcode = '22023';
        end if;
        v_ids := v_ids || v_id;

        v_version := case
            when v_prev is null then 1
            when v_prev->>'kind' = v_kind and v_prev->'match' = v_norm
                 and (v_prev->>'topic') is not distinct from v_topic
                 and coalesce((v_prev->>'private')::boolean, false) = v_private
                then (v_prev->>'version')::int
            else (v_prev->>'version')::int + 1
        end;

        v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
            'id', v_id, 'version', v_version, 'kind', v_kind, 'name', v_name,
            'match', v_norm, 'topic', v_topic, 'private', v_private)));
    end loop;
    return v_out;
end;
$$;

-- Rules as shown: current label names, and whether each rule is broken.
create or replace function workspace._src_rules_display(p_account_id uuid, p_rules jsonb, p_held text[])
returns jsonb
language sql
stable
set search_path = workspace, pg_temp
as $$
    select coalesce(jsonb_agg(
        r.rule
        || jsonb_build_object('broken', workspace._src_rule_broken(
               r.rule, workspace._src_live_labels(p_account_id), p_held))
        || jsonb_build_object('match', (
               select coalesce(jsonb_object_agg(f.key, case
                   when f.key in ('labels', 'channels') then (
                       select coalesce(jsonb_agg(jsonb_build_object(
                           'id', l->>'id',
                           'name', coalesce((select x.name from workspace.source_account_labels x
                                             where x.account_id = p_account_id and x.label_id = l->>'id'), l->>'name'),
                           'deleted', not exists (select 1 from workspace.source_account_labels x
                                                  where x.account_id = p_account_id and x.label_id = l->>'id'
                                                    and x.deleted_at is null))), '[]'::jsonb)
                       from jsonb_array_elements(f.value) l)
                   else f.value end), '{}'::jsonb)
               from jsonb_each(r.rule->'match') f))
        order by r.ord), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) with ordinality as r(rule, ord);
$$;

-- Re-file items already kept when a rule set changes: an item whose topics
-- are not all given by the new rules (another topic, private, or no longer
-- included) becomes owner-only at once and waits for its owner's re-check;
-- the pages built from them are flagged for re-curation. Items the new rules
-- file the same or more widely are left alone (widening is for new items).
-- The new rules are read as written: a label deleted at the source does not
-- by itself re-file what its rule already kept.
create or replace function workspace._src_refile(
    p_account workspace.source_accounts, p_new jsonb, p_held text[])
returns jsonb
language plpgsql
volatile
set search_path = workspace, pg_temp
as $$
declare
    v_item    record;
    v_new     text[];
    v_items   integer := 0;
    v_pages   integer := 0;
    v_n       integer;
begin
    for v_item in
        select s.id, s.topics, s.metadata, s.curated_pages
        from workspace.source_items s
        where s.account_id = p_account.id and s.deleted_at is null
          and s.rule_state is null
        for update
    loop
        v_new := workspace._src_decision_topics(workspace._source_rules_eval(
            p_account.source, p_new, v_item.metadata->'provider', null, p_held));
        if v_item.topics <@ coalesce(v_new, array[]::text[]) then
            continue;   -- same or wider: new items only
        end if;
        update workspace.source_items s
           set topics = array[]::text[], rule_state = 'recheck'
         where s.id = v_item.id;
        v_items := v_items + 1;
        update workspace.pages p
           set recheck_at = now(), recheck_reason = 'a source rule changed for an item this page was built from'
         where p.id = any (v_item.curated_pages) and p.deleted_at is null and p.recheck_at is null;
        get diagnostics v_n = row_count;
        v_pages := v_pages + v_n;
    end loop;
    return jsonb_build_object('refiled', v_items, 'pages_flagged', v_pages);
end;
$$;


-- ── for the ingest run (MCP, by OAuth subject) ──────────────────────────────

-- The caller's rules for one account (made on first use), whether a metadata
-- sample is wanted, and whether a backfill was asked for (served once).
create or replace function workspace.source_ingest_plan(p_oauth_subject text, p_source text, p_account text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_owner uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_acct  workspace.source_accounts%rowtype;
    v_cur   record;
    v_held  text[];
    v_out   jsonb;
begin
    if v_owner is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    v_acct := workspace._src_account_for(v_owner, lower(btrim(coalesce(p_source, ''))), p_account, v_owner);
    select * into v_cur from workspace._src_current(v_acct.id);
    v_held := workspace._src_held(v_owner);
    v_out := jsonb_build_object(
        'account_id', v_acct.id,
        'source', v_acct.source,
        'account', v_acct.account,
        'version', v_cur.version,
        'rules', workspace._src_rules_display(v_acct.id, v_cur.rules, v_held),
        'labels_known', v_acct.labels_reported_at is not null,
        'cursor', jsonb_build_object(
            'last_seen', v_acct.last_seen_id, 'last_received_at', v_acct.last_received_at,
            'items_received', v_acct.items_received, 'items_saved', v_acct.items_saved,
            'items_skipped', v_acct.items_skipped),
        'sample_requested', v_acct.sample_requested_at is not null,
        'backfill', v_acct.backfill_from is not null,
        'backfill_from', v_acct.backfill_from);
    if v_acct.backfill_from is not null then
        update workspace.source_accounts set backfill_from = null where id = v_acct.id;
        insert into workspace.source_rule_audit (account_id, actor, action, ruleset_version, detail)
        values (v_acct.id, v_owner, 'backfill_served', v_cur.version,
                jsonb_build_object('since', v_acct.backfill_from));
    end if;
    return v_out;
end;
$$;

-- The run reports an account's labels or channels (the picker) and, when
-- asked, a metadata sample of recent items for the dry-run. p_complete true
-- means the list is the account's whole list: anything missing is deleted.
create or replace function workspace.source_candidates_report(
    p_oauth_subject text, p_source text, p_account text,
    p_candidates jsonb, p_labels jsonb, p_complete boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_owner uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
    v_acct  workspace.source_accounts%rowtype;
    v_kind  text;
    v_l     jsonb;
    v_c     jsonb;
    v_id    text;
    v_name  text;
    v_ids   text[] := array[]::text[];
    v_n     integer := 0;
    v_gone  integer := 0;
    v_meta  jsonb;
begin
    if v_owner is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    v_acct := workspace._src_account_for(v_owner, lower(btrim(coalesce(p_source, ''))), p_account, v_owner);
    v_kind := case v_acct.source when 'gmail' then 'label' else 'channel' end;
    if coalesce(jsonb_typeof(p_labels), 'null') not in ('array', 'null')
       or coalesce(jsonb_typeof(p_candidates), 'null') not in ('array', 'null') then
        raise exception 'labels and candidates are lists' using errcode = '22023';
    end if;
    if jsonb_array_length(coalesce(p_labels, '[]')) > 500 or jsonb_array_length(coalesce(p_candidates, '[]')) > 500 then
        raise exception 'at most 500 labels and 500 candidates' using errcode = '22023';
    end if;

    if p_labels is not null and jsonb_typeof(p_labels) = 'array' then
        for v_l in select * from jsonb_array_elements(p_labels) loop
            v_id := btrim(coalesce(v_l->>'id', ''));
            v_name := btrim(coalesce(v_l->>'name', v_id));
            if length(v_id) not between 1 and 300 or length(v_name) not between 1 and 200 then
                continue;
            end if;
            -- Gmail's own labels never count.
            if v_kind = 'label' and (upper(v_id) in ('INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED',
                                                    'IMPORTANT', 'CHAT', 'SNOOZED', 'SCHEDULED', 'YELLOW_STAR',
                                                    'OPENED', 'MUTED')
                                     or upper(v_id) like 'CATEGORY\_%') then
                continue;
            end if;
            if v_id = any (v_ids) then
                continue;
            end if;
            v_ids := v_ids || v_id;
            insert into workspace.source_account_labels as l (account_id, label_id, kind, name)
            values (v_acct.id, v_id, v_kind, v_name)
            on conflict (account_id, label_id) do update
                set name = excluded.name, last_seen_at = now(), deleted_at = null;
        end loop;
        if coalesce(p_complete, false) then
            update workspace.source_account_labels l
               set deleted_at = now()
             where l.account_id = v_acct.id and l.deleted_at is null and not (l.label_id = any (v_ids));
            get diagnostics v_gone = row_count;
            if v_gone > 0 then
                insert into workspace.source_rule_audit (account_id, actor, action, detail)
                values (v_acct.id, v_owner, 'labels_deleted', jsonb_build_object('count', v_gone));
            end if;
            update workspace.source_accounts set labels_reported_at = now() where id = v_acct.id;
        end if;
    end if;

    if p_candidates is not null and jsonb_typeof(p_candidates) = 'array' and jsonb_array_length(p_candidates) > 0 then
        delete from workspace.source_candidates c where c.account_id = v_acct.id;
        for v_c in select * from jsonb_array_elements(p_candidates) loop
            if jsonb_typeof(v_c) <> 'object' then
                continue;
            end if;
            v_meta := workspace._src_meta(v_acct.source, v_c);
            insert into workspace.source_candidates (account_id, item_ref, meta, item_date)
            values (v_acct.id,
                    left(coalesce(v_meta->>'message_id', v_meta->>'meeting_id', 'item'), 300),
                    v_meta,
                    case when (v_meta->>'date') ~ '^\d{4}-\d{2}-\d{2}'
                         then (v_meta->>'date')::timestamptz end);
            v_n := v_n + 1;
        end loop;
        update workspace.source_accounts
           set sample_requested_at = null, sample_reported_at = now()
         where id = v_acct.id;
    end if;
    -- Keep 7 days of sample.
    delete from workspace.source_candidates c
     where c.account_id = v_acct.id and c.item_date < now() - interval '8 days';

    return jsonb_build_object('labels', cardinality(v_ids), 'candidates', v_n);
exception
    when invalid_datetime_format or datetime_field_overflow then
        raise exception 'a candidate date is not a date and time' using errcode = '22023';
end;
$$;


-- record_source_item with rules. Gmail and Fireflies items need `account` and
-- `provider` (the item's metadata); the Engine evaluates the caller's rules,
-- keeps only included items, and files them itself. `topics` and `owner` are
-- ignored whatever they say. Other sources keep the 0060 behaviour.
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
    if v_source not in ('gmail', 'fireflies', 'drive', 'calendar') then
        raise exception 'source must be gmail, fireflies, drive or calendar' using errcode = '22023';
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
    'own rules for that account include it (gmail, fireflies). The Engine sets '
    'the topic from the rule; any topic or owner passed is ignored. Items no '
    'rule includes are counted and not stored. Returns {id, version, status}.';


-- ── the owner's Sources screen (by email, kb_engine) ────────────────────────

create or replace function workspace.app_source_accounts_list(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_held text[] := workspace._src_held(v_who.id);
begin
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', a.id, 'source', a.source, 'account', a.account,
            'version', cur.version,
            'rules', jsonb_array_length(cur.rules),
            'broken', (select count(*) from jsonb_array_elements(cur.rules) r
                       where workspace._src_rule_broken(r, workspace._src_live_labels(a.id), v_held)),
            'items_saved', a.items_saved, 'items_skipped', a.items_skipped,
            'last_received_at', a.last_received_at,
            'recheck', (select count(*) from workspace.source_items s
                        where s.account_id = a.id and s.rule_state = 'recheck' and s.deleted_at is null))
            order by a.source, a.account)
        from workspace.source_accounts a
        cross join lateral workspace._src_current(a.id) cur
        where a.owner_principal_id = v_who.id), '[]'::jsonb);
end;
$$;

create or replace function workspace.app_source_account_add(p_email text, p_source text, p_account text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct workspace.source_accounts%rowtype;
begin
    v_acct := workspace._src_account_for(v_who.id, lower(btrim(coalesce(p_source, ''))), p_account, v_who.id);
    return jsonb_build_object('id', v_acct.id, 'source', v_acct.source, 'account', v_acct.account);
end;
$$;

create or replace function workspace.app_source_rules_get(p_email text, p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
    v_cur  record;
    v_held text[] := workspace._src_held(v_who.id);
begin
    select * into v_cur from workspace._src_current(v_acct.id);
    return jsonb_build_object(
        'account_id', v_acct.id, 'source', v_acct.source, 'account', v_acct.account,
        'version', v_cur.version,
        'rules', workspace._src_rules_display(v_acct.id, v_cur.rules, v_held),
        'labels', coalesce((select jsonb_agg(jsonb_build_object('id', l.label_id, 'name', l.name, 'kind', l.kind)
                                             order by lower(l.name))
                            from workspace.source_account_labels l
                            where l.account_id = v_acct.id and l.deleted_at is null), '[]'::jsonb),
        'topics', to_jsonb(v_held),
        'suggested_excludes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'kind', 'exclude', 'name', l.name,
                'match', jsonb_build_object(case l.kind when 'label' then 'labels' else 'channels' end,
                                            jsonb_build_array(jsonb_build_object('id', l.label_id, 'name', l.name))))
                order by lower(l.name))
            from workspace.source_account_labels l
            where l.account_id = v_acct.id and l.deleted_at is null
              and lower(l.name) in ('personal', 'private', 'family', 'medical', 'health', 'finance', 'banking')
              and not exists (select 1 from jsonb_array_elements(v_cur.rules) r
                              where r->>'kind' = 'exclude'
                                and l.label_id = any (workspace._src_rule_label_ids(r)))), '[]'::jsonb),
        'recheck', (select count(*) from workspace.source_items s
                    where s.account_id = v_acct.id and s.rule_state = 'recheck' and s.deleted_at is null),
        'pages_flagged', (select count(*) from workspace.pages p
                          where p.owner_principal_id = v_who.id and p.recheck_at is not null and p.deleted_at is null),
        'sample', jsonb_build_object(
            'requested', v_acct.sample_requested_at is not null,
            'reported_at', v_acct.sample_reported_at,
            'count', (select count(*) from workspace.source_candidates c where c.account_id = v_acct.id)),
        'items_saved', v_acct.items_saved, 'items_skipped', v_acct.items_skipped,
        'last_received_at', v_acct.last_received_at);
end;
$$;

-- Save the whole ordered list as a new version. p_expected_version is the
-- version the caller read; a different current version is refused (40001).
create or replace function workspace.app_source_rules_save(
    p_email text, p_account_id uuid, p_rules jsonb, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who   workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct  workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
    v_cur   record;
    v_held  text[] := workspace._src_held(v_who.id);
    v_new   jsonb;
    v_ver   integer;
    v_refile jsonb;
begin
    perform 1 from workspace.source_accounts a where a.id = v_acct.id for update;
    select * into v_cur from workspace._src_current(v_acct.id);
    if p_expected_version is distinct from v_cur.version then
        raise exception 'the rules changed since you opened them; open them again' using errcode = '40001';
    end if;
    v_new := workspace._source_rules_normalize(v_acct, p_rules, v_cur.rules, v_held);
    v_ver := v_cur.version + 1;
    insert into workspace.source_rule_sets (account_id, version, rules, created_by)
    values (v_acct.id, v_ver, v_new, v_who.id);
    v_refile := workspace._src_refile(v_acct, v_new, v_held);
    insert into workspace.source_rule_audit (account_id, actor, action, ruleset_version, detail)
    values (v_acct.id, v_who.id, 'rules_saved', v_ver,
            jsonb_build_object('rules', jsonb_array_length(v_new),
                               'was', jsonb_array_length(v_cur.rules)) || v_refile);
    return jsonb_build_object('version', v_ver, 'rules', jsonb_array_length(v_new)) || v_refile;
end;
$$;

-- Dry-run: evaluate a draft list against the metadata sample of the last 7
-- days. Nothing is saved.
create or replace function workspace.app_source_rules_preview(p_email text, p_account_id uuid, p_rules jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who   workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct  workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
    v_cur   record;
    v_held  text[] := workspace._src_held(v_who.id);
    v_live  text[] := workspace._src_live_labels(v_acct.id);
    v_rules jsonb;
begin
    select * into v_cur from workspace._src_current(v_acct.id);
    v_rules := workspace._source_rules_normalize(v_acct, p_rules, v_cur.rules, v_held);
    return (
        with ev as (
            select c.item_date, c.meta,
                   workspace._source_rules_eval(v_acct.source, v_rules, c.meta, v_live, v_held) as d
            from workspace.source_candidates c
            where c.account_id = v_acct.id
              and (c.item_date is null or c.item_date >= now() - interval '7 days')
        )
        select jsonb_build_object(
            'total', count(*),
            'included', count(*) filter (where d->>'decision' = 'include'),
            'excluded', count(*) filter (where d->>'decision' = 'exclude'),
            'not_included', count(*) filter (where d->>'decision' <> 'include'),
            'by_rule', coalesce((select jsonb_agg(jsonb_build_object('rule_id', x.rid, 'items', x.n))
                                 from (select d->>'rule_id' as rid, count(*) as n from ev
                                       where d->>'rule_id' is not null group by 1) x), '[]'::jsonb),
            'rows', coalesce((select jsonb_agg(jsonb_build_object(
                                  'date', e.item_date, 'from', e.meta->'from', 'to', e.meta->'to',
                                  'labels', e.meta->'labels', 'channels', e.meta->'channels',
                                  'participants', e.meta->'participants',
                                  'decision', e.d->>'decision', 'rule', e.d->>'name',
                                  'topic', e.d->>'topic', 'private', e.d->'private')
                                  order by e.item_date desc nulls last)
                              from (select * from ev order by item_date desc nulls last limit 100) e), '[]'::jsonb))
        from ev);
end;
$$;

create or replace function workspace.app_source_rules_history(p_email text, p_account_id uuid)
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
    return jsonb_build_object(
        'versions', coalesce((
            select jsonb_agg(jsonb_build_object(
                'version', s.version, 'created_at', s.created_at,
                'by', (select p.display_name from workspace.principals p where p.id = s.created_by),
                'rules', s.rules) order by s.version desc)
            from (select * from workspace.source_rule_sets x where x.account_id = v_acct.id
                  order by x.version desc limit 50) s), '[]'::jsonb),
        'audit', coalesce((
            select jsonb_agg(jsonb_build_object(
                'at', a.at, 'action', a.action, 'version', a.ruleset_version, 'detail', a.detail,
                'by', (select p.display_name from workspace.principals p where p.id = a.actor))
                order by a.at desc, a.id desc)
            from (select * from workspace.source_rule_audit x where x.account_id = v_acct.id
                  order by x.at desc, x.id desc limit 100) a), '[]'::jsonb));
end;
$$;

-- Re-check the items a narrowing put on hold: file each under the rule in
-- force now (a curated one is curated again), or remove it when no rule
-- includes it any more.
create or replace function workspace.app_source_recheck(p_email text, p_account_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who   workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct  workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
    v_cur   record;
    v_held  text[] := workspace._src_held(v_who.id);
    v_live  text[] := workspace._src_live_labels(v_acct.id);
    v_item  record;
    v_d     jsonb;
    v_filed integer := 0;
    v_gone  integer := 0;
begin
    select * into v_cur from workspace._src_current(v_acct.id);
    for v_item in
        select s.id, s.metadata, s.curated_at from workspace.source_items s
        where s.account_id = v_acct.id and s.rule_state = 'recheck' and s.deleted_at is null
        for update
    loop
        v_d := workspace._source_rules_eval(v_acct.source, v_cur.rules, v_item.metadata->'provider', v_live, v_held);
        if v_d->>'decision' = 'include' then
            update workspace.source_items s set
                topics = workspace._src_decision_topics(v_d),
                rule_id = (v_d->>'rule_id')::uuid, rule_version = (v_d->>'rule_version')::int,
                ruleset_version = v_cur.version, rule_state = null,
                metadata = s.metadata || jsonb_build_object(
                    'private', coalesce((v_d->>'private')::boolean, false),
                    'rule', jsonb_build_object('id', v_d->>'rule_id', 'version', (v_d->>'rule_version')::int,
                                               'set_version', v_cur.version, 'name', v_d->>'name')),
                curated_at = null,
                curator_outcome = null, curator_attempts = 0, curator_claimed_until = null
            where s.id = v_item.id;
            v_filed := v_filed + 1;
        else
            update workspace.source_items s set deleted_at = now(), rule_state = null where s.id = v_item.id;
            v_gone := v_gone + 1;
        end if;
    end loop;
    insert into workspace.source_rule_audit (account_id, actor, action, ruleset_version, detail)
    values (v_acct.id, v_who.id, 'recheck', v_cur.version,
            jsonb_build_object('refiled', v_filed, 'removed', v_gone));
    return jsonb_build_object('refiled', v_filed, 'removed', v_gone);
end;
$$;

-- Ask the next ingest run to go back to p_since (widening a rule applies to
-- new items only unless the owner asks for this).
create or replace function workspace.app_source_backfill(p_email text, p_account_id uuid, p_since timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._app_person(p_email);
    v_acct workspace.source_accounts%rowtype := workspace._src_own_account(v_who.id, p_account_id);
begin
    if p_since is null or p_since > now() or p_since < now() - interval '366 days' then
        raise exception 'a backfill goes back at most one year' using errcode = '22023';
    end if;
    update workspace.source_accounts set backfill_from = p_since where id = v_acct.id;
    insert into workspace.source_rule_audit (account_id, actor, action, ruleset_version, detail)
    values (v_acct.id, v_who.id, 'backfill',
            (select c.version from workspace._src_current(v_acct.id) c),
            jsonb_build_object('since', p_since));
    return jsonb_build_object('backfill_from', p_since);
end;
$$;

create or replace function workspace.app_source_sample_request(p_email text, p_account_id uuid)
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
    update workspace.source_accounts set sample_requested_at = now() where id = v_acct.id;
    insert into workspace.source_rule_audit (account_id, actor, action) values (v_acct.id, v_who.id, 'sample_requested');
    return true;
end;
$$;

-- The caller's pages a rule change flagged for re-curation.
create or replace function workspace.app_pages_recheck_list(p_email text)
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
        select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'drawer', p.drawer,
                                            'topics', p.topics, 'recheck_at', p.recheck_at,
                                            'reason', p.recheck_reason) order by p.recheck_at desc)
        from workspace.pages p
        where p.owner_principal_id = v_who.id and p.recheck_at is not null and p.deleted_at is null), '[]'::jsonb);
end;
$$;

create or replace function workspace.app_page_recheck_done(p_email text, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._app_person(p_email);
begin
    update workspace.pages p set recheck_at = null, recheck_reason = null
    where p.id = p_id and p.owner_principal_id = v_who.id and p.deleted_at is null;
    return found;
end;
$$;

-- Administrators: how many rules each person has. Never the rules.
create or replace function workspace.app_people_rule_counts(p_email text)
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
            'email', p.email, 'display_name', p.display_name,
            'accounts', (select count(*) from workspace.source_accounts a where a.owner_principal_id = p.id),
            'rules', coalesce((select sum(jsonb_array_length(cur.rules))
                               from workspace.source_accounts a
                               cross join lateral workspace._src_current(a.id) cur
                               where a.owner_principal_id = p.id), 0))
            order by lower(p.display_name))
        from workspace.principals p
        where p.active is true), '[]'::jsonb);
end;
$$;


-- ── one topic per page (replaces 0053's versions) ───────────────────────────

-- As in 0053, except: a page is found by owner, key AND topics. With
-- p_per_topic (the curator) a save that names other topics makes a separate
-- page; without it (a person's own save_page) a page on the same key in other
-- topics still has to be read first, and moving the page you read to other
-- topics works by passing its content_hash as expected_hash.
create or replace function workspace._page_save_as(
    p_principal     uuid,
    p_allowed       text[],
    p_page          jsonb,
    p_expected_hash text,
    p_per_topic     boolean
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
      and p.topics = v_topics
    for update;

    if not found and not coalesce(p_per_topic, false) then
        -- A person's save: the page they read on this key, in any topics.
        select * into v_existing
        from workspace.pages p
        where p.owner_principal_id = p_principal and p.key = v_key and p.deleted_at is null
        order by (p.content_hash = p_expected_hash) desc nulls last, p.updated_at desc
        limit 1
        for update;
    end if;

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

revoke all on function workspace._page_save_as(uuid, text[], jsonb, text, boolean) from public;
revoke all on function workspace._page_save_as(uuid, text[], jsonb, text, boolean) from anon, authenticated;

-- The 0053 signature, for every caller but the curator.
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
language sql
volatile
set search_path = workspace, public, pg_temp
as $$
    select * from workspace._page_save_as(p_principal, p_allowed, p_page, p_expected_hash, false);
$$;

revoke all on function workspace._page_save_as(uuid, text[], jsonb, text) from public;
revoke all on function workspace._page_save_as(uuid, text[], jsonb, text) from anon, authenticated;

-- The shortlist for one item: only the owner's pages with EXACTLY the item's
-- topics (an owner-only item: only owner-only pages).
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

-- Save a page for the item's owner: its topics must be EXACTLY the item's
-- topics that the owner still holds. A page on the same key in another topic
-- is a different page and is never touched.
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
    v_topics  text[];
begin
    select sc.owner_id, sc.allowed into v_owner, v_allowed
    from workspace._curator_item_scope(p_item_id) sc;

    v_topics := array(select distinct lower(t)
                      from unnest(workspace._jsonb_text_array(p_page->'topics', 'topics')) t
                      order by 1);
    if v_topics is distinct from v_allowed then
        raise exception 'a page from this item must have exactly the item''s topic' using errcode = '22023';
    end if;

    return query
    select * from workspace._page_save_as(v_owner, v_allowed, p_page, p_expected_hash, true);
end;
$$;


-- ── migrate 0060 tags for Gmail and Fireflies into accounts and rules ───────
-- Each person's found labels/channels become the picker of an account named
-- after their own address; every tag they had switched on becomes an include
-- rule to the same topic (if they still hold it), so nothing that was filed
-- stops being filed. Items already kept keep their topics.
do $$
declare
    v_row   record;
    v_acct  workspace.source_accounts%rowtype;
    v_rules jsonb;
begin
    for v_row in
        select distinct t.owner_principal_id as owner, t.source, lower(btrim(p.email)) as email
        from workspace.source_tags t
        join workspace.principals p on p.id = t.owner_principal_id
        where t.source in ('gmail', 'fireflies')
          and lower(btrim(coalesce(p.email, ''))) ~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
    loop
        v_acct := workspace._src_account_for(v_row.owner, v_row.source, v_row.email, null);
        insert into workspace.source_account_labels (account_id, label_id, kind, name, first_seen_at, last_seen_at)
        select v_acct.id, t.tag_id, case v_row.source when 'gmail' then 'label' else 'channel' end,
               t.display_name, t.first_seen_at, t.last_seen_at
        from workspace.source_tags t
        where t.owner_principal_id = v_row.owner and t.source = v_row.source
        on conflict (account_id, label_id) do nothing;

        select coalesce(jsonb_agg(jsonb_build_object(
                   'id', gen_random_uuid(), 'version', 1, 'kind', 'include', 'name', left(t.display_name, 80),
                   'match', jsonb_build_object(case v_row.source when 'gmail' then 'labels' else 'channels' end,
                                               jsonb_build_array(jsonb_build_object('id', t.tag_id, 'name', t.display_name))),
                   'topic', t.topic, 'private', false) order by lower(t.display_name)), '[]'::jsonb)
          into v_rules
        from workspace.source_tags t
        where t.owner_principal_id = v_row.owner and t.source = v_row.source and t.enabled and t.topic is not null;

        if jsonb_array_length(v_rules) > 0
           and not exists (select 1 from workspace.source_rule_sets s where s.account_id = v_acct.id) then
            insert into workspace.source_rule_sets (account_id, version, rules, created_by)
            values (v_acct.id, 1, v_rules, null);
            insert into workspace.source_rule_audit (account_id, actor, action, ruleset_version, detail)
            values (v_acct.id, null, 'rules_migrated', 1,
                    jsonb_build_object('from', 'switched-on source tags (0060)', 'rules', jsonb_array_length(v_rules)));
        end if;

        -- Items kept through tags (0060 recorded their tag ids) join the
        -- account, with those ids as their label or channel metadata and the
        -- migrated rule that matches them, so a later narrowing re-files them.
        update workspace.source_items s set
            account_id = v_acct.id,
            metadata = s.metadata || jsonb_build_object('provider', jsonb_build_object(
                case v_row.source when 'gmail' then 'labels' else 'channels' end,
                coalesce(s.metadata->'source_tags', '[]'::jsonb), 'legacy', true))
        where s.owner_principal_id = v_row.owner and s.source = v_row.source
          and s.account_id is null and s.deleted_at is null
          and jsonb_typeof(s.metadata->'source_tags') = 'array';
        update workspace.source_items s set
            rule_id = (d.decision->>'rule_id')::uuid,
            rule_version = (d.decision->>'rule_version')::int,
            ruleset_version = 1
        from (select x.id, workspace._source_rules_eval(v_row.source, v_rules, x.metadata->'provider', null,
                                                         workspace._src_held(v_row.owner)) as decision
              from workspace.source_items x
              where x.account_id = v_acct.id and x.deleted_at is null) d
        where s.id = d.id and d.decision->>'decision' = 'include';
    end loop;
end $$;


-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._source_rule_sets_frozen() from public;
revoke all on function workspace._source_rule_sets_frozen() from anon, authenticated;
revoke all on function workspace._src_emails(jsonb) from public;
revoke all on function workspace._src_emails(jsonb) from anon, authenticated;
revoke all on function workspace._src_ids(jsonb) from public;
revoke all on function workspace._src_ids(jsonb) from anon, authenticated;
revoke all on function workspace._src_addr_value(text) from public;
revoke all on function workspace._src_addr_value(text) from anon, authenticated;
revoke all on function workspace._src_addr_hit(text[], text[]) from public;
revoke all on function workspace._src_addr_hit(text[], text[]) from anon, authenticated;
revoke all on function workspace._src_meta(text, jsonb) from public;
revoke all on function workspace._src_meta(text, jsonb) from anon, authenticated;
revoke all on function workspace._src_jtext(jsonb) from public;
revoke all on function workspace._src_jtext(jsonb) from anon, authenticated;
revoke all on function workspace._src_rule_label_ids(jsonb) from public;
revoke all on function workspace._src_rule_label_ids(jsonb) from anon, authenticated;
revoke all on function workspace._src_rule_broken(jsonb, text[], text[]) from public;
revoke all on function workspace._src_rule_broken(jsonb, text[], text[]) from anon, authenticated;
revoke all on function workspace._src_rule_hits(jsonb, jsonb) from public;
revoke all on function workspace._src_rule_hits(jsonb, jsonb) from anon, authenticated;
revoke all on function workspace._source_rules_eval(text, jsonb, jsonb, text[], text[]) from public;
revoke all on function workspace._source_rules_eval(text, jsonb, jsonb, text[], text[]) from anon, authenticated;
revoke all on function workspace._src_decision_topics(jsonb) from public;
revoke all on function workspace._src_decision_topics(jsonb) from anon, authenticated;
revoke all on function workspace._src_account_value(text, text) from public;
revoke all on function workspace._src_account_value(text, text) from anon, authenticated;
revoke all on function workspace._src_account_for(uuid, text, text, uuid) from public;
revoke all on function workspace._src_account_for(uuid, text, text, uuid) from anon, authenticated;
revoke all on function workspace._src_own_account(uuid, uuid) from public;
revoke all on function workspace._src_own_account(uuid, uuid) from anon, authenticated;
revoke all on function workspace._src_current(uuid) from public;
revoke all on function workspace._src_current(uuid) from anon, authenticated;
revoke all on function workspace._src_live_labels(uuid) from public;
revoke all on function workspace._src_live_labels(uuid) from anon, authenticated;
revoke all on function workspace._src_held(uuid) from public;
revoke all on function workspace._src_held(uuid) from anon, authenticated;
revoke all on function workspace._source_rules_normalize(workspace.source_accounts, jsonb, jsonb, text[]) from public;
revoke all on function workspace._source_rules_normalize(workspace.source_accounts, jsonb, jsonb, text[]) from anon, authenticated;
revoke all on function workspace._src_rules_display(uuid, jsonb, text[]) from public;
revoke all on function workspace._src_rules_display(uuid, jsonb, text[]) from anon, authenticated;
revoke all on function workspace._src_refile(workspace.source_accounts, jsonb, text[]) from public;
revoke all on function workspace._src_refile(workspace.source_accounts, jsonb, text[]) from anon, authenticated;
revoke all on function workspace.source_ingest_plan(text, text, text) from public;
revoke all on function workspace.source_ingest_plan(text, text, text) from anon, authenticated;
grant execute on function workspace.source_ingest_plan(text, text, text) to kb_engine;
revoke all on function workspace.source_candidates_report(text, text, text, jsonb, jsonb, boolean) from public;
revoke all on function workspace.source_candidates_report(text, text, text, jsonb, jsonb, boolean) from anon, authenticated;
grant execute on function workspace.source_candidates_report(text, text, text, jsonb, jsonb, boolean) to kb_engine;
revoke all on function workspace.source_item_record(text, jsonb) from public;
revoke all on function workspace.source_item_record(text, jsonb) from anon, authenticated;
grant execute on function workspace.source_item_record(text, jsonb) to kb_engine;
revoke all on function workspace.app_source_accounts_list(text) from public;
revoke all on function workspace.app_source_accounts_list(text) from anon, authenticated;
grant execute on function workspace.app_source_accounts_list(text) to kb_engine;
revoke all on function workspace.app_source_account_add(text, text, text) from public;
revoke all on function workspace.app_source_account_add(text, text, text) from anon, authenticated;
grant execute on function workspace.app_source_account_add(text, text, text) to kb_engine;
revoke all on function workspace.app_source_rules_get(text, uuid) from public;
revoke all on function workspace.app_source_rules_get(text, uuid) from anon, authenticated;
grant execute on function workspace.app_source_rules_get(text, uuid) to kb_engine;
revoke all on function workspace.app_source_rules_save(text, uuid, jsonb, integer) from public;
revoke all on function workspace.app_source_rules_save(text, uuid, jsonb, integer) from anon, authenticated;
grant execute on function workspace.app_source_rules_save(text, uuid, jsonb, integer) to kb_engine;
revoke all on function workspace.app_source_rules_preview(text, uuid, jsonb) from public;
revoke all on function workspace.app_source_rules_preview(text, uuid, jsonb) from anon, authenticated;
grant execute on function workspace.app_source_rules_preview(text, uuid, jsonb) to kb_engine;
revoke all on function workspace.app_source_rules_history(text, uuid) from public;
revoke all on function workspace.app_source_rules_history(text, uuid) from anon, authenticated;
grant execute on function workspace.app_source_rules_history(text, uuid) to kb_engine;
revoke all on function workspace.app_source_recheck(text, uuid) from public;
revoke all on function workspace.app_source_recheck(text, uuid) from anon, authenticated;
grant execute on function workspace.app_source_recheck(text, uuid) to kb_engine;
revoke all on function workspace.app_source_backfill(text, uuid, timestamptz) from public;
revoke all on function workspace.app_source_backfill(text, uuid, timestamptz) from anon, authenticated;
grant execute on function workspace.app_source_backfill(text, uuid, timestamptz) to kb_engine;
revoke all on function workspace.app_source_sample_request(text, uuid) from public;
revoke all on function workspace.app_source_sample_request(text, uuid) from anon, authenticated;
grant execute on function workspace.app_source_sample_request(text, uuid) to kb_engine;
revoke all on function workspace.app_pages_recheck_list(text) from public;
revoke all on function workspace.app_pages_recheck_list(text) from anon, authenticated;
grant execute on function workspace.app_pages_recheck_list(text) to kb_engine;
revoke all on function workspace.app_page_recheck_done(text, uuid) from public;
revoke all on function workspace.app_page_recheck_done(text, uuid) from anon, authenticated;
grant execute on function workspace.app_page_recheck_done(text, uuid) to kb_engine;
revoke all on function workspace.app_people_rule_counts(text) from public;
revoke all on function workspace.app_people_rule_counts(text) from anon, authenticated;
grant execute on function workspace.app_people_rule_counts(text) to kb_engine;
revoke all on function workspace.curator_candidates(uuid, text[], text, integer) from public;
revoke all on function workspace.curator_candidates(uuid, text[], text, integer) from anon, authenticated;
grant execute on function workspace.curator_candidates(uuid, text[], text, integer) to kb_engine;
revoke all on function workspace.curator_page_save(uuid, jsonb, text) from public;
revoke all on function workspace.curator_page_save(uuid, jsonb, text) from anon, authenticated;
grant execute on function workspace.curator_page_save(uuid, jsonb, text) to kb_engine;

-- Topics are made by administrators only: the admin add is the service's
-- again (it checks the caller is an administrator), the tag switch is not.
grant execute on function workspace.app_topic_add(text, text, text, boolean) to kb_engine;
revoke execute on function workspace.app_source_tag_set(text, uuid, boolean, boolean) from kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from workspace.source_accounts;
-- select account_id, version, jsonb_array_length(rules) from workspace.source_rule_sets;
-- select has_function_privilege('kb_engine',
--   'workspace.app_source_tag_set(text, uuid, boolean, boolean)', 'execute');   -- f


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply 0060 (source_item_record) and 0053 (_page_save_as,
-- curator_candidates, curator_page_save), then:
-- drop index if exists workspace.pages_owner_key_topics_live;
-- create unique index pages_owner_key_live on workspace.pages (owner_principal_id, key)
--   where deleted_at is null;   -- fails if a key now has pages in two topics
-- grant execute on function workspace.app_source_tag_set(text, uuid, boolean, boolean) to kb_engine;
-- revoke execute on function workspace.app_topic_add(text, text, text, boolean) from kb_engine;
-- drop the app_source_*, source_ingest_plan, source_candidates_report,
-- app_pages_recheck_list, app_page_recheck_done, app_people_rule_counts and
-- _src_* functions; alter table source_items/pages drop the added columns;
-- drop table source_candidates, source_rule_audit, source_rule_sets,
-- source_account_labels, source_accounts.
