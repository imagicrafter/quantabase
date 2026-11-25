-- 0071_pipeline_ledger.sql
--
-- The Pipeline and Ledger screens (/setup/pipeline, /setup/ledger): a few
-- safe choices about how the curator works, and a monthly model budget.
-- Every choice is from a fixed list; none of them can switch a check off.
--
--   pipeline_settings          one row:
--     desk_editor     keep_more | normal | keep_less   how much triage keeps
--     archivist_bar   rarely_new | normal              rarely_new lowers the
--                                                      name-match threshold a
--                                                      little, so near names
--                                                      update a page instead
--                                                      of making a new one
--     publisher_ask   never | big_changes              big_changes also asks
--                                                      before an update that
--                                                      removes 20%+ of a page
--                                                      (the built-in checks
--                                                      always stay on)
--     stale_days      60 | 90 | 180                    a page not updated for
--                                                      this long is "stale"
--     paused_until    null, or when a pause ends (at most 24 hours)
--     budget_usd      1 to 10000, default 25 (USD a calendar month, UTC)
--     budget_pct      50 | 75 | 80 | 90 | 100          when the rule acts
--     budget_action   warn | switch                    switch = the writer
--                                                      moves to the budget
--                                                      model for the rest of
--                                                      the month
--   pipeline_settings_log      who changed what, when (old and new value)
--
--   The author (writer) model stays in curator_settings.writer_model (0069):
--   "best" = anthropic-claude-sonnet-5.5, "budget" = anthropic-claude-5.5-haiku.
--
--   app_pipeline_get(email)         administrators: settings, last change of
--                                   each, and each step's status
--   app_pipeline_set(email, setting, value)
--                                   the Engine owner only; value from a
--                                   fixed list; logged
--   app_ledger(email)               administrators: spend this month, by day
--                                   and role, items, budget, changes
--   curator_pipeline_get()          the curator (kb_engine): the choices,
--                                   whether paused, and the budget rule
--                                   (it may switch the writer and logs it)

create table if not exists workspace.pipeline_settings (
    id             boolean       primary key default true,
    desk_editor    text          not null default 'normal',
    archivist_bar  text          not null default 'normal',
    publisher_ask  text          not null default 'never',
    stale_days     integer       not null default 90,
    paused_until   timestamptz,
    budget_usd     numeric(10,2) not null default 25,
    budget_pct     integer       not null default 80,
    budget_action  text          not null default 'warn',
    budget_switched_month date,
    updated_at     timestamptz   not null default now(),
    constraint pipeline_settings_one_row check (id),
    constraint pipeline_settings_desk check (desk_editor in ('keep_more', 'normal', 'keep_less')),
    constraint pipeline_settings_archivist check (archivist_bar in ('rarely_new', 'normal')),
    constraint pipeline_settings_publisher check (publisher_ask in ('never', 'big_changes')),
    constraint pipeline_settings_stale check (stale_days in (60, 90, 180)),
    constraint pipeline_settings_budget check (budget_usd between 1 and 10000),
    constraint pipeline_settings_pct check (budget_pct in (50, 75, 80, 90, 100)),
    constraint pipeline_settings_action check (budget_action in ('warn', 'switch'))
);

comment on table workspace.pipeline_settings is
    'One row: the owner''s safe choices for the curator (Pipeline screen) and the monthly model budget (Ledger).';

insert into workspace.pipeline_settings (id) values (true) on conflict (id) do nothing;

alter table workspace.pipeline_settings enable row level security;
revoke all on workspace.pipeline_settings from public;
revoke all on workspace.pipeline_settings from anon, authenticated;

create table if not exists workspace.pipeline_settings_log (
    id          bigint      generated always as identity primary key,
    changed_at  timestamptz not null default now(),
    changed_by  text        not null,
    setting     text        not null,
    old_value   text,
    new_value   text
);

create index if not exists pipeline_settings_log_when_idx
    on workspace.pipeline_settings_log (changed_at desc);

comment on table workspace.pipeline_settings_log is
    'Every change on the Pipeline and Ledger screens, and every automatic budget switch: when, who, old and new value.';

alter table workspace.pipeline_settings_log enable row level security;
revoke all on workspace.pipeline_settings_log from public;
revoke all on workspace.pipeline_settings_log from anon, authenticated;

-- ── helpers ─────────────────────────────────────────────────────────────────

create or replace function workspace._month_start()
returns timestamptz
language sql
stable
set search_path = workspace, pg_temp
as $$
    select date_trunc('month', now() at time zone 'utc') at time zone 'utc';
$$;

