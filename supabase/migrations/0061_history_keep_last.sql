-- 0061_history_keep_last.sql
--
-- Page history thinning keeps its time rule (0047) AND always keeps the
-- newest 10 versions of every page, whatever their age (decision 2026-11-21):
--
--   younger than 30 days      every version kept
--   30 days to 365 days       the latest version of each day kept
--   older than 365 days       the latest version of each month kept
--   and always                the newest 10 versions of each page kept

create or replace function workspace.page_history_prune(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_count integer;
begin
    with ranked as (
        select h.id,
               h.saved_at,
               row_number() over (
                   partition by h.page_id,
                       case when h.saved_at >= p_now - interval '365 days'
                            then date_trunc('day', h.saved_at)
                            else date_trunc('month', h.saved_at) end
                   order by h.saved_at desc, h.id desc
               ) as rn_bucket,
               row_number() over (
                   partition by h.page_id
                   order by h.saved_at desc, h.id desc
               ) as rn_page
        from workspace.page_history h
    )
    delete from workspace.page_history h
    using ranked r
    where h.id = r.id
      and r.saved_at < p_now - interval '30 days'
      and r.rn_bucket > 1
      and r.rn_page > 10;

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

comment on function workspace.page_history_prune(timestamptz) is
    'Thin page history: all versions for 30 days, then one per day, then one '
    'per month after a year; the newest 10 versions of each page are always '
    'kept. Returns how many rows were removed.';

revoke all on function workspace.page_history_prune(timestamptz) from public;
revoke all on function workspace.page_history_prune(timestamptz) from anon, authenticated;
grant execute on function workspace.page_history_prune(timestamptz) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select workspace.page_history_prune();       -- a count; 0 on a second run


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply the function from 0047_page_history.sql.
