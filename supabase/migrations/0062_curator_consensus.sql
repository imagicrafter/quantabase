-- 0062_curator_consensus.sql
--
-- Consensus curation (decision 2026-11-21). Each item is curated twice with
-- the primary model (curator_settings.model); if the structured decisions
-- differ, once more with the tiebreak model, and each decision goes to the
-- majority. A decision with no majority is dropped (never queued) and
-- recorded here, shown on Engine > Indexing.
--
--   curator_settings.consensus       on by default
--   curator_settings.tiebreak_model  default deepseek-v4.1-flash (same floor
--                                    list as `model`)
--   curator_uncertain                one row per dropped decision, with the
--                                    three proposals

alter table workspace.curator_settings
    add column if not exists consensus boolean not null default true,
    add column if not exists tiebreak_model text not null default 'deepseek-v4.1-flash';

alter table workspace.curator_settings drop constraint if exists curator_settings_tiebreak_values;
alter table workspace.curator_settings add constraint curator_settings_tiebreak_values
    check (tiebreak_model in ('openai-gpt-oss-120b', 'deepseek-v4.1-flash'));

create table if not exists workspace.curator_uncertain (
    id          uuid        primary key default gen_random_uuid(),
    item_id     uuid        not null references workspace.source_items(id) on delete cascade,
    decision    text        not null,
    proposals   jsonb       not null,
    created_at  timestamptz not null default now(),
    constraint curator_uncertain_decision_len check (length(decision) between 1 and 500),
    constraint curator_uncertain_proposals_array check (jsonb_typeof(proposals) = 'array')
);

comment on table workspace.curator_uncertain is
    'Decisions the consensus runs could not settle: dropped, shown on Indexing.';

create index if not exists curator_uncertain_created on workspace.curator_uncertain (created_at desc);

alter table workspace.curator_uncertain enable row level security;
revoke all on workspace.curator_uncertain from public;
revoke all on workspace.curator_uncertain from anon, authenticated;


create or replace function workspace.curator_consensus_get()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object('enabled', s.consensus, 'primary_model', s.model,
                              'tiebreak_model', s.tiebreak_model)
    from workspace.curator_settings s
    where s.id;
$$;

create or replace function workspace.curator_uncertain_record(
    p_item_id   uuid,
    p_decision  text,
    p_proposals text[]
)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    if not exists (select 1 from workspace.source_items s where s.id = p_item_id) then
        raise exception 'no such item' using errcode = '22023';
    end if;
    insert into workspace.curator_uncertain (item_id, decision, proposals)
    values (p_item_id, left(coalesce(p_decision, '?'), 500),
            to_jsonb(array(select left(x, 2000) from unnest(coalesce(p_proposals, array[]::text[])) x)));
end;
$$;


-- app_indexing as in 0058, plus consensus settings and the latest uncertain
-- decisions (item title, source, decision, the three proposals).
create or replace function workspace.app_indexing(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_run jsonb;
begin
    perform workspace._admin_require(p_email);
    select jsonb_build_object('started_at', r.started_at, 'finished_at', r.finished_at,
                              'status', r.status, 'stats', r.stats)
      into v_run
    from workspace.curator_runs r order by r.started_at desc limit 1;
    return jsonb_build_object(
        'pages', (select count(*) from workspace.pages p where p.deleted_at is null),
        'summaries_pending', (select count(*) from workspace.pages p
                              where p.deleted_at is null and p.summary_queued_at is not null),
        'items_waiting', (select count(*) from workspace.source_items s
                          where s.deleted_at is null and s.curated_at is null
                            and (s.flagged is false or s.released_at is not null)),
        'items_flagged', (select count(*) from workspace.source_items s
                          where s.deleted_at is null and s.curated_at is null
                            and s.flagged is true and s.released_at is null),
        'items_failed', (select count(*) from workspace.source_items s
                         where s.deleted_at is null and s.curator_outcome = 'failed'),
        'last_run', v_run,
        'curator', (select jsonb_build_object('enabled', s.enabled, 'model', s.model,
                                              'last_wake_at', s.last_wake_at,
                                              'has_engine_url', s.engine_url is not null,
                                              'consensus', s.consensus,
                                              'tiebreak_model', s.tiebreak_model)
                    from workspace.curator_settings s where s.id),
        'uncertain', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'item_title', x.title, 'source', x.source, 'decision', x.decision,
                       'proposals', x.proposals, 'created_at', x.created_at)
                   order by x.created_at desc)
            from (select si.title, si.source, u.decision, u.proposals, u.created_at
                  from workspace.curator_uncertain u
                  join workspace.source_items si on si.id = u.item_id
                  order by u.created_at desc
                  limit 20) x), '[]'::jsonb),
        'has_model_key', workspace._curator_vault_secret('kbe_model_key') is not null,
        'backup', (select jsonb_build_object('enabled', b.enabled, 'last_finished_at', b.last_finished_at,
                                             'last_status', b.last_status)
                   from workspace.backup_settings b where b.id));
end;
$$;


revoke all on function workspace.curator_consensus_get() from public;
revoke all on function workspace.curator_consensus_get() from anon, authenticated;
grant execute on function workspace.curator_consensus_get() to kb_engine;
revoke all on function workspace.curator_uncertain_record(uuid, text, text[]) from public;
revoke all on function workspace.curator_uncertain_record(uuid, text, text[]) from anon, authenticated;
grant execute on function workspace.curator_uncertain_record(uuid, text, text[]) to kb_engine;
revoke all on function workspace.app_indexing(text) from public;
revoke all on function workspace.app_indexing(text) from anon, authenticated;
grant execute on function workspace.app_indexing(text) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select workspace.curator_consensus_get();   -- {"enabled": true, ...}


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply app_indexing from 0058, then:
-- drop function if exists workspace.curator_uncertain_record(uuid, text, text[]);
-- drop function if exists workspace.curator_consensus_get();
-- drop table if exists workspace.curator_uncertain;
-- alter table workspace.curator_settings drop column if exists tiebreak_model, drop column if exists consensus;
