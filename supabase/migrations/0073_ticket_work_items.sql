-- 0073_ticket_work_items.sql
--
-- Two kinds of Pipeline ticket (0072):
--
--   work items   reviews_waiting (changes wait for a yes), held_mail
--                These are to-dos, not faults. When the queue is empty the
--                ticket closes by itself, with the note "Closed by itself:
--                nothing left waiting" (closed_by 'the Engine').
--   faults       curator_failed, stuck_run, timer_failed, poke_failed,
--                budget_warn, budget_switch, and new here: items_failed
--                (items the curator gave up on)
--                Unchanged: when the cause clears the ticket "looks fixed"
--                and a person closes it.
--
-- Only _ticket_clear changes (same signature); _tickets_sync already calls it
-- for every kind. Open work-item tickets that already look fixed are closed
-- here once.

create or replace function workspace._ticket_is_work_item(p_kind text)
returns boolean
language sql
immutable
set search_path = workspace, pg_temp
as $$ select p_kind in ('reviews_waiting', 'held_mail'); $$;

create or replace function workspace._ticket_clear(p_kind text, p_keep text[] default '{}')
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    if workspace._ticket_is_work_item(p_kind) then
        with closed as (
            update workspace.pipeline_tickets
               set status = 'closed', closed_at = now(), closed_by = 'the Engine',
                   cleared_at = coalesce(cleared_at, now())
             where kind = p_kind and status = 'open'
               and not (dedupe_key = any (p_keep))
            returning id)
        insert into workspace.pipeline_ticket_notes (ticket_id, by, body)
        select id, 'the Engine', 'Closed by itself: nothing left waiting.' from closed;
        return;
    end if;
    update workspace.pipeline_tickets
       set cleared_at = now()
     where kind = p_kind and status = 'open' and cleared_at is null
       and not (dedupe_key = any (p_keep));
end;
$$;

-- _tickets_sync: 0072's checks, unchanged, plus failed items (a fault: a
-- person closes it).
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

    -- items the curator gave up on (0073)
    select count(*) into v_held from workspace.source_items s
     where s.deleted_at is null and s.curator_outcome = 'failed';
    if v_held > 0 then
        perform workspace._ticket_raise('items_failed', 'items_failed', 'author',
            'Some items could not be turned into pages',
            v_held || case when v_held = 1 then ' item' else ' items' end
                || ' failed after the curator tried several times, so nothing from them is on a page yet.',
            'Open Engine > Pipeline, then Details for experts, to see each item and its last error. If you are not sure what to do, ask Claude for help with this ticket.',
            '/setup/pipeline');
    else
        perform workspace._ticket_clear('items_failed');
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

revoke all on function workspace._tickets_sync() from public, anon, authenticated;
revoke all on function workspace._ticket_is_work_item(text) from public, anon, authenticated;
revoke all on function workspace._ticket_clear(text, text[]) from public, anon, authenticated;

-- Once: work-item tickets left open with their queue already empty.
with closed as (
    update workspace.pipeline_tickets
       set status = 'closed', closed_at = now(), closed_by = 'the Engine'
     where status = 'open' and cleared_at is not null
       and workspace._ticket_is_work_item(kind)
    returning id)
insert into workspace.pipeline_ticket_notes (ticket_id, by, body)
select id, 'the Engine', 'Closed by itself: nothing left waiting.' from closed;

-- Undo: re-apply 0072's _ticket_clear and _tickets_sync; drop function workspace._ticket_is_work_item(text);
