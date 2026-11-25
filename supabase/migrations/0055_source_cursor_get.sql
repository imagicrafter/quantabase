-- 0055_source_cursor_get.sql
--
-- Read-only: the caller's own cursor for one source (Step E, plugin ingest).
--
-- The get_ingest_plan tool calls this first in every scheduled ingest run, so
-- a missed or failed run catches up from the last item handed over. The
-- owner is always the signed-in caller; nobody can read another person's
-- cursor. Returns no row when the caller has never handed over an item for
-- that source (first run).

create or replace function workspace.source_cursor_get(
    p_oauth_subject text,
    p_source        text
)
returns table (
    last_seen_id     text,
    last_received_at timestamptz,
    items_received   bigint,
    items_saved      bigint
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
#variable_conflict use_column
declare
    v_principal uuid := workspace._principal_id_for_oauth_subject(p_oauth_subject);
begin
    if v_principal is null then
        raise exception 'Your account is not active on this Engine' using errcode = '42501';
    end if;
    return query
    select c.last_seen_id, c.last_received_at, c.items_received, c.items_saved
    from workspace.source_cursors c
    where c.owner_principal_id = v_principal
      and c.source = lower(btrim(coalesce(p_source, '')));
end;
$$;

comment on function workspace.source_cursor_get(text, text) is
    'The caller''s own cursor and counts for one source. Read-only.';

revoke all on function workspace.source_cursor_get(text, text) from public;
revoke all on function workspace.source_cursor_get(text, text) from anon, authenticated;
grant execute on function workspace.source_cursor_get(text, text) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('anon',
--   'workspace.source_cursor_get(text, text)', 'execute');   -- f


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.source_cursor_get(text, text);
