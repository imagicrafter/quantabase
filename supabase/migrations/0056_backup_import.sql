-- 0056_backup_import.sql
--
-- Step F: the nightly one-way GitHub backup and the one-time page import.
--
-- BACKUP
--   The service writes every live page, as Obsidian-ready Markdown, to one
--   private GitHub repository once a night (engine/src/backup). One way: the
--   database always wins and nothing is ever read back. The repository has no
--   row protection, so it is the ENGINE OWNER's alone: only the owner sets it
--   up, and only the owner's token (kept in Supabase Vault as
--   kbe_backup_token) is used. The owner is the config's engine.owner.email
--   when a config was applied, else the first active administrator.
--
--   The curator tick asks backup_claim() whether a backup is due (on, repo
--   and token set, none started in the last 20 hours, none running). The
--   claim is one UPDATE, so two instances never both run it.
--
-- IMPORT
--   page_import() files one page for a named person, for `kbe pages import`
--   (scripts/kbe/pages_import.py). Never overwrites: a key the person already
--   holds is reported as "exists". Granted to nobody; the CLI runs it through
--   the direct database login.
--
-- Every function: SECURITY DEFINER, fixed search_path, no grant to anon or
-- authenticated. Secrets never leave the database except the backup token,
-- to the service only.

-- ── settings ────────────────────────────────────────────────────────────────

