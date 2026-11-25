-- 0032_issues.sql
--
-- The issue log: one table of problems, reached only through functions.
--
--   * the pullers (kb_ingest) log a failed run with issue_upsert and close it
--     with issue_close_by_key once a run is clean again;
--   * a signed-in person logs a problem through the service (kb_engine) with
--     issue_report;
--   * administrators read a short summary with issues_summary;
--   * issue_set_card / issue_set_status and the view v_support_inbox exist for
--     a support role that a LATER migration creates. Nothing is granted on
--     them here.
--
-- What a row may hold: a category, a source name, an error class and a short
-- redacted message. Never document text, a document title or a participant
-- name. The pullers redact before they call (scripts/knowledge/issues.py);
-- _issue_scrub below is a second net and the length cap.
--
-- `reported_by` is 'system' or a principal handle. Never an email address.

create table if not exists workspace.issues (
    id           uuid        primary key default gen_random_uuid(),
    source       text,
    category     text        not null,
    title        text        not null,
    detail       text,
    error_class  text,
    dedupe_key   text,
    status       text        not null default 'open',
    reported_by  text,
    occurrences  integer     not null default 1,
    opened_at    timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    closed_at    timestamptz,
    card_id      text,
    pr_url       text,
    proof        text,
    constraint issues_category_values check (category in (
        'source_failure', 'data_quality_issue', 'feature_gap',
        'friction_point', 'config_invalid', 'unknown_tag')),
    constraint issues_status_values check (status in (
        'open', 'in_progress', 'fixed_pending_proof', 'closed')),
    constraint issues_reported_by_not_email
        check (reported_by is null or position('@' in reported_by) = 0)
);

comment on table workspace.issues is
    'Issue log. Reached only through SECURITY DEFINER functions. Holds no '
    'document text, titles or participant names.';

-- A repeating failure updates its one open issue instead of opening many.
create unique index if not exists issues_open_dedupe_key
    on workspace.issues (dedupe_key)
    where status <> 'closed';

create index if not exists issues_status_opened_idx
    on workspace.issues (status, opened_at desc);
create index if not exists issues_reported_by_opened_idx
    on workspace.issues (reported_by, opened_at desc);

-- RLS on, no policies: no role reads or writes this table directly.
alter table workspace.issues enable row level security;
revoke all on workspace.issues from public;
revoke all on workspace.issues from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Helpers (no grants: only the functions below call them)
-- ---------------------------------------------------------------------------

-- Second net for free text: drop email addresses and URL query strings, keep
-- one line, cap the length.
create or replace function workspace._issue_scrub(p_text text, p_cap integer)
returns text
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select nullif(left(btrim(
        regexp_replace(
            regexp_replace(
                regexp_replace(p_text, '[^[:space:]<>()"'']+@[^[:space:]<>()"'']+', '[email]', 'g'),
                '(https?://[^[:space:]?#]+)[?#][^[:space:]]*', '\1', 'g'),
            '[[:space:]]+', ' ', 'g')
    ), p_cap), '');
$$;

-- The ACTIVE principal with this verified email, or no row.
create or replace function workspace._active_principal_by_email(p_email text)
returns workspace.principals
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select p.*
    from workspace.principals p
    where p_email is not null
      and length(btrim(p_email)) > 0
      and lower(btrim(p.email)) = lower(btrim(p_email))
      and p.active is true;
$$;

revoke all on function workspace._issue_scrub(text, integer) from public;
revoke all on function workspace._issue_scrub(text, integer) from anon, authenticated;
revoke all on function workspace._active_principal_by_email(text) from public;
revoke all on function workspace._active_principal_by_email(text) from anon, authenticated;


-- ---------------------------------------------------------------------------
-- System issues (pullers)
-- ---------------------------------------------------------------------------

create or replace function workspace.issue_upsert(
    p_category    text,
    p_title       text,
    p_detail      text default null,
    p_source      text default null,
    p_error_class text default null,
    p_dedupe_key  text default null
)
returns uuid
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_id    uuid;
    v_title text := workspace._issue_scrub(p_title, 120);
