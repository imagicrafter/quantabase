-- 0072_pipeline_tickets.sql
--
-- Tickets: a problem on the Pipeline, or a step that needs a person, written
-- down once with a readable id (QB-0012), in plain words, until a person
-- closes it.
--
--   pipeline_tickets        one row a ticket
--     ref                   QB-0001, QB-0002, ... (unique, readable)
--     step                  which Pipeline card it belongs to
--     kind / dedupe_key     what raised it; one OPEN ticket per key
--     title, what_happened, what_to_do   plain language for the owner
--     status                open | closed
--     opened_at, last_seen_at
--     cleared_at            the cause went away ("looks fixed since"); the
--                           ticket stays open until a person closes it
--     closed_at, closed_by
--   pipeline_ticket_notes   the history: who wrote what, when
--
-- The tickets open by themselves from the alert sources the screens already
-- read (_tickets_sync, run before every list):
--
--   curator_failed   the curator's latest finished run failed       Author
--   stuck_run        a run stopped renewing its lease              Mailroom
--   timer_failed     a cron job of the timer failed its last run   New mail alert
--   poke_failed      timer pokes are not reaching the Engine       New mail alert
--   budget_warn      this month's spend passed the budget rule     Author
--   budget_switch    the budget rule switched the Author to Budget Author
--   reviews_waiting  changes wait for a person's yes               Publisher
--   held_mail        mail is held because it looked like orders    Mailroom
--
-- The checks run (1) every hour, from the timer's tick (curator_tick_poke,
-- redefined below with the same poke as 0053), (2) at the end of every
-- curator run (curator_tickets_sync, called by the service), and (3) each
-- time someone opens the list. A failing check never stops the poke.
--
-- Nothing closes a ticket automatically. When the cause clears, cleared_at
-- is set; a later return of the cause clears it again.
--
--   app_tickets_list(email, status)     administrators; syncs first
--   app_ticket_get(email, ref)          administrators; with its notes
--   app_ticket_note(email, ref, body)   administrators; adds a note
--   app_ticket_close(email, ref, note)  administrators; a person closes it
--   admin_tickets_list / admin_ticket_get / admin_ticket_note
--                                       the same, for the MCP tools; no close
--
-- Every function: SECURITY DEFINER, fixed search_path, no grant to anon or
-- authenticated. Free text goes through _issue_scrub (0032).

create table if not exists workspace.pipeline_tickets (
    id             bigint      generated always as identity primary key,
    ref            text        generated always as ('QB-' || lpad(id::text, 4, '0')) stored unique,
    step           text        not null,
    kind           text        not null,
    dedupe_key     text        not null,
    title          text        not null,
    what_happened  text        not null,
    what_to_do     text        not null,
    link           text,
    status         text        not null default 'open',
    opened_at      timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    cleared_at     timestamptz,
    closed_at      timestamptz,
    closed_by      text,
    constraint pipeline_tickets_status check (status in ('open', 'closed')),
    constraint pipeline_tickets_step check (step in (
        'subscriptions', 'mailroom', 'new_mail_alert', 'desk_editor', 'archivist',
        'author', 'fact_checker', 'publisher', 'librarian', 'reading_room')),
    constraint pipeline_tickets_closed check ((status = 'closed') = (closed_at is not null))
);

create unique index if not exists pipeline_tickets_open_key
    on workspace.pipeline_tickets (dedupe_key) where status = 'open';
create index if not exists pipeline_tickets_status_idx
    on workspace.pipeline_tickets (status, opened_at desc);

comment on table workspace.pipeline_tickets is
    'Pipeline tickets (QB-0001...): opened by _tickets_sync from the alert sources, closed only by a person.';

alter table workspace.pipeline_tickets enable row level security;
revoke all on workspace.pipeline_tickets from public;
revoke all on workspace.pipeline_tickets from anon, authenticated;

create table if not exists workspace.pipeline_ticket_notes (
    id         bigint      generated always as identity primary key,
    ticket_id  bigint      not null references workspace.pipeline_tickets (id) on delete cascade,
    at         timestamptz not null default now(),
    by         text        not null,
    body       text        not null
);

