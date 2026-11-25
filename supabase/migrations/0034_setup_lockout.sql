-- 0034_setup_lockout.sql
--
-- A lockout for the one-time setup code, kept in the database so a restart of
-- the service does not reset it.
--
--   5 wrong codes inside 15 minutes  ->  setup is locked for 1 hour.
--
-- While locked, no code is accepted, right or wrong, with one exception: a
-- setup that was already under way. Completing setup takes a minute or more
-- (the service changes things outside the database in between), so a correct
-- code that engine_setup_code_valid() accepted in the last 10 minutes may
-- still complete after a lock begins. Otherwise anyone could spoil a running
-- setup by sending five wrong codes while it runs.
--
-- The counter lives on the single engine_settings row (0029). No role gets a
-- table grant; every path is a SECURITY DEFINER function:
--
--   engine_setup_attempt_check()        kb_engine   is setup locked right now?
--   engine_setup_attempt_fail()         kb_engine   record one wrong code
--   engine_setup_code_valid(code)       kb_engine   does this code open setup?
--   engine_setup_complete(code, access) kb_engine   (0029, now lockout-aware)
--   engine_setup_reopen(code_hash)      kb_ingest   (0029, now clears the lock)
--
-- The service compares the code against its own SETUP_CODE first and calls
-- engine_setup_attempt_fail() for a wrong one. The database then checks the
-- code again against its stored hash, and counts a wrong code there too, so
-- the limit holds even for a caller that skips the service's own check.
--
-- `access.level`, stored by setup, is one of: "owner" | "people" | "domain".

alter table workspace.engine_settings
    add column if not exists setup_failed_at    timestamptz[] not null default '{}',
    add column if not exists setup_locked_until timestamptz,
    add column if not exists setup_code_ok_at   timestamptz;

comment on column workspace.engine_settings.setup_failed_at is
    'Times of recent wrong setup codes (only the last 15 minutes are kept).';
comment on column workspace.engine_settings.setup_locked_until is
    'Setup accepts no code until this time. Null when not locked.';
comment on column workspace.engine_settings.setup_code_ok_at is
    'When the right setup code was last checked. Lets a setup already under way finish.';

-- ── helpers (not callable by any service role) ──────────────────────────────

create or replace function workspace._setup_lock_state(
    p_failed_at timestamptz[], p_locked_until timestamptz)
returns jsonb
language sql
stable
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object(
        'locked', coalesce(p_locked_until > now(), false),
        'retry_after_seconds',
            case when p_locked_until > now()
                 then ceil(extract(epoch from (p_locked_until - now())))::integer
                 else 0 end,
        'failures',
            case when p_locked_until > now() then 0
                 else (select count(*) from unnest(coalesce(p_failed_at, '{}')) t
                       where t > now() - interval '15 minutes') end
    );
$$;

revoke all on function workspace._setup_lock_state(timestamptz[], timestamptz) from public;

-- Record one wrong code. Locks the row, so two requests cannot both slip
-- under the limit. Does nothing while already locked.
create or replace function workspace._setup_record_failure()
returns jsonb
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_row    workspace.engine_settings%rowtype;
    v_recent timestamptz[];
begin
    select * into v_row from workspace.engine_settings s where s.id for update;
    if not found then
        -- No settings row: nothing can be set up. Report it as locked.
        return jsonb_build_object('locked', true, 'retry_after_seconds', 3600, 'failures', 0);
    end if;

    if v_row.setup_locked_until is not null and v_row.setup_locked_until > now() then
        return workspace._setup_lock_state(v_row.setup_failed_at, v_row.setup_locked_until);
    end if;

    select coalesce(array_agg(t order by t), '{}') into v_recent
    from unnest(v_row.setup_failed_at) t
    where t > now() - interval '15 minutes';
    v_recent := v_recent || clock_timestamp();

    if cardinality(v_recent) >= 5 then
        update workspace.engine_settings
        set setup_failed_at = '{}',
            setup_locked_until = now() + interval '1 hour'
        where id
        returning * into v_row;
    else
        update workspace.engine_settings
        set setup_failed_at = v_recent,
            setup_locked_until = null
        where id
        returning * into v_row;
    end if;

    return workspace._setup_lock_state(v_row.setup_failed_at, v_row.setup_locked_until);
end;
$$;

revoke all on function workspace._setup_record_failure() from public;

-- ── engine_setup_attempt_check ───────────────────────────────────────────────

create or replace function workspace.engine_setup_attempt_check()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(
        (select workspace._setup_lock_state(s.setup_failed_at, s.setup_locked_until)
         from workspace.engine_settings s where s.id),
        -- No settings row: fail closed.
        jsonb_build_object('locked', true, 'retry_after_seconds', 3600, 'failures', 0)
    );
$$;

comment on function workspace.engine_setup_attempt_check() is
    'Whether setup is locked after too many wrong codes, and for how long.';

revoke all on function workspace.engine_setup_attempt_check() from public;
grant execute on function workspace.engine_setup_attempt_check() to kb_engine;

-- ── engine_setup_attempt_fail ────────────────────────────────────────────────

create or replace function workspace.engine_setup_attempt_fail()
returns jsonb
language sql
security definer
set search_path = workspace, pg_temp
as $$
    select workspace._setup_record_failure();
$$;

comment on function workspace.engine_setup_attempt_fail() is
    'Record one wrong setup code. The fifth inside 15 minutes locks setup for an hour.';

revoke all on function workspace.engine_setup_attempt_fail() from public;
grant execute on function workspace.engine_setup_attempt_fail() to kb_engine;

