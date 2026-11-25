-- 0047_page_history.sql
--
-- Old versions of pages. Never searched, never embedded.
--
-- page_save (0051) writes a row only when a save changes the page's content
-- hash, so a save that changes nothing leaves no trace. Each row is a full
-- snapshot of the version as saved (header and body), which is what an undo
-- puts back.
--
-- Thinning, page_history_prune(now):
--   younger than 30 days      every version kept
--   30 days to 365 days       the latest version of each day kept
--   older than 365 days       the latest version of each month kept
-- The service's own chore timer calls it (Phase 10.8); it is safe to run any
-- number of times.

create table if not exists workspace.page_history (
    id            uuid        primary key default gen_random_uuid(),
    page_id       uuid        not null references workspace.pages(id) on delete cascade,
    content_hash  text        not null,
    snapshot      jsonb       not null,
    saved_by      uuid        references workspace.principals(id) on delete set null,
    saved_at      timestamptz not null default now()
);

comment on table workspace.page_history is
    'One row per saved version of a page (content hash changed). Never searched.';

create index if not exists page_history_page_saved_idx
    on workspace.page_history (page_id, saved_at desc);

alter table workspace.page_history enable row level security;
revoke all on workspace.page_history from public;
revoke all on workspace.page_history from anon, authenticated;


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
               row_number() over (
                   partition by h.page_id,
                       case when h.saved_at >= p_now - interval '365 days'
                            then date_trunc('day', h.saved_at)
                            else date_trunc('month', h.saved_at) end
                   order by h.saved_at desc, h.id desc
               ) as rn
        from workspace.page_history h
        where h.saved_at < p_now - interval '30 days'
    )
    delete from workspace.page_history h
    using ranked r
    where h.id = r.id
      and r.rn > 1;

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

comment on function workspace.page_history_prune(timestamptz) is
    'Thin page history: all versions for 30 days, then one per day, then one '
    'per month after a year. Returns how many rows were removed.';

revoke all on function workspace.page_history_prune(timestamptz) from public;
revoke all on function workspace.page_history_prune(timestamptz) from anon, authenticated;
grant execute on function workspace.page_history_prune(timestamptz) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select workspace.page_history_prune();       -- a count; 0 on a second run


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.page_history_prune(timestamptz);
-- drop table if exists workspace.page_history;