create index if not exists pipeline_ticket_notes_ticket_idx
    on workspace.pipeline_ticket_notes (ticket_id, at);

alter table workspace.pipeline_ticket_notes enable row level security;
revoke all on workspace.pipeline_ticket_notes from public;
revoke all on workspace.pipeline_ticket_notes from anon, authenticated;

-- ── raise and clear ─────────────────────────────────────────────────────────

-- Open the ticket for this key, or note that its open ticket was seen again
-- (the cause is back, so it no longer looks fixed). Returns the ref.
create or replace function workspace._ticket_raise(
    p_key text, p_kind text, p_step text, p_title text, p_what text, p_todo text, p_link text default null)
returns text
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_ref text;
begin
    update workspace.pipeline_tickets
       set last_seen_at = now(), cleared_at = null,
           what_happened = coalesce(workspace._issue_scrub(p_what, 500), what_happened)
     where dedupe_key = p_key and status = 'open'
     returning ref into v_ref;
    if v_ref is not null then return v_ref; end if;

    insert into workspace.pipeline_tickets
        (step, kind, dedupe_key, title, what_happened, what_to_do, link)
    values (p_step, p_kind, p_key,
            workspace._issue_scrub(p_title, 120),
            coalesce(workspace._issue_scrub(p_what, 500), ''),
            coalesce(workspace._issue_scrub(p_todo, 500), ''),
            p_link)
    on conflict (dedupe_key) where status = 'open' do nothing
    returning ref into v_ref;
    if v_ref is null then
        select ref into v_ref from workspace.pipeline_tickets where dedupe_key = p_key and status = 'open';
    end if;
    return v_ref;
end;
$$;

-- The cause behind every open ticket of this kind (whose key is not in
-- p_keep) has gone: mark them "looks fixed" once.
create or replace function workspace._ticket_clear(p_kind text, p_keep text[] default '{}')
returns void
language sql
volatile
security definer
set search_path = workspace, pg_temp
as $$
    update workspace.pipeline_tickets
       set cleared_at = now()
     where kind = p_kind and status = 'open' and cleared_at is null
       and not (dedupe_key = any (p_keep));
$$;

-- Look at every alert source; raise what is wrong, mark what cleared.
create or replace function workspace._tickets_sync()
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_run   record;
    v_s     workspace.pipeline_settings%rowtype;
    v_spent numeric;
    v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
    v_keep  text[];
    v_held  bigint;
    v_job   jsonb;
    v_key   text;
