-- 0014_principal_email_identity.sql
--
-- Adds OAuth identity fields to workspace.principals and refactors the domain
-- resolver so the sensitivity rule has exactly one implementation.
--
-- Background: the engine authenticates via WorkOS OAuth, which produces a verified
-- email and a stable `sub` (WorkOS user id). Previously, `resolve_domains` was
-- keyed solely on `token_hash`. This migration adds:
--
--   • `email` — verified OAuth email (citext-normalised). Bootstrap identity only;
--     steady-state uses `workos_user_id`.
--   • `workos_user_id` — the WorkOS `sub`. PRIMARY key for OAuth resolution.
--     Null until the first successful OAuth login claims and pins it (TOFU).
--
-- The sensitivity rule (sensitive domains are never implicit, not even for an
-- administrator) is extracted into `_resolve_domains_for_principal`, which both
-- `resolve_domains` (token path) and `resolve_domains_for_workos_user` (OAuth path)
-- delegate to. This gives the rule exactly one implementation: two copies is how
-- a sensitive domain eventually leaks.
--
-- GRANT posture follows 0012_embedding_capability.sql (the correct model):
--   revoke all ... from public;
-- NOT the pattern in 0006/0011 which used `revoke ... from anon, authenticated`
-- and left PostgreSQL's default PUBLIC grant in place. Verified live 2026-08-14:
-- `has_function_privilege('anon', 'workspace.documents_search(...)', 'execute')`
-- returned TRUE — every function in this migration must be revoked from PUBLIC.

-- ── Schema additions ──────────────────────────────────────────────────────────

alter table workspace.principals
    add column if not exists email text;

comment on column workspace.principals.email is
    'Verified WorkOS AuthKit email. Null = no OAuth identity. '
    'Compared lowercased and trimmed. Bootstrap identity only; '
    'once workos_user_id is pinned, email is not used for authorization.';

alter table workspace.principals
    add column if not exists workos_user_id text;

comment on column workspace.principals.workos_user_id is
    'WorkOS user sub. The PRIMARY identifier for OAuth resolution. '
    'Null until the first successful OAuth login claims and pins it (TOFU). '
    'Once set, this is the sole authorization key; email becomes display-only.';

-- PostgreSQL has no `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS` (verified against
-- this project 2026-08-14: `syntax error at or near "not"`). `DROP CONSTRAINT IF EXISTS`
-- exists, but the ADD form does not. Guard on the catalog instead so the migration stays
-- re-runnable.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'workspace.principals'::regclass
          and conname  = 'principals_workos_user_id_key'
    ) then
        alter table workspace.principals
            add constraint principals_workos_user_id_key unique (workos_user_id);
    end if;
end $$;

-- Prevent a blank string from matching a null email during bootstrap.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'workspace.principals'::regclass
          and conname  = 'principals_email_nonempty'
    ) then
        alter table workspace.principals
            add constraint principals_email_nonempty
                check (email is null or length(btrim(email)) > 0);
    end if;
end $$;

-- Case-insensitive uniqueness on email (lowercased + trimmed).
-- `Owner@Example.com` and `owner@example.com` must not create two principals.
create unique index if not exists principals_email_lower_key
    on workspace.principals (lower(btrim(email)))
    where email is not null;

-- ── Shared internal resolver ──────────────────────────────────────────────────
--
-- The sensitivity rule (sensitive domains never implicit, even for administrator)
-- lives HERE and ONLY HERE. Both public resolvers delegate to this function.
-- Changing the rule means changing one function, not two.

create or replace function workspace._resolve_domains_for_principal(
    p workspace.principals
)
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_domains text[];
begin
    -- Administrators resolve to every NON-SENSITIVE domain plus any sensitive
    -- domain explicitly granted to them. Sensitive domains are never implicit,
    -- so a sensitive domain requires a deliberate row in access_grants even for
    -- an administrator. This mirrors the body from 0002_access_model.sql exactly.
    if p.role = 'administrator' then
        select coalesce(array_agg(distinct d.domain), array[]::text[])
        into v_domains
        from workspace.domains d
        where d.sensitive is false
           or exists (
               select 1 from workspace.access_grants g
               where g.principal_id = p.id
                 and g.domain = d.domain
           );
        return v_domains;
    end if;

    select coalesce(array_agg(distinct g.domain), array[]::text[])
    into v_domains
    from workspace.access_grants g
    where g.principal_id = p.id;

    return v_domains;
end;
$$;

comment on function workspace._resolve_domains_for_principal(workspace.principals) is
    'Internal: granted domains for a principal row. The sensitivity rule lives here '
    'and ONLY here — never duplicate this logic. Called by both public resolvers.';

-- Not public-facing; accessible only through the SECURITY DEFINER public resolvers.
revoke all on function workspace._resolve_domains_for_principal(workspace.principals) from public;

-- ── Rewrite resolve_domains to delegate ──────────────────────────────────────
--
-- Preserves the existing signature and contract so nothing currently calling it
-- changes. The body is now a thin lookup-and-delegate.

