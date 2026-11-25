-- 0075_cataloguer_index_clerk.sql
--
-- Two new Pipeline cards for the step after publishing (curator run.ts,
-- writeSummaries): the Cataloguer writes each page's short summary, and the
-- Index clerk files it into the search index (the 384-dim embedding).
--
--   pipeline_settings.summary_length   short | standard (default standard)
--                                      one line in the summary prompt; owner
--                                      only, logged like every other choice
--   pipeline_tickets.step              adds 'cataloguer' and 'index_clerk'
--   _tickets_sync                      0073's checks, plus two faults read
--                                      from the latest run that wrote
--                                      summaries:
--       summary_failed   Cataloguer    the model's summary was unusable
--       index_failed     Index clerk   the summary could not be filed
--                                      (embedding or write failed)
--                                      A big backlog is not a fault.
--   app_pipeline_get                   0071's, plus the summary choice and the
--                                      two cards' counts, model and cost
--   app_pipeline_set                   0071's, plus summary_length
--   curator_pipeline_get               0071's, plus summary_length
--   app_ledger                         0071's; each day also has
--                                      cataloguer_usd (run stat usd_summaries),
--                                      taken out of the Author and "other"
--   _pages_search_core                 the one page search; the MCP search
--                                      (pages_search_by_oauth_subject) and the
--                                      app's try-a-search box both call it
--   app_index_search(email, q, emb, n) administrators; the pages THAT person
--                                      may see, as their MCP search would
--   app_summaries_redo_preview(email)  administrators: how many pages, the
--                                      summary model, observed cost a summary
--   app_summaries_redo(email)          the Engine owner: re-queue every live
--                                      page (summary_queued_at); the normal
--                                      run does the work; logged
--
-- Every function: SECURITY DEFINER, fixed search_path, no grant to anon or
-- authenticated.

-- ── the setting ─────────────────────────────────────────────────────────────

alter table workspace.pipeline_settings
    add column if not exists summary_length text not null default 'standard';

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'pipeline_settings_summary_length') then
        alter table workspace.pipeline_settings
            add constraint pipeline_settings_summary_length check (summary_length in ('short', 'standard'));
    end if;
end;
$$;

-- ── the two new steps ───────────────────────────────────────────────────────

alter table workspace.pipeline_tickets drop constraint if exists pipeline_tickets_step;
alter table workspace.pipeline_tickets add constraint pipeline_tickets_step check (step in (
    'subscriptions', 'mailroom', 'new_mail_alert', 'desk_editor', 'archivist',
    'author', 'fact_checker', 'publisher', 'cataloguer', 'index_clerk',
    'librarian', 'reading_room'));

-- ── helpers ─────────────────────────────────────────────────────────────────

-- The latest finished run that worked on summaries: its counts.
create or replace function workspace._summary_run()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object(
        'started_at', r.started_at,
        'summaries', coalesce((r.stats->>'summaries')::numeric, 0),
        'summary_failed', coalesce((r.stats->>'summary_failed')::numeric, 0),
        'index_failed', coalesce((r.stats->>'index_failed')::numeric, 0))
    from workspace.curator_runs r
    where r.status in ('ok', 'failed')
      and (r.stats ? 'summaries' or r.stats ? 'summary_failed' or r.stats ? 'index_failed'
           or r.stats ? 'summary_raced')
    order by r.started_at desc
    limit 1;
$$;

