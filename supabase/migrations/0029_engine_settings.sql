-- 0029_engine_settings.sql
--
-- One row of settings for the whole Engine: the applied config
-- (.kb-engine/engine.yaml, validated before it gets here), the non-secret
-- sign-in settings, and the state of the one-time setup window.
--
-- Who may do what -- every path is a SECURITY DEFINER function; no role gets a
-- table grant, and RLS is on with no policy, so a direct read returns nothing:
--
--   engine_config_apply(config, hash)   kb_ingest, service_role
--   engine_config_get()                 kb_ingest
--   engine_settings_public()            kb_engine   (never the setup code hash)
--   engine_setup_complete(code, access) kb_engine   (only while 'open')
--   engine_setup_reopen(code_hash)      kb_ingest
--
-- THE SETUP CODE. The database stores only a hash:
--     setup_code_hash = lower-case hex SHA-256 of the UTF-8 code
--     python: hashlib.sha256(code.encode("utf-8")).hexdigest()
--     sql:    encode(sha256(convert_to(code, 'UTF8')), 'hex')
-- The code must be long and random (the CLI generates 32 random bytes), which
-- is why a plain, unsalted SHA-256 is enough -- the same reasoning as
-- principals.token_hash. It works once: a correct code closes the window and
-- erases the hash. A wrong code changes nothing and returns false.
--
-- `access` holds what the sign-in check needs and nothing secret:
--     { "team_domain": "https://<team>.cloudflareaccess.com",
--       "aud": "<AUD tag of the /mcp app>",
--       "status_aud": "<AUD tag of the /status app>",   (optional)
--       "host": "<public hostname>",
--       "resource_url": "https://<host>/mcp",          (optional)
--       "level": "owner" | "named" | "domain" }        (optional)
--
-- engine_config_apply() calls workspace.domains_apply(), created in 0030.
-- Apply both before applying a config.

create table if not exists workspace.engine_settings (
    -- A boolean key that can only be true: the table holds at most one row.
    id                boolean     primary key default true,
    config            jsonb,
    config_hash       text,
    config_applied_at timestamptz,
    access            jsonb,
    setup_state       text        not null default 'open',
    setup_code_hash   text,
    setup_opened_at   timestamptz,
    updated_at        timestamptz not null default now(),
    constraint engine_settings_single_row check (id),
    constraint engine_settings_setup_state_values
        check (setup_state in ('open', 'complete')),
    constraint engine_settings_access_is_object
        check (access is null or jsonb_typeof(access) = 'object'),
    constraint engine_settings_config_is_object
        check (config is null or jsonb_typeof(config) = 'object')
);

comment on table workspace.engine_settings is
    'Single-row Engine settings. Reached only through SECURITY DEFINER functions.';
comment on column workspace.engine_settings.setup_code_hash is
    'Hex SHA-256 of the one-time setup code. Never returned by any function.';

drop trigger if exists engine_settings_set_updated_at on workspace.engine_settings;
create trigger engine_settings_set_updated_at
    before update on workspace.engine_settings
    for each row
    execute function workspace.set_updated_at();

insert into workspace.engine_settings (id) values (true)
on conflict (id) do nothing;

alter table workspace.engine_settings enable row level security;
revoke all on workspace.engine_settings from public;
revoke all on workspace.engine_settings from anon, authenticated;

-- ── engine_config_get ────────────────────────────────────────────────────────

create or replace function workspace.engine_config_get()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select s.config from workspace.engine_settings s where s.id;
$$;

comment on function workspace.engine_config_get() is
    'The applied Engine config, or null when none has been applied.';

revoke all on function workspace.engine_config_get() from public;
grant execute on function workspace.engine_config_get() to kb_ingest;

-- ── engine_settings_public ───────────────────────────────────────────────────

create or replace function workspace.engine_settings_public()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    -- Built field by field on purpose: a new column is never exposed by
    -- accident, and setup_code_hash is not named here at all.
    select jsonb_build_object(
        'config',            s.config,
        'config_hash',       s.config_hash,
        'config_applied_at', s.config_applied_at,
        'access',            s.access,
        'setup_state',       s.setup_state
    )
    from workspace.engine_settings s
    where s.id;
$$;

comment on function workspace.engine_settings_public() is
    'Config, sign-in settings and setup state for the service. Never the setup code hash.';

revoke all on function workspace.engine_settings_public() from public;
grant execute on function workspace.engine_settings_public() to kb_engine;

-- ── engine_config_apply ──────────────────────────────────────────────────────
--
-- Stores a config, makes sure its owner is an administrator, and applies its
-- topics. One transaction: if any step refuses, nothing changes and the last
-- good config stays in force.
--
-- The owner rule is deliberately narrow, because the pullers' role may call
-- this. It creates or promotes the owner ONLY when the Engine has no active
-- administrator yet (first apply). After that, a config naming an owner who is
-- not already an active administrator is refused: changing the owner is an
-- administrator's act, never a side effect of a config file.

