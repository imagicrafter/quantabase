-- 0013_memory_search_authed.sql
--
-- Lets `agent-memory-search` drop its service-role key.
--
-- The problem: `workspace.hybrid_memory_search` is SECURITY INVOKER and `anon` has
-- zero table grants on `workspace.memory_chunks`. An anon-key client calling it
-- gets "permission denied for table memory_chunks", so the edge function has been
-- carrying the service-role key purely to get past that.
--
-- The obvious fix -- make `hybrid_memory_search` SECURITY DEFINER and grant `anon`
-- EXECUTE -- would be WORSE than the status quo. It returns every chunk with no
-- filtering, so anyone holding the publishable anon key could call the RPC
-- directly and bypass the edge function's token check entirely. The auth would
-- live only in the function, and the function would no longer be the only door.
--
-- Instead: a SECURITY DEFINER wrapper that requires a principal token BEFORE it
-- reaches the data, mirroring how `documents_search` already works. The
-- underlying `hybrid_memory_search` is left exactly as it is -- still SECURITY
-- INVOKER, still no grant to `anon` -- so the only anon-reachable path is the one
-- that checks a token first.
--
-- A SECURITY DEFINER function calling a SECURITY INVOKER one is fine: the inner
-- call runs with the definer's effective privileges.

create or replace function workspace.memory_search_authed(
    query_text      text,
    query_embedding vector(384),
    p_token_hash    text,
    match_count     integer          default 10,
    semantic_weight double precision default 0.7,
    keyword_weight  double precision default 0.3
)
returns table (
    id          uuid,
    source_file text,
    title       text,
    content     text,
    metadata    jsonb,
    similarity  double precision,
    keyword_rank double precision,
    hybrid_score double precision
)
language plpgsql
stable
security definer
-- `public` is required: pgvector's `<=>` lives there on this project, and
-- omitting it is what broke documents_search in 0004 (fixed by 0006).
set search_path = workspace, public, pg_temp
as $fn$
begin
    -- Fail closed. No valid, active principal means no rows -- never all rows.
    -- Deliberately reuses the same principal check as the embed endpoint: one
    -- credential table, one revocation path. Revoking a principal kills every
    -- surface at once, which is the whole reason 0012 did not create a second
    -- token table.
    if not workspace.principal_can_embed(p_token_hash) then
        return;
    end if;

    return query
    select *
    from workspace.hybrid_memory_search(
        query_text, query_embedding, match_count, semantic_weight, keyword_weight
    );
end;
$fn$;

comment on function workspace.memory_search_authed is
    'Token-gated wrapper over hybrid_memory_search. The ONLY anon-reachable path '
    'to memory_chunks. hybrid_memory_search itself stays SECURITY INVOKER with no '
    'anon grant, so the token check cannot be bypassed by calling it directly.';

revoke all on function workspace.memory_search_authed(
    text, vector, text, integer, double precision, double precision
) from public;

grant execute on function workspace.memory_search_authed(
    text, vector, text, integer, double precision, double precision
) to anon, authenticated, service_role;

-- Deliberately NOT done, and not an oversight:
--   * hybrid_memory_search is unchanged -- still SECURITY INVOKER, still no
--     grant to anon. It remains reachable only with the service role, which is
--     how the developer machine's local scripts/memory/search.py already calls it.
--   * no grants added on workspace.memory_chunks.


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.memory_search_authed(
--     text, vector, text, integer, double precision, double precision
-- );
