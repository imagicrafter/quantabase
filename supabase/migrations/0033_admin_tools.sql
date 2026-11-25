-- 0033_admin_tools.sql
--
-- People and topic administration from the connector, in two steps.
--
--   1. *_preview  validates the request and returns a plain description of
--                 exactly what will change, plus a one-time confirmation code.
--   2. *_apply    takes the SAME arguments plus the code and makes the change.
--
-- The code is random, stored only as a hash, valid for 10 minutes, usable
-- once, and bound to the administrator it was issued to and to a hash of the
-- exact arguments. One uniform error (KB002) covers every way a code can be
-- wrong, so a caller learns nothing from the failure.
--
-- Every function FIRST re-checks that p_email is an active administrator
-- (42501 otherwise). The service's own checks are a convenience; this is the
-- guard. kb_engine still holds no table grant.
--
-- SQLSTATEs: 42501 not an administrator | 22023 bad argument |
--            KB001 refused by a guard   | KB002 confirmation code not valid

create table if not exists workspace.admin_confirmations (
    id               uuid        primary key default gen_random_uuid(),
    code_hash        text        not null,
    caller_principal uuid        not null references workspace.principals(id) on delete cascade,
    action           text        not null,
    args_hash        text        not null,
    expires_at       timestamptz not null,
    used_at          timestamptz
);

comment on table workspace.admin_confirmations is
    'One-time confirmation codes for admin changes. Holds only a hash of the code.';

create index if not exists admin_confirmations_code_hash_idx
    on workspace.admin_confirmations (code_hash);

alter table workspace.admin_confirmations enable row level security;
revoke all on workspace.admin_confirmations from public;
revoke all on workspace.admin_confirmations from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Internal helpers. No role is granted execute on any of these.
-- ---------------------------------------------------------------------------

create or replace function workspace._admin_hash(p_text text)
returns text
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select encode(sha256(convert_to(coalesce(p_text, ''), 'UTF8')), 'hex');
$$;

-- The caller's principal row, or 42501. FAIL CLOSED: unknown, inactive and
-- non-administrator callers are all refused the same way.
create or replace function workspace._admin_require(p_email text)
returns workspace.principals
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
begin
    v_who := workspace._active_principal_by_email(p_email);
    if v_who.id is null or v_who.role is distinct from 'administrator' then
        raise exception 'administrators only' using errcode = '42501';
    end if;
    return v_who;
end;
$$;

-- Any principal (active or not) by email; 22023 when there is none.
create or replace function workspace._admin_person(p_email text)
returns workspace.principals
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_person workspace.principals%rowtype;
begin
    select * into v_person from workspace.principals p
    where p_email is not null and lower(btrim(p.email)) = lower(btrim(p_email));
    if not found then
        raise exception 'no person with that email on this Engine' using errcode = '22023';
    end if;
    return v_person;
end;
$$;


-- Each action validates, describes the change, and (when p_apply) makes it.
-- Returns {"text": <description>, "audit": {...no email addresses...}}.

create or replace function workspace._admin_do_person_add(
    p_who workspace.principals, p_args jsonb, p_apply boolean
)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_email  text := lower(btrim(p_args->>'email'));
    v_name   text := btrim(coalesce(p_args->>'display_name', ''));
    v_role   text := p_args->>'role';
    v_handle text;