begin
    -- the curator's latest finished run
    select r.id, r.status, r.stats->>'error' as error, r.started_at into v_run
      from workspace.curator_runs r where r.status in ('ok', 'failed')
     order by r.started_at desc limit 1;
    if found and v_run.status = 'failed' then
        perform workspace._ticket_raise('curator_failed', 'curator_failed', 'author',
            'The curator''s last run failed',
            'The run that started ' || to_char(v_run.started_at at time zone 'utc', 'YYYY-MM-DD HH24:MI') || ' UTC stopped with an error'
                || coalesce(': ' || v_run.error, '') || '. New mail waits in the Mailroom until a run succeeds.',
            'Open Engine > Pipeline and look at the Engine room details. If the next run (within the hour) also fails, ask Claude for help with this ticket.',
            '/setup/pipeline');
    else
        perform workspace._ticket_clear('curator_failed');
    end if;

    -- a run that stopped renewing its lease
    if exists (select 1 from workspace.curator_runs r where r.status = 'running'
               and (r.lease_until < now() - interval '5 minutes' or r.started_at < now() - interval '30 minutes')) then
        perform workspace._ticket_raise('stuck_run', 'stuck_run', 'mailroom',
            'A curator run looks stuck',
            'A run stopped checking in, so the curator may not pick up new mail.',
            'Usually the next run clears it by itself within the hour. If this stays, restart the Engine service.',
            '/setup/timer');
    else
        perform workspace._ticket_clear('stuck_run');
    end if;

    -- the timer's cron jobs
    v_keep := '{}';
    for v_job in select * from jsonb_array_elements(coalesce(workspace._curator_health()->'jobs', '[]'::jsonb)) loop
        if v_job->>'last_status' = 'failed' then
            v_key := 'timer_failed:' || (v_job->>'name');
            v_keep := v_keep || v_key;
            perform workspace._ticket_raise(v_key, 'timer_failed', 'new_mail_alert',
                'The new mail alert failed',
                'The timer job ' || (v_job->>'name') || ' failed its last run'
                    || coalesce(': ' || split_part(v_job->>'last_message', E'\n', 1), '') || '.',
                'Open Engine > Timer and save it again with the curator on. If it still fails, ask Claude for help with this ticket.',
                '/setup/timer');
        end if;
    end loop;
    perform workspace._ticket_clear('timer_failed', v_keep);

    -- timer pokes that did not reach the Engine (3 or more in 24 hours, the
    -- latest in the last 2 hours)
    v_job := workspace._curator_health()->'pokes_24h';
    if jsonb_typeof(v_job) = 'object'
       and coalesce((v_job->>'failed')::integer, 0) >= 3
       and (v_job->>'last_failure_at')::timestamptz > now() - interval '2 hours' then
        perform workspace._ticket_raise('poke_failed', 'poke_failed', 'new_mail_alert',
            'The new mail alert cannot reach the Engine',
            (v_job->>'failed') || ' of ' || coalesce(v_job->>'total', '?') || ' timer pokes in the last 24 hours did not reach the Engine'
                || coalesce(': ' || split_part(v_job->>'last_error', E'\n', 1), '') || '.',
            'Check the Engine is running and its address on Engine > Timer is right. If it still fails, ask Claude for help with this ticket.',
            '/setup/timer');
    else
        perform workspace._ticket_clear('poke_failed');
    end if;

    -- the budget rule, this month
    select * into v_s from workspace.pipeline_settings where id;
    if found then
        v_spent := workspace._month_spend();
        v_key := 'budget_warn:' || v_month;
        if v_spent >= v_s.budget_usd * v_s.budget_pct / 100.0 then
            perform workspace._ticket_raise(v_key, 'budget_warn', 'author',
                'Spending passed the budget rule',
                'This month the curator has spent $' || to_char(v_spent, 'FM999990.00') || ' of the $'
                    || to_char(v_s.budget_usd, 'FM999990.00') || ' budget (the rule acts at ' || v_s.budget_pct || '%).',
                'Open Engine > Ledger. Raise the budget, or set the Author to Budget on the Pipeline screen.',
                '/setup/ledger');
            perform workspace._ticket_clear('budget_warn', array[v_key]);
        else
            perform workspace._ticket_clear('budget_warn');
        end if;
        v_key := 'budget_switch:' || v_month;
        if v_s.budget_switched_month = date_trunc('month', now() at time zone 'utc')::date
           and exists (select 1 from workspace.curator_settings c where c.id and c.writer_model = 'anthropic-claude-5.5-haiku') then
            perform workspace._ticket_raise(v_key, 'budget_switch', 'author',
                'The budget rule switched the Author to Budget',
                'Spending reached the budget rule, so the Author now writes with the Budget model for the rest of the month.',
                'If that is fine, close this ticket. To switch back, choose Best on the Author card.',
                '/setup/pipeline');
            perform workspace._ticket_clear('budget_switch', array[v_key]);
        else
            perform workspace._ticket_clear('budget_switch');
        end if;
    end if;

    -- changes waiting for a person's yes
    select count(*) into v_held from workspace.curator_reviews r where r.status = 'pending';
    if v_held > 0 then
        perform workspace._ticket_raise('reviews_waiting', 'reviews_waiting', 'publisher',
            'Changes are waiting for your yes',
            v_held || case when v_held = 1 then ' change waits' else ' changes wait' end
                || ' for a person to approve before the Publisher saves it.',
            'Open Changes to approve, read each one, then say yes or no.',
            '/app/reviews');
    else
        perform workspace._ticket_clear('reviews_waiting');
    end if;

    -- held mail
    select count(*) into v_held from workspace.source_items s
     where s.flagged is true and s.released_at is null and s.curated_at is null and s.deleted_at is null;
    if v_held > 0 then
        perform workspace._ticket_raise('held_mail', 'held_mail', 'mailroom',
            'Mail is held for you',
            v_held || case when v_held = 1 then ' item looks' else ' items look' end
                || ' like it was giving orders, so the curator held it and did nothing with it.',
            'Open Held mail, read each item, then release it or discard it.',
            '/app/flagged');
    else
        perform workspace._ticket_clear('held_mail');
    end if;
