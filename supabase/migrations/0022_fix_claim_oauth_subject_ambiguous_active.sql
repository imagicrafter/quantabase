-- 0022_fix_claim_oauth_subject_ambiguous_active.sql
--
-- Fixes an ambiguous column reference in claim_oauth_subject's UPDATE statement.
--
-- BUG FOUND 2026-08-18 during the first real end-to-end test against production:
-- claim_oauth_subject RETURNS TABLE(..., active boolean, ...), which makes
-- PL/pgSQL implicitly expose `active` as an OUT-parameter-like name in scope for
-- the whole function body. The UPDATE statement's `and active is true` collides
-- with that name instead of resolving to `workspace.principals.active`, so
-- Postgres raises 42702 "column reference \"active\" is ambiguous" on every
-- bootstrap (first-login) attempt.
--
-- This bug was carried over VERBATIM from claim_workos_user_id in migration
-- 0018 — it existed before this transition and was never caught because the
-- bootstrap/TOFU path had never been exercised against a real login before
-- today.
--
-- Fix: alias the UPDATE target and qualify every column reference through it.

create or replace function workspace.claim_oauth_subject(
    p_email          text,
    p_oauth_subject  text
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
    v_normalised text;
begin
    if p_email is null or p_oauth_subject is null then
        return;
    end if;

    v_normalised := lower(btrim(p_email));

    -- Atomically claim: find a matching email with no oauth_subject, pin the sub.
    -- If another request already claimed this principal, this UPDATE matches zero
    -- rows and the SELECT below still finds it (via oauth_subject) for the return.
    -- Table alias `t` + qualified columns avoid colliding with the `active`
    -- OUT-parameter name from RETURNS TABLE above (bug fixed in 0022).
    update workspace.principals t
    set oauth_subject = p_oauth_subject
    where lower(btrim(t.email)) = v_normalised
      and t.oauth_subject is null
      and t.active is true;

    -- Return the principal (whether we just claimed it or it was already claimed).
    return query
    select p.id, p.handle, p.display_name, p.role, p.active
    from workspace.principals p
    where (
            (lower(btrim(p.email)) = v_normalised and p.oauth_subject = p_oauth_subject)
         or p.oauth_subject = p_oauth_subject
      )
      and p.active is true
    limit 1;
end;
$$;

comment on function workspace.claim_oauth_subject(text, text) is
    'TOFU: atomically pin a verified OAuth subject to a principal matched by email. '
    'Called once per principal during first OAuth login. After this call, '
    'the principal is reachable by oauth_subject only. '
    'Provider-neutral successor to claim_workos_user_id (0020). Fixed 2026-08-18 '
    '(0022): UPDATE target aliased to avoid the ambiguous-active bug carried '
    'over from claim_workos_user_id.';

-- create or replace preserves existing grants on this function; no re-grant needed.


-- ROLLBACK -------------------------------------------------------------------
-- Not meaningful to roll back to the ambiguous-column version — it was broken.
