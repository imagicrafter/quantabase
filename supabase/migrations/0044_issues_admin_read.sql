-- 0044_issues_admin_read.sql
--
-- Two more administrator-only reads of the issue log, for `kbe issues`:
--
--   issues_list(p_email, p_include_closed)  the open issues, or every issue
--   issue_detail(p_email, p_id)             one issue with its detail text
--
-- issues_summary (0032) lists open issues only and leaves the detail out.
-- An administrator needs both to decide what to do about an issue.
--
-- Neither is granted to an application role. `kbe issues` calls them over the
-- owner's direct connection; the service keeps to issues_summary.
--
-- Same guard as issues_summary: the caller is re-checked as an ACTIVE
-- administrator (42501 otherwise). What a row may hold is unchanged: the
-- pullers and issue_report scrub every text before it is stored, and no row
-- holds document text, a document title or a participant name.

create or replace function workspace._issues_admin_only(p_email text)
returns void
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_who workspace.principals%rowtype;
begin
    v_who := workspace._active_principal_by_email(p_email);
    if v_who.id is null or v_who.role <> 'administrator' then
        raise exception 'administrators only' using errcode = '42501';
    end if;
end;
$$;

revoke all on function workspace._issues_admin_only(text) from public;
revoke all on function workspace._issues_admin_only(text) from anon, authenticated;


create or replace function workspace.issues_list(p_email text, p_include_closed boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._issues_admin_only(p_email);

    return coalesce((
        select jsonb_agg(to_jsonb(listed) order by listed.opened_at desc)
        from (
            select i.id, i.category, i.source, i.title, i.status, i.opened_at,
                   i.last_seen_at, i.closed_at, i.occurrences,
                   i.card_id is not null as has_card
            from workspace.issues i
            where coalesce(p_include_closed, false) or i.status <> 'closed'
            order by i.opened_at desc
            limit 200
        ) listed), '[]'::jsonb);
end;
$$;

comment on function workspace.issues_list(text, boolean) is
    'Administrators only (42501 otherwise): the newest 200 issues, open ones '
    'only unless p_include_closed is true. No detail text.';

revoke all on function workspace.issues_list(text, boolean) from public;
revoke all on function workspace.issues_list(text, boolean) from anon, authenticated;
revoke all on function workspace.issues_list(text, boolean) from kb_engine;


create or replace function workspace.issue_detail(p_email text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
begin
    perform workspace._issues_admin_only(p_email);

    return (
        select jsonb_build_object(
            'id', i.id, 'category', i.category, 'source', i.source,
            'title', i.title, 'detail', i.detail, 'error_class', i.error_class,
            'status', i.status, 'reported_by', i.reported_by,
            'occurrences', i.occurrences, 'opened_at', i.opened_at,
            'last_seen_at', i.last_seen_at, 'closed_at', i.closed_at,
            'has_card', i.card_id is not null, 'pr_url', i.pr_url, 'proof', i.proof)
        from workspace.issues i
        where i.id = p_id);
end;
$$;

comment on function workspace.issue_detail(text, uuid) is
    'Administrators only (42501 otherwise): one issue with its detail, or '
    'null when there is no such issue.';

revoke all on function workspace.issue_detail(text, uuid) from public;
revoke all on function workspace.issue_detail(text, uuid) from anon, authenticated;
revoke all on function workspace.issue_detail(text, uuid) from kb_engine;