-- The Cataloguer's model (the latest run's, else the curator's) and its cost
-- over the last 30 days (run stat usd_summaries).
create or replace function workspace._cataloguer_cost()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object(
        'model', coalesce(
            (select r.stats->>'summary_model' from workspace.curator_runs r
             where r.stats ? 'summary_model' order by r.started_at desc limit 1),
            (select c.model from workspace.curator_settings c where c.id)),
        'usd_30d', (select round(coalesce(sum((r.stats->>'usd_summaries')::numeric), 0), 4)
                    from workspace.curator_runs r
                    where r.started_at >= now() - interval '30 days'
                      and jsonb_typeof(r.stats->'usd_summaries') = 'number'),
        'summaries_30d', (select coalesce(sum((r.stats->>'summaries')::numeric + coalesce((r.stats->>'summary_failed')::numeric, 0)
                                              + coalesce((r.stats->>'index_failed')::numeric, 0)), 0)
                          from workspace.curator_runs r
                          where r.started_at >= now() - interval '30 days'
                            and jsonb_typeof(r.stats->'usd_summaries') = 'number'
                            and jsonb_typeof(r.stats->'summaries') = 'number'));
$$;

-- ── read (administrators): 0071's, plus the two new cards ───────────────────

create or replace function workspace.app_pipeline_get(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
    v_s   workspace.pipeline_settings%rowtype;
    v_c   workspace.curator_settings%rowtype;
    v_since timestamptz := workspace._month_start();
    v_cost jsonb;
begin
    v_who := workspace._admin_require(p_email);
    v_cost := workspace._cataloguer_cost();
    select * into v_s from workspace.pipeline_settings where id;
    select * into v_c from workspace.curator_settings where id;
    return jsonb_build_object(
        'is_owner', lower(btrim(v_who.email)) is not distinct from workspace._engine_owner_email(),
        'settings', jsonb_build_object(
            'author', case when v_c.writer_model = 'anthropic-claude-5.5-haiku' then 'budget' else 'best' end,
            'desk_editor', v_s.desk_editor,
            'archivist_bar', v_s.archivist_bar,
            'publisher_ask', v_s.publisher_ask,
            'stale_days', v_s.stale_days,
            'summary_length', v_s.summary_length,
            'paused_until', case when v_s.paused_until > now() then v_s.paused_until end),
        'curator_on', v_c.enabled,
        'writer_model', v_c.writer_model,
        'triage_model', v_c.triage_model,
        'changes', workspace._pipeline_last_changes(),
        'last_run', (select jsonb_build_object('started_at', r.started_at, 'status', r.status)
                     from workspace.curator_runs r order by r.started_at desc limit 1),
        'items_waiting', (select count(*) from workspace.source_items s
                          where s.curated_at is null and s.deleted_at is null
                            and s.flagged is not true),
        'items_flagged', (select count(*) from workspace.source_items s
                          where s.flagged is true and s.released_at is null
                            and s.curated_at is null and s.deleted_at is null),
        'items_in_month', (select count(*) from workspace.source_items s
                           where s.received_at >= v_since),
        'skipped_month', (select coalesce(sum((r.stats->>'triage_no_change')::numeric), 0)
                          from workspace.curator_runs r
                          where r.started_at >= v_since and jsonb_typeof(r.stats->'triage_no_change') = 'number'),
        'reviews_pending', (select count(*) from workspace.curator_reviews r where r.status = 'pending'),
        'duplicates_open', (select count(*) from workspace.page_duplicates d where d.status = 'open'),
        'pages', (select count(*) from workspace.pages p where p.deleted_at is null),
        'pages_stale', (select count(*) from workspace.pages p
                        where p.deleted_at is null
                          and p.updated_at < now() - make_interval(days => v_s.stale_days)),
        -- the Cataloguer and the Index clerk (0075)
        'summaries_pending', (select count(*) from workspace.pages p
                              where p.deleted_at is null and p.summary_queued_at is not null),
        'pages_indexed', (select count(*) from workspace.pages p
                          where p.deleted_at is null and p.embedding is not null),
        'index_missing', (select count(*) from workspace.pages p
                          where p.deleted_at is null and p.embedding is null and p.summary_queued_at is null),
        'summary_run', coalesce(workspace._summary_run(), '{}'::jsonb),
        'summary_model', v_cost->>'model',
        'summary_usd_30d', (v_cost->>'usd_30d')::numeric);
end;
$$;

-- ── change (the Engine owner only): 0071's, plus summary_length ─────────────

create or replace function workspace.app_pipeline_set(p_email text, p_setting text, p_value text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
    v_old text;
    v_new text := btrim(coalesce(p_value, ''));
    v_by  text;
begin
    v_who := workspace._admin_require(p_email);
    v_by := lower(btrim(v_who.email));
    if v_by is distinct from workspace._engine_owner_email() then
        raise exception 'only the Engine owner changes these' using errcode = '42501';
    end if;

    if p_setting = 'author' then
        if v_new not in ('best', 'budget') then raise exception 'not a choice' using errcode = '22023'; end if;
        select case when writer_model = 'anthropic-claude-5.5-haiku' then 'budget' else 'best' end
          into v_old from workspace.curator_settings where id;
        update workspace.curator_settings
           set writer_model = case v_new when 'budget' then 'anthropic-claude-5.5-haiku'
                                         else 'anthropic-claude-sonnet-5.5' end,
               updated_at = now()
         where id;
    elsif p_setting = 'desk_editor' then
        if v_new not in ('keep_more', 'normal', 'keep_less') then raise exception 'not a choice' using errcode = '22023'; end if;
        select desk_editor into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set desk_editor = v_new, updated_at = now() where id;
    elsif p_setting = 'archivist_bar' then
        if v_new not in ('rarely_new', 'normal') then raise exception 'not a choice' using errcode = '22023'; end if;
        select archivist_bar into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set archivist_bar = v_new, updated_at = now() where id;
    elsif p_setting = 'publisher_ask' then
        if v_new not in ('never', 'big_changes') then raise exception 'not a choice' using errcode = '22023'; end if;
        select publisher_ask into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set publisher_ask = v_new, updated_at = now() where id;
    elsif p_setting = 'stale_days' then
        if v_new not in ('60', '90', '180') then raise exception 'not a choice' using errcode = '22023'; end if;
        select stale_days::text into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set stale_days = v_new::integer, updated_at = now() where id;
    elsif p_setting = 'summary_length' then
        if v_new not in ('short', 'standard') then raise exception 'not a choice' using errcode = '22023'; end if;
        select summary_length into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set summary_length = v_new, updated_at = now() where id;
    elsif p_setting = 'pause' then
        if v_new not in ('pause', 'resume') then raise exception 'not a choice' using errcode = '22023'; end if;
        select case when paused_until > now() then 'pause' else 'resume' end into v_old
          from workspace.pipeline_settings where id;
        update workspace.pipeline_settings
           set paused_until = case v_new when 'pause' then now() + interval '24 hours' end,
               updated_at = now()
         where id;
    elsif p_setting = 'budget_usd' then
        if v_new !~ '^[0-9]{1,5}(\.[0-9]{1,2})?$' or v_new::numeric < 1 or v_new::numeric > 10000 then
            raise exception 'a budget is 1 to 10000 dollars' using errcode = '22023';
        end if;
        select budget_usd::text into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set budget_usd = v_new::numeric, updated_at = now() where id;
    elsif p_setting = 'budget_pct' then
        if v_new not in ('50', '75', '80', '90', '100') then raise exception 'not a choice' using errcode = '22023'; end if;
        select budget_pct::text into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set budget_pct = v_new::integer, updated_at = now() where id;
    elsif p_setting = 'budget_action' then
        if v_new not in ('warn', 'switch') then raise exception 'not a choice' using errcode = '22023'; end if;
        select budget_action into v_old from workspace.pipeline_settings where id;
        update workspace.pipeline_settings set budget_action = v_new, updated_at = now() where id;
    else
        raise exception 'no such setting' using errcode = '22023';
    end if;

    if v_old is distinct from v_new then
        insert into workspace.pipeline_settings_log (changed_by, setting, old_value, new_value)
        values (v_by, p_setting, v_old, v_new);
    end if;
    return jsonb_build_object('setting', p_setting, 'value', v_new, 'changed', v_old is distinct from v_new);
end;
$$;

-- ── the ledger: 0071's, with the Cataloguer as its own line ─────────────────
-- The Author's share is usd:<writer_model>, less the summaries when the
-- summary model is the writer model (the same per-model key holds both).

create or replace function workspace.app_ledger(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
    v_s   workspace.pipeline_settings%rowtype;
    v_since timestamptz := workspace._month_start();
begin
    v_who := workspace._admin_require(p_email);
    select * into v_s from workspace.pipeline_settings where id;
    return jsonb_build_object(
        'is_owner', lower(btrim(v_who.email)) is not distinct from workspace._engine_owner_email(),
        'since', v_since,
        'now', now(),
        'spent_usd', round(workspace._month_spend(), 4),
        'budget_usd', v_s.budget_usd,
        'budget_pct', v_s.budget_pct,
        'budget_action', v_s.budget_action,
        'switched_this_month', v_s.budget_switched_month = (v_since at time zone 'utc')::date,
        'writer_model', (select c.writer_model from workspace.curator_settings c where c.id),
        'items_in', (select count(*) from workspace.source_items s where s.received_at >= v_since),
        'items_done', (select coalesce(sum((r.stats->>'items')::numeric), 0) from workspace.curator_runs r
                       where r.started_at >= v_since and jsonb_typeof(r.stats->'items') = 'number'
                         and jsonb_typeof(r.stats->'usd') = 'number'),
        'items_skipped', (select coalesce(sum((r.stats->>'triage_no_change')::numeric), 0) from workspace.curator_runs r
                          where r.started_at >= v_since and jsonb_typeof(r.stats->'triage_no_change') = 'number'),
        'cataloguer_usd', (select round(coalesce(sum((r.stats->>'usd_summaries')::numeric), 0), 4) from workspace.curator_runs r
                           where r.started_at >= v_since and jsonb_typeof(r.stats->'usd_summaries') = 'number'
                             and jsonb_typeof(r.stats->'usd') = 'number'),
        'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day,
                                                              'author_usd', round(greatest(d.author, 0), 4),
                                                              'cataloguer_usd', round(d.cataloguer, 4),
                                                              'other_usd', round(greatest(d.total - greatest(d.author, 0) - d.cataloguer, 0), 4))
                                           order by d.day), '[]'::jsonb)
                 from (select (r.started_at at time zone 'utc')::date as day,
                              sum((r.stats->>'usd')::numeric) as total,
                              sum(case when jsonb_typeof(r.stats->'usd_summaries') = 'number'
                                       then (r.stats->>'usd_summaries')::numeric else 0 end) as cataloguer,
                              sum((case when jsonb_typeof(r.stats->('usd:' || coalesce(r.stats->>'writer_model', ''))) = 'number'
                                        then (r.stats->>('usd:' || (r.stats->>'writer_model')))::numeric else 0 end)
                                  - (case when r.stats->>'summary_model' = r.stats->>'writer_model'
                                               and jsonb_typeof(r.stats->'usd_summaries') = 'number'
                                          then (r.stats->>'usd_summaries')::numeric else 0 end)) as author
                       from workspace.curator_runs r
                       where r.started_at >= v_since and jsonb_typeof(r.stats->'usd') = 'number'
                       group by 1) d),
        'changes', (select coalesce(jsonb_agg(jsonb_build_object('at', l.changed_at, 'by', l.changed_by, 'setting', l.setting,
                                                                 'old', l.old_value, 'new', l.new_value) order by l.changed_at), '[]'::jsonb)
                    from workspace.pipeline_settings_log l where l.changed_at >= v_since));