create or replace function workspace.resolve_domains(p_token_hash text)
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal workspace.principals%rowtype;
begin
    -- Fail closed: every unresolved path returns an EMPTY array, never null and
    -- never every domain. `domains && resolved` on an empty array matches zero rows.
    if p_token_hash is null or length(btrim(p_token_hash)) = 0 then
        return array[]::text[];
    end if;

    select * into v_principal
    from workspace.principals p
    where p.token_hash = p_token_hash
      and p.active is true;

    if not found then
        return array[]::text[];
    end if;

    return workspace._resolve_domains_for_principal(v_principal);
end;
$$;

comment on function workspace.resolve_domains(text) is
    'Token hash -> granted domains. Returns an empty array for unknown, inactive, '
    'or absent tokens. Empty must mean zero rows, never all rows. '
    'Delegates to _resolve_domains_for_principal for the sensitivity rule.';

revoke all on function workspace.resolve_domains(text) from public;
grant execute on function workspace.resolve_domains(text) to service_role;

-- ── resolve_domains_for_workos_user — PRIMARY OAuth resolver ─────────────────
--
-- Keyed on the WorkOS `sub`. This is the steady-state OAuth resolution path.
-- Email is never passed here; it is only used during bootstrap (below).

create or replace function workspace.resolve_domains_for_workos_user(p_sub text)
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal workspace.principals%rowtype;
begin
    if p_sub is null or length(btrim(p_sub)) = 0 then
        return array[]::text[];
    end if;

    select * into v_principal
    from workspace.principals p
    where p.workos_user_id = p_sub
      and p.active is true;

    if not found then
        return array[]::text[];
    end if;

    return workspace._resolve_domains_for_principal(v_principal);
end;
$$;

comment on function workspace.resolve_domains_for_workos_user(text) is
    'WorkOS sub -> granted domains. PRIMARY OAuth resolution path. '
    'Fail-closed: null, blank, unknown, and inactive all return array[]::text[]. '
    'Delegates to _resolve_domains_for_principal for the sensitivity rule.';

revoke all on function workspace.resolve_domains_for_workos_user(text) from public;
-- kb_engine role is granted in 0018_kb_engine_role.sql

-- ── resolve_domains_for_email — BOOTSTRAP-ONLY resolver ──────────────────────
--
-- Used once, on the FIRST OAuth login of a principal whose workos_user_id is null.
-- After the engine calls this and pins the sub, this function is never used again
-- for that principal. Email is low-entropy; do not use it for steady-state authz.

create or replace function workspace.resolve_domains_for_email(p_email text)
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal workspace.principals%rowtype;
    v_normalised text;
begin
    if p_email is null or length(btrim(p_email)) = 0 then
        return array[]::text[];
    end if;

    v_normalised := lower(btrim(p_email));

    -- Bootstrap-only: only matches when workos_user_id is null (not yet claimed).
    -- Once pinned, this path returns empty — resolution is via workos_user_id only.
    select * into v_principal
    from workspace.principals p
    where lower(btrim(p.email)) = v_normalised
      and p.active is true
      and p.workos_user_id is null;

    if not found then
        return array[]::text[];
    end if;

    return workspace._resolve_domains_for_principal(v_principal);
end;
$$;

comment on function workspace.resolve_domains_for_email(text) is
    'Email -> granted domains. BOOTSTRAP ONLY — used when workos_user_id is null. '
    'Once pinned, returns empty (steady-state is resolve_domains_for_workos_user). '
    'Fail-closed: null, blank, unknown, inactive, already-claimed all return array[].';

revoke all on function workspace.resolve_domains_for_email(text) from public;
-- kb_engine role is granted in 0018_kb_engine_role.sql (for the pin-on-first-login path)

-- No owner email is seeded here. The owner principal and its email come from
-- the Engine config (workspace.engine_config_apply, migration 0029).
-- workos_user_id stays NULL until the first OAuth login claims and pins it (TOFU).

-- ── Seed the embed-only engine principal ─────────────────────────────────────
-- The kb-engine principal has zero domain grants so it can call the embed edge
-- function (which checks principal_can_embed) but reads no documents.
-- token_hash is null until `mint_token.py --handle kb-engine --write-env` is run
-- during deployment provisioning.

insert into workspace.principals (handle, display_name, role)
values ('kb-engine', 'KB Engine (embed-only)', 'reader')
on conflict (handle) do nothing;


-- ROLLBACK -------------------------------------------------------------------
-- delete from workspace.principals where handle = 'kb-engine';
-- drop function if exists workspace.resolve_domains_for_email(text);
-- drop function if exists workspace.resolve_domains_for_workos_user(text);
-- drop function if exists workspace._resolve_domains_for_principal(workspace.principals);
-- -- restore original resolve_domains body from 0002_access_model.sql
-- drop index if exists workspace.principals_email_lower_key;
-- alter table workspace.principals drop constraint if exists principals_email_nonempty;
-- alter table workspace.principals drop constraint if exists principals_workos_user_id_key;
-- alter table workspace.principals drop column if exists workos_user_id;
-- alter table workspace.principals drop column if exists email;