begin
    if v_email is null or length(v_email) > 254
       or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'that is not a valid email address' using errcode = '22023';
    end if;
    if length(v_name) < 1 or length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then
        raise exception 'display name must be 1 to 120 characters' using errcode = '22023';
    end if;
    if v_role is null or v_role not in ('reader', 'reviewer', 'administrator') then
        raise exception 'role must be reader, reviewer or administrator' using errcode = '22023';
    end if;
    if v_role = 'administrator' and not coalesce((p_args->>'admin_ack')::boolean, false) then
        raise exception 'adding an administrator needs the explicit administrator acknowledgement'
            using errcode = 'KB001';
    end if;
    if exists (select 1 from workspace.principals p where lower(btrim(p.email)) = v_email) then
        raise exception 'a person with that email already exists' using errcode = '22023';
    end if;

    v_handle := regexp_replace(split_part(v_email, '@', 1), '[^a-z0-9._-]', '-', 'g');
    if exists (select 1 from workspace.principals p where p.handle = v_handle) then
        v_handle := v_handle || '-' || substr(md5(v_email), 1, 6);
    end if;

    if p_apply then
        insert into workspace.principals (handle, display_name, role, email, active)
        values (v_handle, v_name, v_role, v_email, true);
    end if;

    return jsonb_build_object(
        'text', format('Add %s (%s) as %s. ', v_name, v_email, v_role)
            || case when v_role = 'administrator'
                    then 'An administrator can see every topic that is not marked sensitive and can manage people and topics. '
                    else 'They start with no topics; grant topics separately. ' end
            || 'They must also be allowed through the sign-in layer (the Cloudflare Access policy) '
            || 'before they can connect, unless access is domain-based and their email is on an '
            || 'allowed domain. The Engine holds no Cloudflare credential, so it cannot do that step.',
        'audit', jsonb_build_object('target', v_handle, 'role', v_role));
end;
$$;


create or replace function workspace._admin_do_grant(
    p_who workspace.principals, p_args jsonb, p_apply boolean
)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_topic  text := p_args->>'topic';
    v_person workspace.principals%rowtype;
    v_domain workspace.domains%rowtype;
begin
    if v_topic = 'unclassified' then
        raise exception '"unclassified" can never be granted through these tools'
            using errcode = 'KB001';
    end if;
    v_person := workspace._admin_person(p_args->>'person_email');
    if not v_person.active then
        raise exception 'that person is deactivated' using errcode = '22023';
    end if;
    select * into v_domain from workspace.domains d where d.domain = v_topic;
    if not found then
        raise exception 'unknown topic' using errcode = '22023';
    end if;
    if v_domain.sensitive and not coalesce((p_args->>'sensitive_ack')::boolean, false) then
        raise exception 'this topic is marked sensitive; granting it needs the explicit sensitive acknowledgement'
            using errcode = 'KB001';
    end if;
    if exists (select 1 from workspace.access_grants g
               where g.principal_id = v_person.id and g.domain = v_topic) then
        raise exception 'that person already has this topic' using errcode = '22023';
    end if;

    if p_apply then
        insert into workspace.access_grants (principal_id, domain, granted_by)
        values (v_person.id, v_topic, p_who.handle);
    end if;

    return jsonb_build_object(
        'text', format('Grant the topic "%s" (%s) to %s (%s). They will be able to search and read every document in it.',
                       v_domain.label, v_topic, v_person.display_name, v_person.email)
            || case when v_domain.sensitive then ' This topic is marked SENSITIVE.' else '' end,
        'audit', jsonb_build_object('target', v_person.handle, 'topic', v_topic,
                                    'sensitive', v_domain.sensitive));
end;
$$;


create or replace function workspace._admin_do_revoke(
    p_who workspace.principals, p_args jsonb, p_apply boolean
)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_topic  text := p_args->>'topic';
    v_person workspace.principals%rowtype;
    v_still  boolean;
begin
    if v_topic = 'unclassified' then
        raise exception '"unclassified" is managed by the Engine config, not by these tools'
            using errcode = 'KB001';
    end if;
    v_person := workspace._admin_person(p_args->>'person_email');
    if not exists (select 1 from workspace.access_grants g
                   where g.principal_id = v_person.id and g.domain = v_topic) then
        raise exception 'that person does not have this topic' using errcode = '22023';
    end if;

    if p_apply then
        delete from workspace.access_grants g
        where g.principal_id = v_person.id and g.domain = v_topic;
    end if;

    v_still := v_person.role = 'administrator' and exists (
        select 1 from workspace.domains d where d.domain = v_topic and not d.sensitive);
    return jsonb_build_object(
        'text', format('Remove the topic "%s" from %s (%s).', v_topic, v_person.display_name, v_person.email)
            || case when v_still
                    then ' Note: as an administrator they will still see it, because it is not marked sensitive.'
                    else ' They will no longer be able to search or read its documents.' end,
        'audit', jsonb_build_object('target', v_person.handle, 'topic', v_topic));
end;
$$;