begin
    if v_title is null then
        raise exception 'issue title is required' using errcode = '22023';
    end if;
    if p_category is null or p_category not in (
        'source_failure', 'data_quality_issue', 'feature_gap',
        'friction_point', 'config_invalid', 'unknown_tag') then
        raise exception 'unknown issue category' using errcode = '22023';
    end if;

    insert into workspace.issues
        (source, category, title, detail, error_class, dedupe_key, reported_by)
    values (
        left(nullif(btrim(p_source), ''), 64),
        p_category,
        v_title,
        workspace._issue_scrub(p_detail, 500),
        left(nullif(btrim(p_error_class), ''), 120),
        left(nullif(btrim(p_dedupe_key), ''), 200),
        'system'
    )
    on conflict (dedupe_key) where status <> 'closed'
    do update set occurrences  = workspace.issues.occurrences + 1,
                  last_seen_at = now(),
                  detail       = excluded.detail,
                  error_class  = excluded.error_class
    returning id into v_id;

    return v_id;
end;
$$;

comment on function workspace.issue_upsert(text, text, text, text, text, text) is
    'Log a system issue. A repeat with the same open dedupe_key bumps '
    'occurrences and last_seen_at on the one open row. Returns the issue id.';


create or replace function workspace.issue_close_by_key(p_dedupe_key text, p_proof text)
returns integer
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_count integer;
begin
    if p_dedupe_key is null or length(btrim(p_dedupe_key)) = 0 then
        raise exception 'dedupe key is required' using errcode = '22023';
    end if;

    update workspace.issues
    set status    = 'closed',
        closed_at = now(),
        proof     = workspace._issue_scrub(p_proof, 500)
    where dedupe_key = btrim(p_dedupe_key)
      and status <> 'closed';

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

comment on function workspace.issue_close_by_key(text, text) is
    'Close the open issue with this dedupe key, recording the proof. Returns '
    'how many rows were closed (0 when none was open).';

revoke all on function workspace.issue_upsert(text, text, text, text, text, text) from public;
revoke all on function workspace.issue_upsert(text, text, text, text, text, text) from anon, authenticated;
revoke all on function workspace.issue_close_by_key(text, text) from public;
revoke all on function workspace.issue_close_by_key(text, text) from anon, authenticated;
grant execute on function workspace.issue_upsert(text, text, text, text, text, text) to kb_ingest;
grant execute on function workspace.issue_close_by_key(text, text) to kb_ingest;


-- ---------------------------------------------------------------------------
-- Issues reported by a signed-in person (service)
-- ---------------------------------------------------------------------------

create or replace function workspace.issue_report(
    p_email    text,
    p_category text,
    p_title    text,
    p_detail   text default null
)
returns uuid
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who   workspace.principals%rowtype;
    v_id    uuid;
    v_title text := btrim(coalesce(p_title, ''));
begin
    -- FAIL CLOSED: an unknown or inactive caller logs nothing.
    v_who := workspace._active_principal_by_email(p_email);
    if v_who.id is null then
        raise exception 'caller is not an active person on this Engine'
            using errcode = '42501';
    end if;

    if p_category is null
       or p_category not in ('data_quality_issue', 'feature_gap', 'friction_point') then
        raise exception 'category must be data_quality_issue, feature_gap or friction_point'
            using errcode = '22023';
    end if;
    if length(v_title) < 5 or length(v_title) > 120 then
        raise exception 'title must be 5 to 120 characters' using errcode = '22023';
    end if;
    if length(coalesce(p_detail, '')) > 1000 then
        raise exception 'detail must be at most 1000 characters' using errcode = '22023';
    end if;

    -- Rate limit: 10 per person per hour. The lock makes the count and the
    -- insert one step, so parallel calls cannot slip past the limit.
    perform pg_advisory_xact_lock(hashtext('kb_issue_report:' || v_who.id::text));
    if (select count(*) from workspace.issues i
        where i.reported_by = v_who.handle
          and i.opened_at > now() - interval '1 hour') >= 10 then
        raise exception 'too many issues reported in the last hour; try again later'
            using errcode = 'KB429';
    end if;

    insert into workspace.issues (category, title, detail, reported_by)
    values (p_category,
            workspace._issue_scrub(v_title, 120),
            workspace._issue_scrub(p_detail, 1000),
            v_who.handle)
    returning id into v_id;

    return v_id;
end;
$$;

comment on function workspace.issue_report(text, text, text, text) is
    'A signed-in person logs a problem. Refuses (42501) unless the verified '
    'email is an active principal; user categories only; 10 per hour (KB429).';

