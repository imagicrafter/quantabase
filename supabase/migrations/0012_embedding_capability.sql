-- 0012_embedding_capability.sql
--
-- Lets a caller with no local model (an agent host, a hosted engine) obtain embeddings
-- without shipping it `sentence-transformers` or the service role key.
--
-- Design note (supersedes the plan's original shape):
--
--   The plan proposed a NEW table, `workspace.embedding_clients`, with its own
--   `token_hash`, `active` flag and its own `resolve_embedding_client()`. That
--   duplicates `workspace.principals` (migration 0002), which already stores a
--   unique `token_hash` and an `active` flag and is already the one place a bearer
--   token is resolved. Two credential tables means two revocation paths, and a
--   token revoked in one is still live in the other. There is one principal table.
--
--   Capability bar: ANY active principal may embed. Embedding is not a disclosure
--   operation -- it returns a vector of text the caller already holds, and reveals
--   nothing about `workspace.documents`. Read authority is a separate question,
--   answered by `resolve_domains()` at query time. Do not conflate them: an agent host
--   embed client is deliberately a principal with ZERO grants, able to embed and
--   able to read nothing.
--
--   Fail-closed, on the same terms as resolve_domains(): null, blank, unknown and
--   inactive all return false.
--
--   `search_path` includes `public` -- see 0006. The vector extension lives there
--   and omitting it has broken pgvector resolution in this schema before. This
--   function does not use `<=>`, but the omission is a trap for the next editor.

create or replace function workspace.principal_can_embed(p_token_hash text)
returns boolean
language sql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
    select exists (
        select 1
        from workspace.principals p
        where p.token_hash = p_token_hash
          and p.active is true
          and p_token_hash is not null
          and length(btrim(p_token_hash)) > 0
    );
$$;

comment on function workspace.principal_can_embed(text) is
    'Token hash -> may this caller request embeddings. Any ACTIVE principal may, '
    'including one with zero domain grants. Returns false for null, blank, unknown '
    'and inactive. Read authority is resolve_domains(), a separate question.';

-- The edge function authenticates with the ANON key and calls this RPC. It must
-- never hold the service role key. Grant execute to the roles the anon key can
-- assume; revoke everything else.
revoke all on function workspace.principal_can_embed(text) from public;
grant execute on function workspace.principal_can_embed(text) to anon, authenticated, service_role;

-- Last-used telemetry ---------------------------------------------------------
-- Separate from the capability check so the check can stay `stable` and cheap.
-- Best-effort: the caller ignores failures rather than refusing to embed.

alter table workspace.principals
    add column if not exists last_used_at timestamptz;

create or replace function workspace.touch_principal_last_used(p_token_hash text)
returns void
language sql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
    update workspace.principals
    set last_used_at = now()
    where token_hash = p_token_hash
      and active is true;
$$;

comment on column workspace.principals.last_used_at is
    'Best-effort last successful authentication. Never used for authorisation -- '
    'a stale value must not deny a live token.';

revoke all on function workspace.touch_principal_last_used(text) from public;
grant execute on function workspace.touch_principal_last_used(text) to anon, authenticated, service_role;

-- Rollback --------------------------------------------------------------------
--
-- drop function if exists workspace.principal_can_embed(text);
-- drop function if exists workspace.touch_principal_last_used(text);
-- alter table workspace.principals drop column if exists last_used_at;