create or replace function workspace._admin_do_person_deactivate(
    p_who workspace.principals, p_args jsonb, p_apply boolean
)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_person workspace.principals%rowtype;
begin
    v_person := workspace._admin_person(p_args->>'person_email');
    if v_person.id = p_who.id then
        raise exception 'you cannot deactivate yourself' using errcode = 'KB001';
    end if;
    if not v_person.active then
        raise exception 'that person is already deactivated' using errcode = '22023';
    end if;
    if v_person.role = 'administrator' and not exists (
        select 1 from workspace.principals p
        where p.role = 'administrator' and p.active and p.id <> v_person.id) then
        raise exception 'the last active administrator cannot be removed' using errcode = 'KB001';
    end if;

    if p_apply then
        update workspace.principals set active = false where id = v_person.id;
    end if;

    return jsonb_build_object(
        'text', format('Deactivate %s (%s), role %s. They will lose all access to this Engine at once. Their topic list is kept but has no effect while they are deactivated.',
                       v_person.display_name, v_person.email, v_person.role),
        'audit', jsonb_build_object('target', v_person.handle, 'role', v_person.role));
end;
$$;


create or replace function workspace._admin_run(
    p_who workspace.principals, p_action text, p_args jsonb, p_apply boolean
)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
begin
    case p_action
        when 'person_add'        then return workspace._admin_do_person_add(p_who, p_args, p_apply);
        when 'grant'             then return workspace._admin_do_grant(p_who, p_args, p_apply);
        when 'revoke'            then return workspace._admin_do_revoke(p_who, p_args, p_apply);
        when 'person_deactivate' then return workspace._admin_do_person_deactivate(p_who, p_args, p_apply);
        else raise exception 'unknown admin action' using errcode = '22023';
    end case;
end;
$$;


create or replace function workspace._admin_preview(p_email text, p_action text, p_args jsonb)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_who     workspace.principals%rowtype;
    v_plan    jsonb;
    v_code    text := replace(gen_random_uuid()::text, '-', '');
    v_expires timestamptz := now() + interval '10 minutes';
begin
    v_who  := workspace._admin_require(p_email);
    v_plan := workspace._admin_run(v_who, p_action, p_args, false);

    delete from workspace.admin_confirmations where expires_at < now() - interval '1 day';
    insert into workspace.admin_confirmations
        (code_hash, caller_principal, action, args_hash, expires_at)
    values (workspace._admin_hash(v_code), v_who.id, p_action,
            workspace._admin_hash(p_action || '|' || p_args::text), v_expires);

    return jsonb_build_object(
        'preview', v_plan->>'text', 'confirm_code', v_code, 'expires_at', v_expires);
end;
$$;


create or replace function workspace._admin_apply(
    p_email text, p_action text, p_args jsonb, p_code text
)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype;
    v_plan jsonb;
begin
    -- One admin change at a time, so two administrators cannot each remove
    -- the other and leave none. The administrator check follows at once and
    -- sees whatever the previous change committed.
    perform pg_advisory_xact_lock(hashtext('kb_admin_apply'));
    v_who := workspace._admin_require(p_email);

    -- Spend the code. It must match on every binding at once.
    update workspace.admin_confirmations
    set used_at = now()
    where code_hash = workspace._admin_hash(p_code)
      and p_code is not null
      and caller_principal = v_who.id
      and action = p_action
      and args_hash = workspace._admin_hash(p_action || '|' || p_args::text)
      and used_at is null
      and expires_at > now();
    if not found then
        raise exception 'confirmation code is not valid for this change; ask for a new preview'
            using errcode = 'KB002';
    end if;

    v_plan := workspace._admin_run(v_who, p_action, p_args, true);

    insert into workspace.events (service, component, event, level, status, attrs)
    values ('kb-engine', 'admin', 'admin.' || p_action, 'info', 'ok',
            (v_plan->'audit') || jsonb_build_object('actor', v_who.handle));

    return jsonb_build_object('applied', true, 'summary', v_plan->>'text');
end;
$$;

do $$
declare
    v_fn regprocedure;
begin
    for v_fn in
        select p.oid::regprocedure from pg_proc p
        where p.pronamespace = 'workspace'::regnamespace and p.proname like '\_admin\_%'
    loop
        execute format('revoke all on function %s from public', v_fn);
        execute format('revoke all on function %s from anon, authenticated', v_fn);
    end loop;
end $$;


