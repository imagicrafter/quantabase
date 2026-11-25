-- 0077_principal_page_name.sql
--
-- The name the curator uses for a person in page text ("Ann decided ...",
-- never "the owner decided ..."). First-run setup used to store the owner's
-- email as their display name and never asked for a name, so pages could only
-- say "the owner".
--
--   principals.page_name      a short name for page text (1 to 60 characters,
--                             trimmed, no control characters). Null means the
--                             default: the display name when it is not an
--                             email, else none.
--   _principal_page_name(p)   that rule, in one place.
--   curator_account_people()  0070's, plus page_name (the rule applied), for
--                             the curator (kb_engine) only.
--   app_my_names(email)       the caller's own display name and page name,
--                             for the Staff & settings screen. Administrators.
--   app_my_names_set(email, display_name, page_name)
--                             change the caller's OWN names, never anyone
--                             else's. Administrators only. An empty page name
--                             goes back to the default.

alter table workspace.principals
    add column if not exists page_name text;

alter table workspace.principals
    drop constraint if exists principals_page_name_shape;
alter table workspace.principals
    add constraint principals_page_name_shape check (
        page_name is null
        or (char_length(page_name) between 1 and 60
            and page_name = btrim(page_name)
            and page_name !~ '[[:cntrl:]]')
    );

comment on column workspace.principals.page_name is
    'The short name the curator uses for this person in page text. Null: the display name when it is not an email.';

-- ── the rule ────────────────────────────────────────────────────────────────

create or replace function workspace._principal_page_name(p_page_name text, p_display_name text)
returns text
language sql
immutable
set search_path = workspace, pg_temp
as $$
    select coalesce(
        nullif(btrim(p_page_name), ''),
        case
            when p_display_name is null or btrim(p_display_name) = '' then null
            when btrim(p_display_name) like '%@%' then null
            else left(btrim(regexp_replace(p_display_name, '[[:cntrl:]]', ' ', 'g')), 60)
        end
    );
$$;

-- ── the curator's account people (0070, plus page_name) ────────────────────

drop function if exists workspace.curator_account_people();

create function workspace.curator_account_people()
returns table (email text, display_name text, page_name text)
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select lower(btrim(p.email)), p.display_name,
           workspace._principal_page_name(p.page_name, p.display_name)
    from workspace.principals p
    where p.active
    order by p.created_at;
$$;

-- ── the caller's own names (Staff & settings) ──────────────────────────────

create or replace function workspace.app_my_names(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype := workspace._admin_require(p_email);
begin
    return jsonb_build_object(
        'email', lower(btrim(v_who.email)),
        'display_name', v_who.display_name,
        'page_name', v_who.page_name,
        'page_name_used', workspace._principal_page_name(v_who.page_name, v_who.display_name)
    );
end;
$$;

create or replace function workspace.app_my_names_set(p_email text, p_display_name text, p_page_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who  workspace.principals%rowtype := workspace._admin_require(p_email);
    v_name text := btrim(coalesce(p_display_name, ''));
    v_page text := nullif(btrim(coalesce(p_page_name, '')), '');
begin
    if char_length(v_name) not between 1 and 120 or v_name ~ '[[:cntrl:]]' then
        raise exception 'a name is 1 to 120 characters on one line' using errcode = '22023';
    end if;
    if v_page is not null and (char_length(v_page) > 60 or v_page ~ '[[:cntrl:]]') then
        raise exception 'the name used on pages is 1 to 60 characters on one line' using errcode = '22023';
    end if;
    update workspace.principals
    set display_name = v_name, page_name = v_page
    where id = v_who.id;
    return workspace.app_my_names(p_email);
end;
$$;

revoke all on function workspace._principal_page_name(text, text) from public;
revoke all on function workspace._principal_page_name(text, text) from anon, authenticated;
revoke all on function workspace.curator_account_people() from public;
revoke all on function workspace.curator_account_people() from anon, authenticated;
grant execute on function workspace.curator_account_people() to kb_engine;
revoke all on function workspace.app_my_names(text) from public;
revoke all on function workspace.app_my_names(text) from anon, authenticated;
grant execute on function workspace.app_my_names(text) to kb_engine;
revoke all on function workspace.app_my_names_set(text, text, text) from public;
revoke all on function workspace.app_my_names_set(text, text, text) from anon, authenticated;
grant execute on function workspace.app_my_names_set(text, text, text) to kb_engine;
