-- 0002_access_model.sql
--
-- Role-to-domain access model for workspace.documents.
--
-- Design note (supersedes the plan's original shape):
--
--   The plan proposed `documents_search(..., caller_domains text[])` -- the caller
--   supplies the domain list. That is a retrieval FILTER, not a boundary: any caller
--   able to reach the RPC can pass every domain that exists. The domain list is
--   therefore resolved INSIDE the database from an opaque token hash, and callers
--   never supply domains as data.
--
--   Full RLS policies on workspace.documents remain deferred -- the engine's identity
--   model is not settled. What is NOT deferred: RLS-enabled-with-no-policy plus
--   explicit REVOKE on every table here. This table holds credential material.
--
--   RLS is not coupled to Supabase auth. When the policy model is designed, the
--   pattern is a GUC:
--       using (domains && workspace.resolve_domains(current_setting('app.token_hash', true)))

-- Domain registry -----------------------------------------------------------
-- The taxonomy is DATA, not a hardcoded list in application code. Connectors
-- validate their emitted domains against this table.

create table if not exists workspace.domains (
    domain      text primary key,
    label       text        not null,
    description text,
    sensitive   boolean     not null default false,
    created_at  timestamptz not null default now(),
    constraint domains_slug_format check (domain ~ '^[a-z][a-z0-9-]*$')
);

comment on column workspace.domains.sensitive is
    'Requires a deliberate, explicit grant. Never included in a bulk or default grant.';

-- No topics are seeded here. Each Engine's topics come from its own config
-- (workspace.domains_apply, migration 0030).

-- Principals ----------------------------------------------------------------

create table if not exists workspace.principals (
    id           uuid primary key default gen_random_uuid(),
    handle       text        not null unique,
    display_name text        not null,
    role         text        not null,
    -- Hash only. A plaintext token is never stored, logged, or returned.
    -- Null means "no token issued yet" and can never resolve.
    token_hash   text        unique,
    active       boolean     not null default true,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    constraint principals_role_values
        check (role in ('reader', 'reviewer', 'administrator'))
);

comment on column workspace.principals.token_hash is
    'SHA-256 of the bearer token. Null = no token issued. Never store plaintext.';

drop trigger if exists principals_set_updated_at on workspace.principals;
create trigger principals_set_updated_at
    before update on workspace.principals
    for each row
    execute function workspace.set_updated_at();

-- Grants --------------------------------------------------------------------

create table if not exists workspace.access_grants (
    principal_id uuid        not null references workspace.principals(id) on delete cascade,
    domain       text        not null references workspace.domains(domain) on delete restrict,
    granted_at   timestamptz not null default now(),
    granted_by   text,
    primary key (principal_id, domain)
);

-- Resolution ----------------------------------------------------------------

create or replace function workspace.resolve_domains(p_token_hash text)
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal workspace.principals%rowtype;
    v_domains   text[];
begin
    -- Fail closed. Every unresolved path returns an EMPTY array, never null and
    -- never every domain. Downstream `domains && resolved` on an empty array
    -- matches zero rows, which is the intended behaviour.
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

    -- Administrators resolve to every NON-SENSITIVE domain plus any sensitive
    -- domain explicitly granted to them. Sensitive domains are never implicit,
    -- so a sensitive domain requires a deliberate row in access_grants even for
    -- an administrator.
    if v_principal.role = 'administrator' then
        select coalesce(array_agg(distinct d.domain), array[]::text[])
        into v_domains
        from workspace.domains d
        where d.sensitive is false
           or exists (
               select 1 from workspace.access_grants g
               where g.principal_id = v_principal.id
                 and g.domain = d.domain
           );
        return v_domains;
    end if;

    select coalesce(array_agg(distinct g.domain), array[]::text[])
    into v_domains
    from workspace.access_grants g
    where g.principal_id = v_principal.id;

    return v_domains;
end;
$$;

comment on function workspace.resolve_domains(text) is
    'Token hash -> granted domains. Returns an empty array for unknown, inactive, '
    'or absent tokens. Empty must mean zero rows, never all rows.';

-- No principal is seeded here. The owner becomes the first administrator
-- when the Engine config is first applied (workspace.engine_config_apply,
-- migration 0029). Tokens are minted out of band and never live in a
-- migration file.

-- Access posture ------------------------------------------------------------

alter table workspace.domains       enable row level security;
alter table workspace.principals    enable row level security;
alter table workspace.access_grants enable row level security;

revoke all on workspace.domains       from anon, authenticated;
revoke all on workspace.principals    from anon, authenticated;
revoke all on workspace.access_grants from anon, authenticated;

revoke all on function workspace.resolve_domains(text) from anon, authenticated;


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.resolve_domains(text);
-- drop table if exists workspace.access_grants;
-- drop table if exists workspace.principals;
-- drop table if exists workspace.domains;