end;
$$;

-- ── the curator (kb_engine): 0071's, plus summary_length ────────────────────

create or replace function workspace.curator_pipeline_get()
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_s     workspace.pipeline_settings%rowtype;
    v_month date := (workspace._month_start() at time zone 'utc')::date;
    v_spend numeric;
    v_writer text;
begin
    select * into v_s from workspace.pipeline_settings where id for update;
    v_spend := workspace._month_spend();
    select writer_model into v_writer from workspace.curator_settings where id;
    if v_s.budget_action = 'switch'
       and v_s.budget_switched_month is distinct from v_month
       and v_spend >= v_s.budget_usd * v_s.budget_pct / 100.0
       and v_writer is distinct from 'anthropic-claude-5.5-haiku' then
        update workspace.curator_settings set writer_model = 'anthropic-claude-5.5-haiku', updated_at = now() where id;
        update workspace.pipeline_settings set budget_switched_month = v_month where id;
        insert into workspace.pipeline_settings_log (changed_by, setting, old_value, new_value)
        values ('budget rule', 'author', 'best', 'budget');
    end if;
    return jsonb_build_object(
        'desk_editor', v_s.desk_editor,
        'archivist_bar', v_s.archivist_bar,
        'publisher_ask', v_s.publisher_ask,
        'summary_length', v_s.summary_length,
        'paused', coalesce(v_s.paused_until > now(), false));
