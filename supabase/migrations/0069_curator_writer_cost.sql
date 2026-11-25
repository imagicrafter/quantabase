-- 0069_curator_writer_cost.sql
--
-- Curator cost (decision 2026-11-22): about $0.02-0.03 an item, on the
-- quality of one strong writer (blind test round 3). The default curator is
-- now one writer model after a cheap triage; consensus stays available.
--
--   curator_settings.consensus      default off (was on); this file also
--                                   turns it off on an existing Engine.
--                                   Set it back on to use consensus.
--   curator_settings.writer_model   the one writer when consensus is off.
--                                   Default anthropic-claude-sonnet-5.5;
--                                   also anthropic-claude-5.5-haiku.
--   curator_settings.triage         a cheap first read of every item
--                                   (default on): items with nothing durable
--                                   stop there; long items reach the writer
--                                   as excerpts.
--   curator_settings.triage_model   default openai-gpt-oss-120b.
--   app_curator_cost(email)         cost this month and per item, from the
--                                   USD each run records in its stats
--                                   (engine prices.ts, DigitalOcean list
--                                   prices; the invoice is the final word).

alter table workspace.curator_settings
    add column if not exists writer_model text not null default 'anthropic-claude-sonnet-5.5',
    add column if not exists triage boolean not null default true,
    add column if not exists triage_model text not null default 'openai-gpt-oss-120b';

alter table workspace.curator_settings drop constraint if exists curator_settings_writer_values;
alter table workspace.curator_settings add constraint curator_settings_writer_values
    check (writer_model in ('anthropic-claude-sonnet-5.5', 'anthropic-claude-5.5-haiku'));

alter table workspace.curator_settings drop constraint if exists curator_settings_triage_values;
alter table workspace.curator_settings add constraint curator_settings_triage_values
    check (triage_model in ('openai-gpt-oss-120b', 'deepseek-v4.1-flash', 'anthropic-claude-5.5-haiku'));

alter table workspace.curator_settings alter column consensus set default false;
update workspace.curator_settings set consensus = false where id and consensus;

create or replace function workspace.curator_consensus_get()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object('enabled', s.consensus, 'primary_model', s.model,
                              'tiebreak_model', s.tiebreak_model, 'strong_model', s.strong_model,
                              'max_output_tokens', s.max_output_tokens,
                              'writer_model', s.writer_model, 'triage', s.triage,
                              'triage_model', s.triage_model)
    from workspace.curator_settings s
    where s.id;
$$;

revoke all on function workspace.curator_consensus_get() from public;
revoke all on function workspace.curator_consensus_get() from anon, authenticated;
grant execute on function workspace.curator_consensus_get() to kb_engine;

-- Cost this calendar month (UTC) and per item, for admins (Indexing screen).
-- A run without "usd" in its stats (before this change) counts as unknown,
-- not as free: its items are left out of the per-item figure.
create or replace function workspace.app_curator_cost(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_since timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
    v_usd numeric;
    v_items bigint;
    v_unpriced bigint;
begin
    perform workspace._admin_require(p_email);
    select coalesce(sum(case when p.priced then (p.stats->>'usd')::numeric end), 0),
           coalesce(sum(case when p.priced and jsonb_typeof(p.stats->'items') = 'number'
                             then (p.stats->>'items')::numeric end), 0)::bigint,
           count(*) filter (where not p.priced and jsonb_typeof(p.stats->'items') = 'number')
      into v_usd, v_items, v_unpriced
    from (select r.stats, coalesce(jsonb_typeof(r.stats->'usd') = 'number', false) as priced
          from workspace.curator_runs r
          where r.started_at >= v_since) p;
    return jsonb_build_object(
        'since', v_since,
        'usd', round(v_usd, 4),
        'items', v_items,
        'per_item_usd', case when v_items > 0 then round(v_usd / v_items, 4) end,
        'runs_without_cost', v_unpriced,
        'models', (select jsonb_build_object('consensus', s.consensus, 'writer_model', s.writer_model,
                                             'triage', s.triage, 'triage_model', s.triage_model)
                   from workspace.curator_settings s where s.id));
end;
$$;

revoke all on function workspace.app_curator_cost(text) from public;
revoke all on function workspace.app_curator_cost(text) from anon, authenticated;
grant execute on function workspace.app_curator_cost(text) to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select workspace.curator_consensus_get();             -- enabled false, writer_model, triage true
-- select workspace.app_curator_cost('<admin email>');   -- usd, items, per_item_usd
--
-- ROLLBACK (by hand) ------------------------------------------------------
-- drop function if exists workspace.app_curator_cost(text);
-- alter table workspace.curator_settings drop constraint if exists curator_settings_writer_values;
-- alter table workspace.curator_settings drop constraint if exists curator_settings_triage_values;
-- alter table workspace.curator_settings drop column if exists writer_model,
--     drop column if exists triage, drop column if exists triage_model;
-- alter table workspace.curator_settings alter column consensus set default true;
-- (then re-run the curator_consensus_get definition from 0068)
