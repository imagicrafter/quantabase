-- 0018_kb_engine_role.sql
--
-- Creates the `kb_engine` PostgreSQL role with least-privilege access: execute
-- on three functions, zero table grants.
--
-- DESIGN — distinguished from the recorded `aios_readonly` incident:
--   The aios_readonly failure was a direct table read under RLS with no matching
--   policy: the role had SELECT on a table, but no RLS policy matched, so every
--   query returned 0 rows silently. The lesson: never grant SELECT on a workspace
--   table unless the RLS policy model is complete.
--
--   kb_engine reads NO TABLES AT ALL. It only executes SECURITY DEFINER functions
--   owned by `postgres`. There is no policy to omit because there is no table grant.
--   A call to `.from('documents')` from the engine would fail at the role level,
--   not at RLS. This is structurally impossible to misconfigure in the same way.
--
-- The engine authenticates to Supabase by minting a PostgREST JWT:
--   { "role": "kb_engine", "iss": "supabase", "exp": <1 year> }
-- signed with the project JWT secret (SUPABASE_JWT_SECRET env var).
-- PostgREST then runs every query in this migration's session as kb_engine.
--
-- CAVEAT (recorded in engine/README.md):
--   This JWT's rotation is tied to the project JWT secret, which is shared with
--   another production app. If independent rotation becomes necessary, the alternative is
--   a real Postgres role with a password, connecting over the Supabase pooler
--   using `pg` — one small dependency, independently rotatable, still $0.
--   That is the productisation path for per-client isolation.

create role kb_engine nologin;

grant usage on schema workspace to kb_engine;

-- The three functions the engine calls directly. The domain intersection and
-- access checks live inside these SECURITY DEFINER functions; kb_engine never
-- reads a table.
grant execute on function workspace.documents_search_by_workos_user(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) to kb_engine;

grant execute on function workspace.document_get(text, uuid)   to kb_engine;
grant execute on function workspace.wiki_page_get(text, text)  to kb_engine;

-- Diagnostic: count of domains the user resolves to. Returns an integer, not
-- domain names — used to produce diagnosable messages without disclosing the grant list.
grant execute on function workspace.resolved_domain_count_for_workos_user(text) to kb_engine;

-- Bootstrap path: resolve email to a principal on first OAuth login.
-- Required for the pin-on-first-login (TOFU) flow in engine/src/auth/principal.ts.
grant execute on function workspace.resolve_domains_for_email(text) to kb_engine;

-- The bootstrap flow also needs to read a single principal row to get the id for
-- the UPDATE. This is the one narrow table grant: SELECT only, on principals,
-- where workos_user_id is null (bootstrap rows only). RLS prevents broader access.
-- We use a SECURITY DEFINER helper instead of a direct grant to avoid any table grant.
-- See engine/src/auth/principal.ts for the two-step TOFU flow.

-- TOFU helper: look up a principal by email where workos_user_id is null, and
-- atomically pin the workos_user_id. Wrapping in SECURITY DEFINER keeps
-- kb_engine away from direct table writes.

create or replace function workspace.claim_workos_user_id(
    p_email          text,
    p_workos_user_id text
)
returns table (
    id           uuid,
    handle       text,
    display_name text,
    role         text,
    active       boolean
)
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal workspace.principals%rowtype;
    v_normalised text;
begin
    if p_email is null or p_workos_user_id is null then
        return;
    end if;

    v_normalised := lower(btrim(p_email));

    -- Atomically claim: find a matching email with no workos_user_id, pin the sub.
    -- If another request already claimed this principal, this UPDATE matches zero rows
    -- and the SELECT below still finds it (via workos_user_id) for the return.
    update workspace.principals
    set workos_user_id = p_workos_user_id
    where lower(btrim(email)) = v_normalised
      and workos_user_id is null
      and active is true;

    -- Return the principal (whether we just claimed it or it was already claimed).
    return query
    select p.id, p.handle, p.display_name, p.role, p.active
    from workspace.principals p
    where (
            (lower(btrim(p.email)) = v_normalised and p.workos_user_id = p_workos_user_id)
         or p.workos_user_id = p_workos_user_id
      )
      and p.active is true
    limit 1;
end;
$$;

comment on function workspace.claim_workos_user_id(text, text) is
    'TOFU: atomically pin a WorkOS sub to a principal matched by email. '
    'Called once per principal during first OAuth login. After this call, '
    'the principal is reachable by workos_user_id only.';

revoke all on function workspace.claim_workos_user_id(text, text) from public;
grant execute on function workspace.claim_workos_user_id(text, text) to kb_engine;


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.claim_workos_user_id(text, text);
-- revoke execute on function workspace.resolve_domains_for_email(text) from kb_engine;
-- revoke execute on function workspace.resolved_domain_count_for_workos_user(text) from kb_engine;
-- revoke execute on function workspace.wiki_page_get(text, text) from kb_engine;
-- revoke execute on function workspace.document_get(text, uuid) from kb_engine;
-- revoke execute on function workspace.documents_search_by_workos_user(
--     text, text, vector, integer, integer, integer,
--     double precision, double precision[], double precision, boolean
-- ) from kb_engine;
-- revoke usage on schema workspace from kb_engine;
-- drop role if exists kb_engine;
