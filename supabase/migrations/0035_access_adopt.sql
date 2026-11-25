-- 0035_access_adopt.sql
--
-- Two functions for the setup command line (`kbe access`) and the pullers,
-- both SECURITY DEFINER and executable by kb_ingest only, in the manner of
-- 0029. No role gets a table grant. Needs 0034 (it clears the lockout columns).
--
--   engine_access_status()        kb_ingest   where setup stands (no secrets)
--   engine_access_adopt(access)   kb_ingest   store sign-in settings that were
--                                             made by hand; close setup
--
-- engine_access_status() is also what the pullers ask before they ingest:
-- nothing is indexed until sign-in settings exist (see pullers/access_gate.py).
-- It never returns the setup code hash, only whether one is set.
--
-- engine_access_adopt() is for a deployment whose Cloudflare applications were
-- created before the setup page existed. It takes the same non-secret values
-- the setup page stores, checks them by the same rules as
-- engine_setup_complete(), and marks setup complete. It needs no setup code:
-- it is reached from the owner's machine with the pullers' credential, never
-- from the service (kb_engine may not run it).
--
-- AN EXISTING DEPLOYMENT that gives the service its sign-in settings through
-- variables (CF_ACCESS_TEAM_DOMAIN and the rest) has no stored settings. Once
-- this migration is applied and its jobs run the code that goes with it, the
-- jobs wait (cleanly, exit 0) until sign-in settings are known to them. Do
-- one of these right after migrating:
--     python -m kbe access adopt --team-domain ... --aud ... --host ...
--   or give every job the plain variables CF_ACCESS_TEAM_DOMAIN and
--   CF_ACCESS_AUD (`kbe deploy render --cf-team-domain ... --cf-aud ...`).

create or replace function workspace.engine_access_status()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    -- Built field by field on purpose: setup_code_hash is never returned.
    select jsonb_build_object(
        'setup_state',       s.setup_state,
        'setup_code_set',    s.setup_code_hash is not null,
        'setup_opened_at',   s.setup_opened_at,
        'access',            s.access,
        'config_hash',       s.config_hash,
        'config_applied_at', s.config_applied_at
    )
    from workspace.engine_settings s
    where s.id;
$$;

comment on function workspace.engine_access_status() is
    'Setup state, whether a setup code is set, and the non-secret sign-in '
    'settings. Never the setup code hash.';

revoke all on function workspace.engine_access_status() from public;
revoke all on function workspace.engine_access_status() from anon, authenticated;
grant execute on function workspace.engine_access_status() to kb_ingest;

-- ── engine_access_adopt ──────────────────────────────────────────────────────

create or replace function workspace.engine_access_adopt(p_access jsonb)
returns jsonb
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_key    text;
    v_access jsonb;
begin
    if p_access is null or jsonb_typeof(p_access) <> 'object' then
        raise exception 'access must be a JSON object' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(p_access) loop
        if v_key not in ('team_domain', 'aud', 'status_aud', 'host', 'resource_url', 'level') then
            raise exception 'access has a key that is not a sign-in setting: %', v_key
                using errcode = '22023';
        end if;
        if jsonb_typeof(p_access->v_key) <> 'string' then
            raise exception 'access.% must be text', v_key using errcode = '22023';
        end if;
    end loop;

    -- The same shape rules as engine_setup_complete().
    if coalesce(btrim(p_access->>'aud'), '') = '' then
        raise exception 'access needs team_domain, aud and host' using errcode = '22023';
    end if;
    if coalesce(p_access->>'team_domain', '') !~ '^https://[a-z0-9-]+\.cloudflareaccess\.com/?$' then
        raise exception 'access.team_domain must be https://<team>.cloudflareaccess.com'
            using errcode = '22023';
    end if;
    if coalesce(p_access->>'host', '') !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' then
        raise exception 'access.host must be a bare hostname' using errcode = '22023';
    end if;
    -- The service treats stored settings it cannot use as a broken Engine
    -- (503 on every route), so nothing it would reject may be stored here.
    if p_access ? 'status_aud' and btrim(p_access->>'status_aud') = '' then
        raise exception 'access.status_aud must not be empty' using errcode = '22023';
    end if;
    -- The dashboard's sign-in app must not be the connector's.
    if p_access ? 'status_aud' and p_access->>'status_aud' = p_access->>'aud' then
        raise exception 'access.status_aud must differ from access.aud' using errcode = '22023';
    end if;
    if p_access ? 'level' and p_access->>'level' not in ('owner', 'people', 'domain') then
        raise exception 'access.level must be owner, people or domain' using errcode = '22023';
    end if;

    -- The connector's address is derived from the hostname, never free text.
    if p_access ? 'resource_url'
       and p_access->>'resource_url' <> 'https://' || (p_access->>'host') || '/mcp' then
        raise exception 'access.resource_url must be https://<host>/mcp' using errcode = '22023';
    end if;

    v_access := p_access;
    if not (v_access ? 'resource_url') then
        v_access := v_access
            || jsonb_build_object('resource_url', 'https://' || (p_access->>'host') || '/mcp');
    end if;

    update workspace.engine_settings
    set access = v_access,
        setup_state = 'complete',
        setup_code_hash = null,
        -- As engine_setup_complete() does (0034): no stale lock is left behind.
        setup_failed_at = '{}',
        setup_locked_until = null,
        setup_code_ok_at = null
    where id;
    if not found then
        raise exception 'engine settings row is missing' using errcode = 'P0002';
    end if;

    return workspace.engine_access_status();
end;
$$;

comment on function workspace.engine_access_adopt(jsonb) is
    'Store sign-in settings made by hand (non-secret values only) and mark '
    'setup complete. Erases any setup code.';

revoke all on function workspace.engine_access_adopt(jsonb) from public;
revoke all on function workspace.engine_access_adopt(jsonb) from anon, authenticated;
grant execute on function workspace.engine_access_adopt(jsonb) to kb_ingest;


-- VERIFY ------------------------------------------------------------------
-- select workspace.engine_access_status() ? 'setup_code_hash';     -- expect false
-- select has_function_privilege('kb_engine',
--   'workspace.engine_access_adopt(jsonb)', 'execute');            -- expect false
-- select has_function_privilege('anon',
--   'workspace.engine_access_status()', 'execute');                -- expect false


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.engine_access_adopt(jsonb);
-- drop function if exists workspace.engine_access_status();