end;
$$;

-- The service, at the end of each curator run.
create or replace function workspace.curator_tickets_sync()
returns void
language sql
volatile
security definer
set search_path = workspace, pg_temp
as $$ select workspace._tickets_sync(); $$;

-- The hourly tick (0053's body, unchanged) now also runs the ticket checks
-- first. The cron command is the same, so no job needs rescheduling.
create or replace function workspace.curator_tick_poke(p_mode text default 'tick')
returns bigint
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_url    text := (select s.engine_url from workspace.curator_settings s where s.id);
    v_secret text := workspace._curator_vault_secret('kbe_tick_secret');
    v_id     bigint;
begin
    if p_mode is distinct from 'batch' then
        begin
            perform workspace._tickets_sync();
        exception when others then
            raise warning 'ticket checks failed: %', sqlerrm;
        end;
    end if;
    if v_url is null or v_secret is null or to_regprocedure(
        'net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
        return null;
    end if;
    execute 'select net.http_post(url := $1, body := $2, params := ''{}''::jsonb, '
            'headers := $3, timeout_milliseconds := 5000)'
        into v_id
        using v_url,
              jsonb_build_object('mode', case when p_mode = 'batch' then 'batch' else 'tick' end),
              jsonb_build_object('Content-Type', 'application/json', 'X-Kbe-Tick', v_secret);
    return v_id;
end;
$$;

-- ── read and act (administrators) ───────────────────────────────────────────

create or replace function workspace._ticket_json(t workspace.pipeline_tickets)
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object('ref', t.ref, 'step', t.step, 'kind', t.kind, 'title', t.title,
        'what_happened', t.what_happened, 'what_to_do', t.what_to_do, 'link', t.link,
        'status', t.status, 'opened_at', t.opened_at, 'last_seen_at', t.last_seen_at,
        'cleared_at', t.cleared_at, 'closed_at', t.closed_at, 'closed_by', t.closed_by);
$$;

create or replace function workspace.app_tickets_list(p_email text, p_status text default 'open')
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._admin_require(p_email);
    if p_status is not null and p_status not in ('open', 'closed') then
        raise exception 'status is open or closed' using errcode = '22023';
    end if;
    perform workspace._tickets_sync();
    return coalesce((select jsonb_agg(workspace._ticket_json(t) order by t.opened_at desc, t.id desc)
                     from (select * from workspace.pipeline_tickets t
                            where p_status is null or t.status = p_status
                            order by t.opened_at desc, t.id desc limit 200) t), '[]'::jsonb);
end;
$$;

create or replace function workspace.app_ticket_get(p_email text, p_ref text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_t workspace.pipeline_tickets%rowtype;
begin
    perform workspace._admin_require(p_email);
    select * into v_t from workspace.pipeline_tickets where ref = upper(btrim(p_ref));
    if not found then return null; end if;
    return workspace._ticket_json(v_t) || jsonb_build_object('notes',
        coalesce((select jsonb_agg(jsonb_build_object('at', n.at, 'by', n.by, 'body', n.body) order by n.at, n.id)
                  from workspace.pipeline_ticket_notes n where n.ticket_id = v_t.id), '[]'::jsonb));
end;
$$;

create or replace function workspace.app_ticket_note(p_email text, p_ref text, p_body text)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype;
    v_id   bigint;
    v_body text := workspace._issue_scrub(p_body, 2000);
begin
    v_who := workspace._admin_require(p_email);
    if v_body is null then raise exception 'a note needs some text' using errcode = '22023'; end if;
    select id into v_id from workspace.pipeline_tickets where ref = upper(btrim(p_ref));
    if v_id is null then return false; end if;
    insert into workspace.pipeline_ticket_notes (ticket_id, by, body)
    values (v_id, lower(btrim(v_who.email)), v_body);
    return true;
end;
$$;

-- A person closes a ticket (with an optional note). False when there is no
-- such open ticket.
create or replace function workspace.app_ticket_close(p_email text, p_ref text, p_note text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype;
    v_id   bigint;
    v_by   text;
    v_note text := workspace._issue_scrub(p_note, 2000);
begin
    v_who := workspace._admin_require(p_email);
    v_by := lower(btrim(v_who.email));
    update workspace.pipeline_tickets
       set status = 'closed', closed_at = now(), closed_by = v_by
     where ref = upper(btrim(p_ref)) and status = 'open'
     returning id into v_id;
    if v_id is null then return false; end if;
    insert into workspace.pipeline_ticket_notes (ticket_id, by, body)
    values (v_id, v_by, coalesce('Closed: ' || v_note, 'Closed.'));
    return true;
end;
$$;

-- ── for Claude (MCP tools list_tickets, get_ticket, add_ticket_note) ────────
-- The MCP side never calls app_* functions (the app/MCP boundary), so it has
-- its own names. There is deliberately no close here: closing is a person's
-- action in the app.

create or replace function workspace.admin_tickets_list(p_email text, p_status text default 'open')
returns jsonb language sql volatile security definer set search_path = workspace, pg_temp
as $$ select workspace.app_tickets_list(p_email, p_status); $$;

create or replace function workspace.admin_ticket_get(p_email text, p_ref text)
returns jsonb language sql stable security definer set search_path = workspace, pg_temp
as $$ select workspace.app_ticket_get(p_email, p_ref); $$;

create or replace function workspace.admin_ticket_note(p_email text, p_ref text, p_body text)
returns boolean language sql volatile security definer set search_path = workspace, pg_temp
as $$ select workspace.app_ticket_note(p_email, p_ref, p_body); $$;

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._ticket_raise(text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function workspace._ticket_clear(text, text[]) from public, anon, authenticated;
revoke all on function workspace._tickets_sync() from public, anon, authenticated;
revoke all on function workspace._ticket_json(workspace.pipeline_tickets) from public, anon, authenticated;
revoke all on function workspace.app_tickets_list(text, text) from public, anon, authenticated;
revoke all on function workspace.app_ticket_get(text, text) from public, anon, authenticated;
revoke all on function workspace.app_ticket_note(text, text, text) from public, anon, authenticated;
revoke all on function workspace.app_ticket_close(text, text, text) from public, anon, authenticated;
grant execute on function workspace.app_tickets_list(text, text) to kb_engine;
grant execute on function workspace.app_ticket_get(text, text) to kb_engine;
grant execute on function workspace.app_ticket_note(text, text, text) to kb_engine;
grant execute on function workspace.app_ticket_close(text, text, text) to kb_engine;
revoke all on function workspace.curator_tickets_sync() from public, anon, authenticated;
grant execute on function workspace.curator_tickets_sync() to kb_engine;
revoke all on function workspace.curator_tick_poke(text) from public, anon, authenticated;
revoke all on function workspace.admin_tickets_list(text, text) from public, anon, authenticated;
revoke all on function workspace.admin_ticket_get(text, text) from public, anon, authenticated;
revoke all on function workspace.admin_ticket_note(text, text, text) from public, anon, authenticated;
grant execute on function workspace.admin_tickets_list(text, text) to kb_engine;
grant execute on function workspace.admin_ticket_get(text, text) to kb_engine;
grant execute on function workspace.admin_ticket_note(text, text, text) to kb_engine;

-- Undo:
--   drop function workspace.admin_ticket_note(text, text, text), workspace.admin_ticket_get(text, text),
--     workspace.admin_tickets_list(text, text);
--   drop function workspace.app_ticket_close(text, text, text), workspace.app_ticket_note(text, text, text),
--     workspace.app_ticket_get(text, text), workspace.app_tickets_list(text, text),
--     workspace._ticket_json(workspace.pipeline_tickets), workspace._tickets_sync(),
--     workspace._ticket_clear(text, text[]),
--     workspace._ticket_raise(text, text, text, text, text, text, text);
--   drop function workspace.curator_tickets_sync();
--   re-apply 0053's curator_tick_poke (the same body without the ticket checks);
--   drop table workspace.pipeline_ticket_notes, workspace.pipeline_tickets;