end;
$$;

-- ── tickets: 0073's checks, plus the two new faults ─────────────────────────

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
    v_sum   jsonb;
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

    -- summaries and the search index (0075): the latest run that wrote
    -- summaries. Those pages stay queued and are tried again, so a backlog
    -- alone is never a fault; and once no page waits (the failing ones were
    -- written, deleted or saved again), the cause is gone.
    v_sum := case when exists (select 1 from workspace.pages p
                               where p.deleted_at is null and p.summary_queued_at is not null)
                  then coalesce(workspace._summary_run(), '{}'::jsonb) else '{}'::jsonb end;
    if coalesce((v_sum->>'summary_failed')::numeric, 0) > 0 then
        perform workspace._ticket_raise('summary_failed', 'summary_failed', 'cataloguer',
            'Some page summaries could not be written',
            'The run that started ' || to_char((v_sum->>'started_at')::timestamptz at time zone 'utc', 'YYYY-MM-DD HH24:MI')
                || ' UTC could not write ' || (v_sum->>'summary_failed')
                || case when (v_sum->>'summary_failed')::numeric = 1 then ' summary' else ' summaries' end
                || '. Those pages keep their old summary and are tried again on the next run.',
            'If the next run also fails, open Engine > Pipeline, then Details for experts, to see the summary model. If you are not sure what to do, ask Claude for help with this ticket.',
            '/setup/pipeline');
    else
        perform workspace._ticket_clear('summary_failed');
    end if;
    if coalesce((v_sum->>'index_failed')::numeric, 0) > 0 then
        perform workspace._ticket_raise('index_failed', 'index_failed', 'index_clerk',
            'Some pages could not be filed in the search index',
            'The run that started ' || to_char((v_sum->>'started_at')::timestamptz at time zone 'utc', 'YYYY-MM-DD HH24:MI')
                || ' UTC wrote a summary but could not file ' || (v_sum->>'index_failed')
                || case when (v_sum->>'index_failed')::numeric = 1 then ' page' else ' pages' end
                || ' in the search index, so Claude may not find them yet. They are tried again on the next run.',
            'If the next run also fails, the search model may be down: check Engine > Health. If you are not sure what to do, ask Claude for help with this ticket.',
            '/setup/pipeline');
    else
        perform workspace._ticket_clear('index_failed');
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