-- ---------------------------------------------------------------------------
-- Public surface (SECURITY DEFINER, execute to kb_engine only)
-- ---------------------------------------------------------------------------

-- For hiding the admin tools from people who cannot use them. Not a guard.
create or replace function workspace.admin_is_administrator(p_email text)
returns boolean
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce((workspace._active_principal_by_email(p_email)).role = 'administrator', false);
$$;

create or replace function workspace.admin_people_list(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._admin_require(p_email);
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'handle', p.handle, 'display_name', p.display_name, 'email', p.email,
            'role', p.role, 'active', p.active,
            'topics', coalesce((
                select jsonb_agg(g.domain order by g.domain)
                from workspace.access_grants g where g.principal_id = p.id), '[]'::jsonb))
            order by p.active desc, p.handle)
        from workspace.principals p), '[]'::jsonb);
end;
$$;

create or replace function workspace.admin_person_add_preview(
    p_email text, p_new_email text, p_display_name text, p_role text,
    p_admin_ack boolean default false
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_preview(p_email, 'person_add', jsonb_build_object(
        'email', lower(btrim(p_new_email)), 'display_name', btrim(p_display_name),
        'role', p_role, 'admin_ack', coalesce(p_admin_ack, false)));
$$;

create or replace function workspace.admin_person_add_apply(
    p_email text, p_new_email text, p_display_name text, p_role text,
    p_admin_ack boolean, p_code text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_apply(p_email, 'person_add', jsonb_build_object(
        'email', lower(btrim(p_new_email)), 'display_name', btrim(p_display_name),
        'role', p_role, 'admin_ack', coalesce(p_admin_ack, false)), p_code);
$$;

create or replace function workspace.admin_grant_preview(
    p_email text, p_person_email text, p_topic text, p_sensitive_ack boolean default false
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_preview(p_email, 'grant', jsonb_build_object(
        'person_email', lower(btrim(p_person_email)), 'topic', p_topic,
        'sensitive_ack', coalesce(p_sensitive_ack, false)));
$$;

create or replace function workspace.admin_grant_apply(
    p_email text, p_person_email text, p_topic text, p_sensitive_ack boolean, p_code text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_apply(p_email, 'grant', jsonb_build_object(
        'person_email', lower(btrim(p_person_email)), 'topic', p_topic,
        'sensitive_ack', coalesce(p_sensitive_ack, false)), p_code);
$$;

create or replace function workspace.admin_revoke_preview(
    p_email text, p_person_email text, p_topic text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_preview(p_email, 'revoke', jsonb_build_object(
        'person_email', lower(btrim(p_person_email)), 'topic', p_topic));
$$;

create or replace function workspace.admin_revoke_apply(
    p_email text, p_person_email text, p_topic text, p_code text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_apply(p_email, 'revoke', jsonb_build_object(
        'person_email', lower(btrim(p_person_email)), 'topic', p_topic), p_code);
$$;

create or replace function workspace.admin_person_deactivate_preview(
    p_email text, p_person_email text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_preview(p_email, 'person_deactivate',
        jsonb_build_object('person_email', lower(btrim(p_person_email))));
$$;

create or replace function workspace.admin_person_deactivate_apply(
    p_email text, p_person_email text, p_code text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_apply(p_email, 'person_deactivate',
        jsonb_build_object('person_email', lower(btrim(p_person_email))), p_code);
$$;

do $$
declare
    v_fn regprocedure;
begin
    for v_fn in
        select p.oid::regprocedure from pg_proc p
        where p.pronamespace = 'workspace'::regnamespace and p.proname like 'admin\_%'
    loop
        execute format('revoke all on function %s from public', v_fn);
        execute format('revoke all on function %s from anon, authenticated', v_fn);
        execute format('grant execute on function %s to kb_engine', v_fn);
    end loop;
end $$;


-- ROLLBACK -------------------------------------------------------------------
-- do $$ declare v regprocedure; begin
--   for v in select p.oid::regprocedure from pg_proc p
--            where p.pronamespace = 'workspace'::regnamespace
--              and (p.proname like 'admin\_%' or p.proname like '\_admin\_%')
--   loop execute format('drop function %s', v); end loop; end $$;
-- drop table if exists workspace.admin_confirmations;