create table if not exists workspace.backup_settings (
    id               boolean     primary key default true,
    repo             text,
    branch           text        not null default 'main',
    enabled          boolean     not null default false,
    last_started_at  timestamptz,
    last_finished_at timestamptz,
    last_status      text,
    last_error       text,
    last_commit      text,
    last_files       integer,
    updated_at       timestamptz not null default now(),
    updated_by       uuid        references workspace.principals(id) on delete set null,
    constraint backup_settings_single_row check (id),
    constraint backup_settings_repo_shape
        check (repo is null or repo ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
    constraint backup_settings_branch_shape
        check (branch ~ '^[A-Za-z0-9._/-]{1,100}$' and branch !~ '\.\.' and branch !~ '^/' and branch !~ '/$'),
    constraint backup_settings_status_values
        check (last_status is null or last_status in ('running', 'done', 'unchanged', 'failed'))
);

comment on table workspace.backup_settings is
    'The nightly one-way GitHub backup: which private repository, on or off, '
    'and the last run. One row. The token is in Vault (kbe_backup_token).';

insert into workspace.backup_settings (id) values (true) on conflict (id) do nothing;

alter table workspace.backup_settings enable row level security;
revoke all on workspace.backup_settings from public;
revoke all on workspace.backup_settings from anon, authenticated;

-- ── the owner ───────────────────────────────────────────────────────────────

-- The Engine owner's email: the applied config's owner, else the first
-- active administrator.
create or replace function workspace._engine_owner_email()
returns text
language sql
stable
set search_path = workspace, pg_temp
as $$
    select coalesce(
        (select nullif(lower(btrim(s.config #>> '{engine,owner,email}')), '')
         from workspace.engine_settings s where s.id),
        (select lower(btrim(p.email)) from workspace.principals p
         where p.role = 'administrator' and p.active and p.email is not null
         order by p.created_at, p.id limit 1));
$$;

-- The owner, or 42501. The owner must also be an active administrator.
create or replace function workspace._engine_owner_require(p_email text)
returns workspace.principals
language plpgsql
stable
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._admin_require(p_email);
begin
    if lower(btrim(v_who.email)) is distinct from workspace._engine_owner_email() then
        raise exception 'only the Engine owner can do this' using errcode = '42501';
    end if;
    return v_who;
end;
$$;

-- ── secrets: the backup token joins the model key ──────────────────────────

-- Same contract as 0054: writes one named secret, returns nothing. The model
-- key needs an administrator; the backup token needs the owner.
create or replace function workspace.app_secret_set(p_email text, p_name text, p_value text)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_id uuid;
begin
    if p_name = 'kbe_backup_token' then
        perform workspace._engine_owner_require(p_email);
    else
        perform workspace._admin_require(p_email);
    end if;
    if p_name is distinct from 'kbe_model_key' and p_name is distinct from 'kbe_backup_token' then
        raise exception 'that secret cannot be set here' using errcode = '22023';
    end if;
    if p_value is null or length(p_value) not between 10 and 4096 or p_value ~ '[[:space:]]' then
        raise exception 'the key must be 10 to 4096 characters with no spaces' using errcode = '22023';
    end if;
    if to_regclass('vault.secrets') is null then
        raise exception 'Supabase Vault is not available on this database' using errcode = '55000';
    end if;
    execute 'select id from vault.secrets where name = $1 limit 1' into v_id using p_name;
    if v_id is null then
        execute 'select vault.create_secret($1, $2, $3)'
            using p_value, p_name, 'Set on the KB Engine setup screen';
    else
        execute 'select vault.update_secret($1, $2)' using v_id, p_value;
    end if;
end;
$$;

-- ── the Backup screen (the owner) ───────────────────────────────────────────

create or replace function workspace._backup_state()
returns jsonb
language sql
stable
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object(
        'repo', b.repo, 'branch', b.branch, 'enabled', b.enabled,
        'has_token', workspace._curator_vault_secret('kbe_backup_token') is not null,
        'last_started_at', b.last_started_at, 'last_finished_at', b.last_finished_at,
        'last_status', b.last_status, 'last_error', b.last_error,
        'last_commit', b.last_commit, 'last_files', b.last_files,
        'owner_email', workspace._engine_owner_email())
    from workspace.backup_settings b where b.id;
$$;

create or replace function workspace.app_backup_get(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._engine_owner_require(p_email);
    return workspace._backup_state();
end;
$$;

create or replace function workspace.app_backup_set(
    p_email text, p_repo text, p_branch text, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who    workspace.principals%rowtype := workspace._engine_owner_require(p_email);
    v_repo   text := nullif(btrim(coalesce(p_repo, '')), '');
    v_branch text := coalesce(nullif(btrim(coalesce(p_branch, '')), ''), 'main');
begin
    if v_repo is not null and v_repo !~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$' then
        raise exception 'the repository is owner/name, e.g. acme/knowledge-backup' using errcode = '22023';
    end if;
    if v_branch !~ '^[A-Za-z0-9._/-]{1,100}$' or v_branch ~ '\.\.' or v_branch ~ '^/' or v_branch ~ '/$' then
        raise exception 'that is not a branch name' using errcode = '22023';
    end if;
    if coalesce(p_enabled, false) and v_repo is null then
        raise exception 'name the repository before switching the backup on' using errcode = '22023';
    end if;
    if coalesce(p_enabled, false) and workspace._curator_vault_secret('kbe_backup_token') is null then
        raise exception 'save the GitHub token before switching the backup on' using errcode = '22023';
    end if;
    update workspace.backup_settings b
       set repo = v_repo, branch = v_branch, enabled = coalesce(p_enabled, false),
           updated_at = now(), updated_by = v_who.id
     where b.id;
    return workspace._backup_state();
end;
$$;

-- Ask for a backup on the next tick (clears the 20-hour wait).
create or replace function workspace.app_backup_request(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._engine_owner_require(p_email);
    update workspace.backup_settings b
       set last_started_at = null
     where b.id and coalesce(b.last_status, '') <> 'running';
    return workspace._backup_state();
end;
$$;

-- ── the backup run (kb_engine) ──────────────────────────────────────────────

-- Claim tonight's backup. Returns {repo, branch} and marks it running, or
-- null when none is due. A run that never finished counts as gone after an
-- hour.
create or replace function workspace.backup_claim(p_every_hours integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_row workspace.backup_settings%rowtype;
begin
    if workspace._curator_vault_secret('kbe_backup_token') is null then
        return null;
    end if;
    update workspace.backup_settings b
       set last_started_at = now(), last_status = 'running', last_error = null
     where b.id and b.enabled and b.repo is not null
       and (b.last_started_at is null
            or b.last_started_at < now() - make_interval(hours => greatest(coalesce(p_every_hours, 20), 1)))
       and not (coalesce(b.last_status, '') = 'running' and b.last_started_at > now() - interval '1 hour')
    returning b.* into v_row;
    if not found then
        return null;
    end if;
    return jsonb_build_object('repo', v_row.repo, 'branch', v_row.branch);
end;
$$;

create or replace function workspace.backup_finish(
    p_ok boolean, p_status text, p_commit text, p_files integer, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
begin
    update workspace.backup_settings b
       set last_finished_at = now(),
           last_status = case when coalesce(p_ok, false)
                              then (case when p_status = 'unchanged' then 'unchanged' else 'done' end)
                              else 'failed' end,
           last_commit = case when coalesce(p_ok, false) and p_commit ~ '^[0-9a-f]{40}$'
                              then p_commit else b.last_commit end,
           last_files = case when coalesce(p_ok, false) then p_files else b.last_files end,
           last_error = case when coalesce(p_ok, false) then null else left(p_error, 300) end
     where b.id;
end;
$$;

-- The GitHub token, for the service's backup run only.
create or replace function workspace.backup_token()
returns text
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select workspace._curator_vault_secret('kbe_backup_token');
$$;

-- Every live page, in id order, a page at a time, with its owner and its
-- links. Only the backup reads this.
create or replace function workspace.backup_pages(p_after uuid default null, p_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(jsonb_agg(x.page order by x.id), '[]'::jsonb)
    from (
        select p.id, jsonb_build_object(
            'id', p.id, 'key', p.key, 'drawer', p.drawer, 'template', p.template,
            'title', p.title, 'aliases', to_jsonb(p.aliases), 'description', p.description,
            'fields', p.fields, 'topics', to_jsonb(p.topics), 'status', p.status,
            'reviewed', p.reviewed, 'tags', to_jsonb(p.tags), 'related', to_jsonb(p.related),
            'sources', p.sources, 'generated', p.generated, 'verified', p.verified,
            'body', p.body, 'created_at', p.created_at, 'updated_at', p.updated_at,
            'owner', coalesce(o.email, o.handle),
            'links', coalesce((select jsonb_agg(jsonb_build_object('target_key', l.target_key, 'reason', l.reason)
                                                order by l.target_key, l.reason)
                               from workspace.page_links l where l.page_id = p.id), '[]'::jsonb)) as page
        from workspace.pages p
        join workspace.principals o on o.id = p.owner_principal_id
        where p.deleted_at is null
          and (p_after is null or p.id > p_after)
        order by p.id
        limit least(greatest(coalesce(p_limit, 200), 1), 500)
    ) x;
$$;

-- The change history for log.md: newest first, titles and keys only.
create or replace function workspace.backup_log(p_limit integer default 500)
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(jsonb_agg(x.entry order by x.saved_at desc, x.id), '[]'::jsonb)
    from (
        select h.id, h.saved_at, jsonb_build_object(
            'saved_at', h.saved_at,
            'key', h.snapshot->>'key', 'title', h.snapshot->>'title', 'drawer', h.snapshot->>'drawer',
            'by', coalesce(w.email, w.handle),
            'first', not exists (select 1 from workspace.page_history e
                                 where e.page_id = h.page_id and e.saved_at < h.saved_at),
            'deleted', p.deleted_at is not null) as entry
        from workspace.page_history h
        join workspace.pages p on p.id = h.page_id
        left join workspace.principals w on w.id = h.saved_by
        order by h.saved_at desc, h.id
        limit least(greatest(coalesce(p_limit, 500), 1), 2000)
    ) x;
$$;

-- ── import (the CLI only) ───────────────────────────────────────────────────

-- File one page for an active person. Never overwrites: a key the person
-- already holds comes back as "exists" and nothing changes. Topics must be
-- ones the person holds (the same rule as save_page).
create or replace function workspace.page_import(p_owner_email text, p_page jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_owner   workspace.principals%rowtype := workspace._active_principal_by_email(p_owner_email);
    v_key     text := lower(btrim(coalesce(p_page->>'key', '')));
    v_allowed text[];
    v_saved   record;
begin
    if v_owner.id is null then
        raise exception 'no active person with that email' using errcode = '22023';
    end if;
    if exists (select 1 from workspace.pages p
               where p.owner_principal_id = v_owner.id and p.key = v_key and p.deleted_at is null) then
        return jsonb_build_object('status', 'exists', 'key', v_key);
    end if;
    v_allowed := array(select g.domain from workspace.access_grants g where g.principal_id = v_owner.id);
    select * into v_saved from workspace._page_save_as(v_owner.id, v_allowed, p_page, null);
    return jsonb_build_object('status', 'created', 'key', v_saved.key, 'id', v_saved.id);
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace._engine_owner_email() from public;
revoke all on function workspace._engine_owner_email() from anon, authenticated;
revoke all on function workspace._engine_owner_require(text) from public;
revoke all on function workspace._engine_owner_require(text) from anon, authenticated;
revoke all on function workspace._backup_state() from public;
revoke all on function workspace._backup_state() from anon, authenticated;

revoke all on function workspace.app_secret_set(text, text, text) from public;
revoke all on function workspace.app_secret_set(text, text, text) from anon, authenticated;
grant execute on function workspace.app_secret_set(text, text, text) to kb_engine;
revoke all on function workspace.app_backup_get(text) from public;
revoke all on function workspace.app_backup_get(text) from anon, authenticated;
grant execute on function workspace.app_backup_get(text) to kb_engine;
revoke all on function workspace.app_backup_set(text, text, text, boolean) from public;
revoke all on function workspace.app_backup_set(text, text, text, boolean) from anon, authenticated;
grant execute on function workspace.app_backup_set(text, text, text, boolean) to kb_engine;
revoke all on function workspace.app_backup_request(text) from public;
revoke all on function workspace.app_backup_request(text) from anon, authenticated;
grant execute on function workspace.app_backup_request(text) to kb_engine;

revoke all on function workspace.backup_claim(integer) from public;
revoke all on function workspace.backup_claim(integer) from anon, authenticated;
grant execute on function workspace.backup_claim(integer) to kb_engine;
revoke all on function workspace.backup_finish(boolean, text, text, integer, text) from public;
revoke all on function workspace.backup_finish(boolean, text, text, integer, text) from anon, authenticated;
grant execute on function workspace.backup_finish(boolean, text, text, integer, text) to kb_engine;
revoke all on function workspace.backup_token() from public;
revoke all on function workspace.backup_token() from anon, authenticated;
grant execute on function workspace.backup_token() to kb_engine;
revoke all on function workspace.backup_pages(uuid, integer) from public;
revoke all on function workspace.backup_pages(uuid, integer) from anon, authenticated;
grant execute on function workspace.backup_pages(uuid, integer) to kb_engine;
revoke all on function workspace.backup_log(integer) from public;
revoke all on function workspace.backup_log(integer) from anon, authenticated;
grant execute on function workspace.backup_log(integer) to kb_engine;

-- Import: the direct login only.
revoke all on function workspace.page_import(text, jsonb) from public;
revoke all on function workspace.page_import(text, jsonb) from anon, authenticated;


-- VERIFY ------------------------------------------------------------------
-- select has_function_privilege('kb_engine', 'workspace.page_import(text, jsonb)', 'execute');  -- f
-- select has_function_privilege('anon', 'workspace.backup_token()', 'execute');                 -- f


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.page_import(text, jsonb);
-- drop function if exists workspace.backup_log(integer);
-- drop function if exists workspace.backup_pages(uuid, integer);
-- drop function if exists workspace.backup_token();
-- drop function if exists workspace.backup_finish(boolean, text, text, integer, text);
-- drop function if exists workspace.backup_claim(integer);
-- drop function if exists workspace.app_backup_request(text);
-- drop function if exists workspace.app_backup_set(text, text, text, boolean);
-- drop function if exists workspace.app_backup_get(text);
-- drop function if exists workspace._backup_state();
-- drop function if exists workspace._engine_owner_require(text);
-- drop function if exists workspace._engine_owner_email();
-- drop table if exists workspace.backup_settings;
-- (app_secret_set: re-run its 0054 definition.)