-- ── one page search, for the MCP tool and the try-a-search box ─────────────
-- The body is 0050's pages_search_by_oauth_subject, unchanged, with the caller
-- already resolved.

create or replace function workspace._pages_search_core(
    p_principal     uuid,
    p_granted       text[],
    query_text      text,
    query_embedding vector(384),
    match_count     integer default 10
)
returns table (
    id            uuid,
    owner_handle  text,
    is_own        boolean,
    drawer        text,
    key           text,
    title         text,
    description   text,
    distillation  text,
    fields        jsonb,
    updated_at    timestamptz,
    score         double precision
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_granted   text[]  := coalesce(p_granted, array[]::text[]);
    v_query     tsquery := websearch_to_tsquery('english', coalesce(query_text, ''));
    v_count     integer := greatest(1, least(coalesce(match_count, 10), 50));
begin
    if p_principal is null then
        return;
    end if;

    return query
    with visible as (
        select p.*
        from workspace.pages p
        where p.deleted_at is null
          and workspace._page_visible(p.owner_principal_id, p.topics, v_granted, p_principal)
    ),
    kw as (
        select v.id as page_id,
               row_number() over (order by ts_rank_cd(v.tsv, v_query) desc) as rnk
        from visible v
        where v.tsv @@ v_query
        order by ts_rank_cd(v.tsv, v_query) desc
        limit 200
    ),
    vec as (
        select v.id as page_id,
               row_number() over (order by v.embedding <=> query_embedding) as rnk
        from visible v
        where v.embedding is not null and query_embedding is not null
        order by v.embedding <=> query_embedding
        limit 200
    ),
    fused as (
        select coalesce(k.page_id, x.page_id) as page_id,
               coalesce(1.0::double precision / (60 + k.rnk), 0.0)
             + coalesce(1.0::double precision / (60 + x.rnk), 0.0) as rrf
        from kw k
        full outer join vec x on x.page_id = k.page_id
    )
    select p.id, o.handle, p.owner_principal_id = p_principal, p.drawer, p.key,
           p.title, p.description, p.distillation, p.fields, p.updated_at, f.rrf
    from fused f
    join workspace.pages p on p.id = f.page_id
    join workspace.principals o on o.id = p.owner_principal_id
    order by f.rrf desc
    limit v_count * 3;
end;
$$;

create or replace function workspace.pages_search_by_oauth_subject(
    p_oauth_subject text,
    query_text      text,
    query_embedding vector(384),
    match_count     integer default 10
)
returns table (
    id            uuid,
    owner_handle  text,
    is_own        boolean,
    drawer        text,
    key           text,
    title         text,
    description   text,
    distillation  text,
    fields        jsonb,
    updated_at    timestamptz,
    score         double precision
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
begin
    if v_principal is null then
        return;
    end if;
    return query
    select * from workspace._pages_search_core(
        v_principal,
        coalesce(workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]),
        query_text, query_embedding, match_count);
end;
$$;

-- The Index clerk's try-a-search box: administrators only (the Pipeline
-- screen), and only the pages that administrator may see, exactly as their
-- own MCP search would rank them. Read only. The app knows people by their
-- signed-in email, so an administrator who has not yet connected Claude
-- (no OAuth subject) still sees what their grants would show.
create or replace function workspace.app_index_search(
    p_email         text,
    query_text      text,
    query_embedding vector(384),
    match_count     integer default 5
)
returns table (
    id            uuid,
    owner_handle  text,
    is_own        boolean,
    drawer        text,
    key           text,
    title         text,
    description   text,
    distillation  text,
    fields        jsonb,
    updated_at    timestamptz,
    score         double precision
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
begin
    v_who := workspace._admin_require(p_email);
    if query_text is null or length(btrim(query_text)) not between 1 and 200 then
        raise exception 'a search is 1 to 200 characters' using errcode = '22023';
    end if;
    return query
    select * from workspace._pages_search_core(
        v_who.id, workspace._resolve_domains_for_principal(v_who),
        query_text, query_embedding, match_count);
end;
$$;

-- ── redo summaries and index ────────────────────────────────────────────────

-- Administrators: what a redo would queue, and what a summary has cost.
create or replace function workspace.app_summaries_redo_preview(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._admin_require(p_email);
    v_cost jsonb;
begin
    v_cost := workspace._cataloguer_cost();
    return jsonb_build_object(
        'is_owner', lower(btrim(v_who.email)) is not distinct from workspace._engine_owner_email(),
        'pages', (select count(*) from workspace.pages p where p.deleted_at is null),
        'avg_chars', (select coalesce(round(avg(least(length(p.body), 20000))), 0) from workspace.pages p where p.deleted_at is null),
        'summary_model', v_cost->>'model',
        'usd_30d', (v_cost->>'usd_30d')::numeric,
        'summaries_30d', (v_cost->>'summaries_30d')::numeric);
end;
$$;

-- The Engine owner: queue every live page for a new summary and index entry.
-- Each page keeps its old summary until the run writes the new one.
create or replace function workspace.app_summaries_redo(p_email text)
returns integer
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._engine_owner_require(p_email);
    v_n   integer;
begin
    update workspace.pages set summary_queued_at = now()
     where deleted_at is null;
    get diagnostics v_n = row_count;
    insert into workspace.pipeline_settings_log (changed_by, setting, old_value, new_value)
    values (lower(btrim(v_who.email)), 'redo_index', null, v_n::text || ' pages');
    begin
        perform workspace.curator_wake(false);
    exception when others then
        raise warning 'curator wake skipped (%)', sqlstate;
    end;
    return v_n;
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._summary_run() from public, anon, authenticated;
revoke all on function workspace._cataloguer_cost() from public, anon, authenticated;
revoke all on function workspace._tickets_sync() from public, anon, authenticated;
revoke all on function workspace._pages_search_core(uuid, text[], text, vector, integer) from public, anon, authenticated;
revoke all on function workspace.app_pipeline_get(text) from public, anon, authenticated;
grant execute on function workspace.app_pipeline_get(text) to kb_engine;
revoke all on function workspace.app_pipeline_set(text, text, text) from public, anon, authenticated;
grant execute on function workspace.app_pipeline_set(text, text, text) to kb_engine;
revoke all on function workspace.app_ledger(text) from public, anon, authenticated;
grant execute on function workspace.app_ledger(text) to kb_engine;
revoke all on function workspace.curator_pipeline_get() from public, anon, authenticated;
grant execute on function workspace.curator_pipeline_get() to kb_engine;
revoke all on function workspace.pages_search_by_oauth_subject(text, text, vector, integer) from public, anon, authenticated;
grant execute on function workspace.pages_search_by_oauth_subject(text, text, vector, integer) to kb_engine;
revoke all on function workspace.app_index_search(text, text, vector, integer) from public, anon, authenticated;
grant execute on function workspace.app_index_search(text, text, vector, integer) to kb_engine;
revoke all on function workspace.app_summaries_redo_preview(text) from public, anon, authenticated;
grant execute on function workspace.app_summaries_redo_preview(text) to kb_engine;
revoke all on function workspace.app_summaries_redo(text) from public, anon, authenticated;
grant execute on function workspace.app_summaries_redo(text) to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select workspace.app_pipeline_get('<admin email>')->'settings'->>'summary_length';   -- standard
-- select workspace.curator_pipeline_get()->>'summary_length';                           -- standard
-- select workspace.app_summaries_redo_preview('<admin email>');                         -- pages, model
--
-- ROLLBACK (by hand) ------------------------------------------------------
-- re-apply 0071's app_pipeline_get, app_pipeline_set, app_ledger and
--   curator_pipeline_get, 0073's _tickets_sync, and 0050's
--   pages_search_by_oauth_subject;
-- drop function workspace.app_summaries_redo(text), workspace.app_summaries_redo_preview(text),
--   workspace.app_index_search(text, text, vector, integer),
--   workspace._pages_search_core(uuid, text[], text, vector, integer),
--   workspace._cataloguer_cost(), workspace._summary_run();
-- alter table workspace.pipeline_tickets drop constraint pipeline_tickets_step;
--   (re-add 0072's list once no ticket uses the two new steps)
-- alter table workspace.pipeline_settings drop column summary_length;