create or replace function workspace.engine_config_apply(p_config jsonb, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_email   text;
    v_name    text;
    v_handle  text;
    v_owner   workspace.principals%rowtype;
    v_domains jsonb;
begin
    if p_config is null or jsonb_typeof(p_config) <> 'object' then
        raise exception 'config must be a JSON object' using errcode = '22023';
    end if;
    if p_config->>'version' is distinct from '1' then
        raise exception 'config version must be 1' using errcode = '22023';
    end if;
    if p_hash is null or length(btrim(p_hash)) = 0 then
        raise exception 'config hash is required' using errcode = '22023';
    end if;

    v_email := lower(btrim(p_config #>> '{engine,owner,email}'));
    if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'config engine.owner.email is required' using errcode = '22023';
    end if;

    v_domains := coalesce(p_config->'domains', '[]'::jsonb);
    if jsonb_typeof(v_domains) <> 'array' then
        raise exception 'config domains must be a list' using errcode = '22023';
    end if;

    select * into v_owner
    from workspace.principals p
    where lower(btrim(p.email)) = v_email;

    if not found or v_owner.role <> 'administrator' or not v_owner.active then
        -- Any active administrator counts, with or without an email.
        if exists (
            select 1 from workspace.principals p
            where p.role = 'administrator' and p.active
        ) then
            raise exception
                'the config names an owner who is not an active administrator; '
                'an administrator must change the owner'
                using errcode = '42501';
        end if;

        if v_owner.id is not null then
            update workspace.principals
            set role = 'administrator', active = true
            where id = v_owner.id;
        else
            v_name := coalesce(nullif(btrim(p_config #>> '{engine,owner,names,0}'), ''), v_email);
            v_handle := regexp_replace(split_part(v_email, '@', 1), '[^a-z0-9._-]', '-', 'g');
            if exists (select 1 from workspace.principals p where p.handle = v_handle) then
                v_handle := v_handle || '-' || substr(md5(v_email), 1, 6);
            end if;
            insert into workspace.principals (handle, display_name, role, email, active)
            values (v_handle, v_name, 'administrator', v_email, true);
        end if;
    end if;

    update workspace.engine_settings
    set config = p_config,
        config_hash = p_hash,
        config_applied_at = now()
    where id;

    perform workspace.domains_apply(v_domains);

    return jsonb_build_object('config_hash', p_hash, 'owner_email', v_email);
end;
$$;

comment on function workspace.engine_config_apply(jsonb, text) is
    'Store a validated config, ensure the owner administrator on first apply, '
    'and apply its topics. All or nothing.';

revoke all on function workspace.engine_config_apply(jsonb, text) from public;
grant execute on function workspace.engine_config_apply(jsonb, text) to kb_ingest, service_role;

-- ── engine_setup_complete ────────────────────────────────────────────────────

create or replace function workspace.engine_setup_complete(p_code text, p_access jsonb)
returns boolean
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_row workspace.engine_settings%rowtype;
begin
    -- Lock the row so two requests cannot both spend the same code.
    select * into v_row from workspace.engine_settings s where s.id for update;

    if not found
       or v_row.setup_state <> 'open'
       or v_row.setup_code_hash is null
       or p_code is null
       or length(p_code) = 0
       or encode(sha256(convert_to(p_code, 'UTF8')), 'hex') <> v_row.setup_code_hash
    then
        return false;
    end if;

    -- A right code with unusable settings raises (nothing is stored and the
    -- code is NOT spent), so a typo cannot lock the Engine out. The same two
    -- shape rules are enforced again by the service when it reads the row.
    if p_access is null
       or jsonb_typeof(p_access) <> 'object'
       or coalesce(btrim(p_access->>'aud'), '') = ''
    then
        raise exception 'access needs team_domain, aud and host' using errcode = '22023';
    end if;
    if coalesce(p_access->>'team_domain', '') !~ '^https://[a-z0-9-]+\.cloudflareaccess\.com/?$' then
        raise exception 'access.team_domain must be https://<team>.cloudflareaccess.com'
            using errcode = '22023';
    end if;
    if coalesce(p_access->>'host', '') !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' then
        raise exception 'access.host must be a bare hostname' using errcode = '22023';
    end if;

    update workspace.engine_settings
    set access = p_access,
        setup_state = 'complete',
        setup_code_hash = null
    where id;

    return true;
end;
$$;

comment on function workspace.engine_setup_complete(text, jsonb) is
    'Spend the one-time setup code: store the sign-in settings and close the '
    'window. False, and no change, for a wrong code or a closed window.';

revoke all on function workspace.engine_setup_complete(text, jsonb) from public;
grant execute on function workspace.engine_setup_complete(text, jsonb) to kb_engine;

-- ── engine_setup_reopen ──────────────────────────────────────────────────────
--
-- Opens the setup window again with a new code hash. The sign-in settings
-- already stored stay in force until a new setup completes.

create or replace function workspace.engine_setup_reopen(p_code_hash text)
returns void
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
begin
    if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'setup code hash must be 64 lower-case hex characters (SHA-256)'
            using errcode = '22023';
    end if;

    update workspace.engine_settings
    set setup_state = 'open',
        setup_code_hash = p_code_hash,
        setup_opened_at = now()
    where id;
end;
$$;

comment on function workspace.engine_setup_reopen(text) is
    'Open the setup window with a new one-time code (given as its SHA-256 hex).';

revoke all on function workspace.engine_setup_reopen(text) from public;
grant execute on function workspace.engine_setup_reopen(text) to kb_ingest;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_engine';                          -- expect 0
-- select workspace.engine_settings_public() ? 'setup_code_hash';   -- expect false
-- select has_function_privilege('anon',
--   'workspace.engine_settings_public()', 'execute');    -- expect false


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.engine_setup_reopen(text);
-- drop function if exists workspace.engine_setup_complete(text, jsonb);
-- drop function if exists workspace.engine_config_apply(jsonb, text);
-- drop function if exists workspace.engine_settings_public();
-- drop function if exists workspace.engine_config_get();
-- drop table if exists workspace.engine_settings;