revoke all on function workspace.issue_report(text, text, text, text) from public;
revoke all on function workspace.issue_report(text, text, text, text) from anon, authenticated;
grant execute on function workspace.issue_report(text, text, text, text) to kb_engine;


create or replace function workspace.issues_summary(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
begin
    v_who := workspace._active_principal_by_email(p_email);
    if v_who.id is null or v_who.role <> 'administrator' then
        raise exception 'administrators only' using errcode = '42501';
    end if;

    return jsonb_build_object(
        'open', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', i.id, 'category', i.category, 'source', i.source,
                'title', i.title, 'status', i.status, 'opened_at', i.opened_at,
                'occurrences', i.occurrences, 'has_card', i.card_id is not null)
                order by i.opened_at desc)
            from workspace.issues i
            where i.status <> 'closed'), '[]'::jsonb),
        'fixed_last_30_days', (
            select count(*) from workspace.issues i
            where i.status = 'closed'
              and i.closed_at > now() - interval '30 days')
    );
end;
$$;

comment on function workspace.issues_summary(text) is
    'Administrators only (42501 otherwise): open issues and the number fixed '
    'in the last 30 days.';

revoke all on function workspace.issues_summary(text) from public;
revoke all on function workspace.issues_summary(text) from anon, authenticated;
grant execute on function workspace.issues_summary(text) to kb_engine;


-- ---------------------------------------------------------------------------
-- For the support role (created by a later migration). NO GRANTS HERE.
-- ---------------------------------------------------------------------------

create or replace function workspace.issue_set_card(p_id uuid, p_card_id text)
returns void
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
begin
    if p_card_id is null or btrim(p_card_id) !~ '^[A-Za-z0-9._:-]{1,120}$' then
        raise exception 'card id is not valid' using errcode = '22023';
    end if;

    update workspace.issues set card_id = btrim(p_card_id) where id = p_id;
    if not found then
        raise exception 'issue not found' using errcode = 'P0002';
    end if;
end;
$$;

create or replace function workspace.issue_set_status(
    p_id     uuid,
    p_status text,
    p_pr_url text default null,
    p_proof  text default null
)
returns void
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
begin
    if p_status is null
       or p_status not in ('open', 'in_progress', 'fixed_pending_proof', 'closed') then
        raise exception 'unknown issue status' using errcode = '22023';
    end if;
    if p_pr_url is not null
       and (length(p_pr_url) > 300 or p_pr_url !~ '^https://[A-Za-z0-9./_-]+$') then
        raise exception 'pull request link is not valid' using errcode = '22023';
    end if;

    update workspace.issues
    set status    = p_status,
        pr_url    = coalesce(p_pr_url, pr_url),
        proof     = coalesce(workspace._issue_scrub(p_proof, 500), proof),
        closed_at = case when p_status = 'closed' then now() else null end
    where id = p_id;
    if not found then
        raise exception 'issue not found' using errcode = 'P0002';
    end if;
end;
$$;

revoke all on function workspace.issue_set_card(uuid, text) from public;
revoke all on function workspace.issue_set_card(uuid, text) from anon, authenticated;
revoke all on function workspace.issue_set_status(uuid, text, text, text) from public;
revoke all on function workspace.issue_set_status(uuid, text, text, text) from anon, authenticated;

-- Only these columns ever leave through the support view: no reporter, no
-- pull request link, no proof.
create or replace view workspace.v_support_inbox as
    select i.id, i.category, i.source, i.error_class, i.title, i.detail,
           i.status, i.occurrences, i.opened_at, i.last_seen_at, i.card_id
    from workspace.issues i;

revoke all on workspace.v_support_inbox from public;
revoke all on workspace.v_support_inbox from anon, authenticated;


-- ROLLBACK -------------------------------------------------------------------
-- drop view if exists workspace.v_support_inbox;
-- drop function if exists workspace.issue_set_status(uuid, text, text, text);
-- drop function if exists workspace.issue_set_card(uuid, text);
-- drop function if exists workspace.issues_summary(text);
-- drop function if exists workspace.issue_report(text, text, text, text);
-- drop function if exists workspace.issue_close_by_key(text, text);
-- drop function if exists workspace.issue_upsert(text, text, text, text, text, text);
-- drop function if exists workspace._active_principal_by_email(text);
-- drop function if exists workspace._issue_scrub(text, integer);
-- drop table if exists workspace.issues;
