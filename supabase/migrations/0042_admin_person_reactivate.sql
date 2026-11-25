-- 0042_admin_person_reactivate.sql
--
-- Give a deactivated person their access back, in the same two steps as the
-- other admin changes from 0033:
--
--   admin_person_reactivate_preview(p_email, p_person_email)
--   admin_person_reactivate_apply  (p_email, p_person_email, p_code)
--
-- Same shape, same one-time code, same guard as the deactivate pair: the
-- caller is re-checked as an active administrator first (42501 otherwise),
-- the code is bound to the caller and to the exact arguments, and the change
-- is written to the audit trail (event `admin.person_reactivate`).
--
-- Reactivating widens access, so the preview says exactly what comes back:
-- the person's role and every topic still listed for them. No topic is
-- added, and the sign-in layer is not touched.
--
-- A token the person held before they were deactivated does NOT come back:
-- the stored token hash is cleared on reactivation. A person is often
-- deactivated because a device or a token was lost, so an old token must
-- never start working again without anyone noticing. A new one is minted on
-- purpose (`kbe tokens mint`) if they need one.
--
-- SQLSTATEs: 42501 not an administrator | 22023 bad argument |
--            KB002 confirmation code not valid

create or replace function workspace._admin_do_person_reactivate(
    p_who workspace.principals, p_args jsonb, p_apply boolean
)
returns jsonb
language plpgsql
set search_path = workspace, pg_temp
as $$
declare
    v_person workspace.principals%rowtype;
    v_topics text[];
    v_count  integer;
begin
    v_person := workspace._admin_person(p_args->>'person_email');
    if v_person.active then
        raise exception 'that person is already active' using errcode = '22023';
    end if;

    select coalesce(array_agg(g.domain order by g.domain), array[]::text[])
    into v_topics
    from workspace.access_grants g
    where g.principal_id = v_person.id;
    v_count := coalesce(array_length(v_topics, 1), 0);

    if p_apply then
        update workspace.principals
        set active = true, token_hash = null
        where id = v_person.id;
    end if;

    return jsonb_build_object(
        'text', format('Reactivate %s (%s), role %s. They get their access to this Engine back at once. ',
                       v_person.display_name, v_person.email, v_person.role)
            || case when v_count = 0
                    then 'No topic is listed for them. '
                    else format('The topics listed for them take effect again: %s. ',
                                array_to_string(v_topics, ', ')) end
            || case when v_person.role = 'administrator'
                    then 'As an ADMINISTRATOR they will again see every topic that is not marked sensitive and can manage people and topics. '
                    else '' end
            || case when v_person.token_hash is not null
                    then 'A token they held before stops working for good; mint a new one if they need one. '
                    else '' end
            || 'They must still be allowed through the sign-in layer before they can connect; '
            || 'the Engine cannot change that.',
        'audit', jsonb_build_object('target', v_person.handle, 'role', v_person.role,
                                    'topics', v_count));
end;
$$;


-- The dispatcher from 0033 with one more action.
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
        when 'person_reactivate' then return workspace._admin_do_person_reactivate(p_who, p_args, p_apply);
        else raise exception 'unknown admin action' using errcode = '22023';
    end case;
end;
$$;

revoke all on function workspace._admin_do_person_reactivate(workspace.principals, jsonb, boolean) from public;
revoke all on function workspace._admin_do_person_reactivate(workspace.principals, jsonb, boolean) from anon, authenticated;
revoke all on function workspace._admin_run(workspace.principals, text, jsonb, boolean) from public;
revoke all on function workspace._admin_run(workspace.principals, text, jsonb, boolean) from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Public surface (SECURITY DEFINER, execute to kb_engine only)
-- ---------------------------------------------------------------------------

create or replace function workspace.admin_person_reactivate_preview(
    p_email text, p_person_email text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_preview(p_email, 'person_reactivate',
        jsonb_build_object('person_email', lower(btrim(p_person_email))));
$$;

create or replace function workspace.admin_person_reactivate_apply(
    p_email text, p_person_email text, p_code text
)
returns jsonb language sql security definer set search_path = workspace, pg_temp
as $$
    select workspace._admin_apply(p_email, 'person_reactivate',
        jsonb_build_object('person_email', lower(btrim(p_person_email))), p_code);
$$;

revoke all on function workspace.admin_person_reactivate_preview(text, text) from public;
revoke all on function workspace.admin_person_reactivate_preview(text, text) from anon, authenticated;
grant execute on function workspace.admin_person_reactivate_preview(text, text) to kb_engine;
revoke all on function workspace.admin_person_reactivate_apply(text, text, text) from public;
revoke all on function workspace.admin_person_reactivate_apply(text, text, text) from anon, authenticated;
grant execute on function workspace.admin_person_reactivate_apply(text, text, text) to kb_engine;


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.admin_person_reactivate_apply(text, text, text);
-- drop function if exists workspace.admin_person_reactivate_preview(text, text);
-- drop function if exists workspace._admin_do_person_reactivate(workspace.principals, jsonb, boolean);
-- (then re-run the _admin_run definition from 0033)