-- ── engine_setup_code_valid ──────────────────────────────────────────────────
--
-- Lets the setup page find out, before it changes anything outside the
-- database, that the code it was given is the one the database holds. It
-- does not spend the code. A wrong code counts toward the lockout, so this
-- cannot be used to guess. A closed window (or no stored code) is false and
-- not counted. A right code is noted (setup_code_ok_at).

create or replace function workspace.engine_setup_code_valid(p_code text)
returns boolean
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_row workspace.engine_settings%rowtype;
begin
    select * into v_row from workspace.engine_settings s where s.id;

    if not found
       or v_row.setup_state <> 'open'
       or v_row.setup_code_hash is null
       or (v_row.setup_locked_until is not null and v_row.setup_locked_until > now())
    then
        return false;
    end if;

    if p_code is null
       or length(p_code) = 0
       or encode(sha256(convert_to(p_code, 'UTF8')), 'hex') <> v_row.setup_code_hash
    then
        perform workspace._setup_record_failure();
        return false;
    end if;

    -- Remember that the right code was just seen, so this setup can finish
    -- even if someone else's wrong guesses lock the page meanwhile.
    update workspace.engine_settings set setup_code_ok_at = now() where id;
    return true;
end;
$$;

comment on function workspace.engine_setup_code_valid(text) is
    'True when the code would open setup right now. Spends nothing; a wrong '
    'code counts toward the lockout.';

revoke all on function workspace.engine_setup_code_valid(text) from public;
grant execute on function workspace.engine_setup_code_valid(text) to kb_engine;

-- ── engine_setup_complete (replaces 0029's) ──────────────────────────────────
--
-- Same contract as before, plus: nothing is accepted while locked (unless the
-- right code was checked in the 10 minutes before, see the top of this file),
-- a wrong code counts toward the lockout, and success clears the counter.

create or replace function workspace.engine_setup_complete(p_code text, p_access jsonb)
returns boolean
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_row    workspace.engine_settings%rowtype;
    v_locked boolean;
begin
    -- Lock the row so two requests cannot both spend the same code.
    select * into v_row from workspace.engine_settings s where s.id for update;

    if not found
       or v_row.setup_state <> 'open'
       or v_row.setup_code_hash is null
    then
        return false;
    end if;

    v_locked := v_row.setup_locked_until is not null and v_row.setup_locked_until > now();
    -- Locked, and no right code was checked shortly before: nothing is looked at.
    if v_locked
       and (v_row.setup_code_ok_at is null
            or v_row.setup_code_ok_at <= now() - interval '10 minutes')
    then
        return false;
    end if;

    if p_code is null
       or length(p_code) = 0
       or encode(sha256(convert_to(p_code, 'UTF8')), 'hex') <> v_row.setup_code_hash
    then
        -- (While locked, a failure changes nothing: the lock already holds.)
        perform workspace._setup_record_failure();
        return false;
    end if;

    -- A right code with unusable settings raises (nothing is stored and the
    -- code is NOT spent), so a typo cannot lock the Engine out. The same
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
    -- The dashboard's sign-in app must not be the connector's: one sign-in
    -- must never open both.
    if p_access ? 'status_aud' and p_access->>'status_aud' = p_access->>'aud' then
        raise exception 'access.status_aud must differ from access.aud' using errcode = '22023';
    end if;

    update workspace.engine_settings
    set access = p_access,
        setup_state = 'complete',
        setup_code_hash = null,
        setup_failed_at = '{}',
        setup_locked_until = null,
        setup_code_ok_at = null
    where id;

    return true;
end;
$$;

comment on function workspace.engine_setup_complete(text, jsonb) is
    'Spend the one-time setup code: store the sign-in settings and close the '
    'window. False, and no change, for a wrong code, a closed window, or '
    'while setup is locked (unless the right code was checked just before).';

revoke all on function workspace.engine_setup_complete(text, jsonb) from public;
grant execute on function workspace.engine_setup_complete(text, jsonb) to kb_engine;

-- ── engine_setup_reopen (replaces 0029's) ────────────────────────────────────
--
-- A new code is a fresh start: it also clears the wrong-code counter and any
-- lock. This is the way out for an owner who has been locked out by someone
-- else's guesses.

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
        setup_opened_at = now(),
        setup_failed_at = '{}',
        setup_locked_until = null,
        setup_code_ok_at = null
    where id;
end;
$$;

comment on function workspace.engine_setup_reopen(text) is
    'Open the setup window with a new one-time code (given as its SHA-256 hex). '
    'Clears the wrong-code counter and any lock.';

revoke all on function workspace.engine_setup_reopen(text) from public;
grant execute on function workspace.engine_setup_reopen(text) to kb_ingest;


-- VERIFY ------------------------------------------------------------------
-- select workspace.engine_setup_attempt_check();        -- {"locked": false, ...}
-- select workspace.engine_settings_public() ? 'setup_failed_at';   -- expect false
-- select has_function_privilege('anon',
--   'workspace.engine_setup_attempt_fail()', 'execute'); -- expect false
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_engine';                          -- expect 0


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply 0029_engine_settings.sql to restore the earlier
-- engine_setup_complete and engine_setup_reopen, then:
-- drop function if exists workspace.engine_setup_code_valid(text);
-- drop function if exists workspace.engine_setup_attempt_fail();
-- drop function if exists workspace.engine_setup_attempt_check();
-- drop function if exists workspace._setup_record_failure();
-- drop function if exists workspace._setup_lock_state(timestamptz[], timestamptz);
-- alter table workspace.engine_settings
--     drop column if exists setup_code_ok_at,
--     drop column if exists setup_locked_until,
--     drop column if exists setup_failed_at;