-- USD the curator recorded this month (a run without a number counts 0).
create or replace function workspace._month_spend()
returns numeric
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(sum((r.stats->>'usd')::numeric), 0)
    from workspace.curator_runs r
    where r.started_at >= workspace._month_start()
      and jsonb_typeof(r.stats->'usd') = 'number';
$$;

-- The latest change of each setting: {"<setting>": {"at": ..., "by": ...}}.
create or replace function workspace._pipeline_last_changes()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(jsonb_object_agg(l.setting, jsonb_build_object('at', l.changed_at, 'by', l.changed_by)), '{}'::jsonb)
    from (select distinct on (setting) setting, changed_at, changed_by
          from workspace.pipeline_settings_log
          order by setting, changed_at desc, id desc) l;
$$;

-- ── read (administrators) ───────────────────────────────────────────────────

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
begin
    v_who := workspace._admin_require(p_email);
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
                          and p.updated_at < now() - make_interval(days => v_s.stale_days)));
end;
$$;

-- ── change (the Engine owner only) ──────────────────────────────────────────

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

-- ── the ledger (administrators) ─────────────────────────────────────────────

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
        -- Author = the writer model the run named; the rest (triage, fact
        -- check, summaries) is the desk editor and fact-checker.
        'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'author_usd', round(d.author, 4),
                                                              'other_usd', round(d.total - d.author, 4)) order by d.day), '[]'::jsonb)
                 from (select (r.started_at at time zone 'utc')::date as day,
                              sum((r.stats->>'usd')::numeric) as total,
                              sum(case when jsonb_typeof(r.stats->('usd:' || coalesce(r.stats->>'writer_model', ''))) = 'number'
                                       then (r.stats->>('usd:' || (r.stats->>'writer_model')))::numeric else 0 end) as author
                       from workspace.curator_runs r
                       where r.started_at >= v_since and jsonb_typeof(r.stats->'usd') = 'number'
                       group by 1) d),
        'changes', (select coalesce(jsonb_agg(jsonb_build_object('at', l.changed_at, 'by', l.changed_by, 'setting', l.setting,
                                                                 'old', l.old_value, 'new', l.new_value) order by l.changed_at), '[]'::jsonb)
                    from workspace.pipeline_settings_log l where l.changed_at >= v_since));
end;
$$;

-- ── the curator (kb_engine) ─────────────────────────────────────────────────
-- Called once a run. Applies the budget rule first: with action "switch",
-- once this month's spend reaches budget_pct of the budget, the writer moves
-- to the budget model (once a month; logged as "budget rule").

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
        'paused', coalesce(v_s.paused_until > now(), false));
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._month_start() from public;
revoke all on function workspace._month_start() from anon, authenticated;
revoke all on function workspace._month_spend() from public;
revoke all on function workspace._month_spend() from anon, authenticated;
revoke all on function workspace._pipeline_last_changes() from public;
revoke all on function workspace._pipeline_last_changes() from anon, authenticated;
revoke all on function workspace.app_pipeline_get(text) from public;
revoke all on function workspace.app_pipeline_get(text) from anon, authenticated;
grant execute on function workspace.app_pipeline_get(text) to kb_engine;
revoke all on function workspace.app_pipeline_set(text, text, text) from public;
revoke all on function workspace.app_pipeline_set(text, text, text) from anon, authenticated;
grant execute on function workspace.app_pipeline_set(text, text, text) to kb_engine;
revoke all on function workspace.app_ledger(text) from public;
revoke all on function workspace.app_ledger(text) from anon, authenticated;
grant execute on function workspace.app_ledger(text) to kb_engine;
revoke all on function workspace.curator_pipeline_get() from public;
revoke all on function workspace.curator_pipeline_get() from anon, authenticated;
grant execute on function workspace.curator_pipeline_get() to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select workspace.app_pipeline_get('<admin email>');     -- settings, changes, step counts
-- select workspace.app_ledger('<admin email>');           -- spent_usd, budget_usd 25, days
-- select workspace.curator_pipeline_get();                -- desk_editor normal, paused false
--
-- ROLLBACK (by hand) ------------------------------------------------------
-- drop function if exists workspace.curator_pipeline_get();
-- drop function if exists workspace.app_ledger(text);
-- drop function if exists workspace.app_pipeline_set(text, text, text);
-- drop function if exists workspace.app_pipeline_get(text);
-- drop function if exists workspace._pipeline_last_changes();
-- drop function if exists workspace._month_spend();
-- drop function if exists workspace._month_start();
-- drop table if exists workspace.pipeline_settings_log;
-- drop table if exists workspace.pipeline_settings;
