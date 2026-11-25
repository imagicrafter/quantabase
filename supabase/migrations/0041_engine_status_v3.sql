-- 0041_engine_status_v3.sql
--
-- Widens workspace.engine_status(p_email) again. Same signature, same SECURITY
-- DEFINER posture, same guard (active administrator by email, else SQLSTATE
-- 42501). Every key from 0027 and 0028 is unchanged. Four are added, each
-- built by a small internal function that no role may call directly:
--
--   tagging   per source, how the topics of its live whole documents were
--             decided: {source, total, by_tag_source{content, container,
--             source_default, default, not_recorded}, untagged, unknown_tag}.
--             The same counts as tagging_health() (0031).
--   issues    {open: [{category, source, title, status, opened_at,
--             occurrences, has_card}], fixed_last_30_days,
--             care_plan_enabled}. The same rows as issues_summary() (0032),
--             without ids. care_plan_enabled is true when a login that is a
--             member of kb_support exists (`kbe support enable`, 0036).
--   setup     {setup_state, level, host, locked_until}. locked_until is set
--             only while setup is locked. Never the setup code hash, never
--             the wrong-code counter.
--   config    {applied_at, rejected}. rejected is true while an issue of
--             category config_invalid is open: the last config read from the
--             knowledge repo was refused and the previous one is in force.
--
-- One existing key changes for email only: review_waiting lists a Gmail row
-- only to the administrator who owns it (0038), so the title of someone
-- else's unapproved mail never reaches this page.
--
-- Access is unchanged: kb_engine holds zero table grants and may only EXECUTE.

create or replace function workspace._status_tagging()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'source', s.source,
        'total', s.total,
        'by_tag_source', jsonb_build_object(
            'content', s.by_content,
            'container', s.by_container,
            'source_default', s.by_source_default,
            'default', s.untagged,
            'not_recorded', s.not_recorded
        ),
        'untagged', s.untagged,
        'unknown_tag', s.unknown_tag
    ) order by s.source), '[]'::jsonb)
    from (
        select d.source,
               count(*) as total,
               count(*) filter (where d.tag_source = 'content') as by_content,
               count(*) filter (where d.tag_source = 'container') as by_container,
               count(*) filter (where d.tag_source = 'source_default') as by_source_default,
               count(*) filter (where d.tag_source = 'default') as untagged,
               count(*) filter (where d.tag_source is null) as not_recorded,
               count(*) filter (where d.tag_signals @> array['unknown_tag']) as unknown_tag
        from workspace.documents d
        where d.deleted_at is null
          and d.parent_external_id is null
        group by d.source
    ) s;
$$;

create or replace function workspace._status_issues()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object(
        'open', coalesce((
            select jsonb_agg(jsonb_build_object(
                'category', i.category, 'source', i.source, 'title', i.title,
                'status', i.status, 'opened_at', i.opened_at,
                'occurrences', i.occurrences, 'has_card', i.card_id is not null)
                order by i.opened_at desc)
            from workspace.issues i
            where i.status <> 'closed'), '[]'::jsonb),
        'fixed_last_30_days', (
            select count(*) from workspace.issues i
            where i.status = 'closed'
              and i.closed_at > now() - interval '30 days'),
        'care_plan_enabled', exists (
            select 1
            from pg_catalog.pg_auth_members m
            join pg_catalog.pg_roles g on g.oid = m.roleid
            join pg_catalog.pg_roles r on r.oid = m.member
            where g.rolname = 'kb_support'
              and r.rolcanlogin)
    );
$$;

create or replace function workspace._status_setup()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    -- Built field by field on purpose: setup_code_hash and setup_failed_at are
    -- not named here at all.
    select jsonb_build_object(
        'setup_state', s.setup_state,
        'level', s.access->>'level',
        'host', s.access->>'host',
        'locked_until', case when s.setup_locked_until > now()
                             then s.setup_locked_until end
    )
    from workspace.engine_settings s
    where s.id;
$$;

create or replace function workspace._status_config()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object(
        'applied_at', (select s.config_applied_at from workspace.engine_settings s where s.id),
        'rejected', exists (
            select 1 from workspace.issues i
            where i.category = 'config_invalid'
              and i.status <> 'closed')
    );
$$;

revoke all on function workspace._status_tagging() from public;
revoke all on function workspace._status_tagging() from anon, authenticated;
revoke all on function workspace._status_issues() from public;
revoke all on function workspace._status_issues() from anon, authenticated;
revoke all on function workspace._status_setup() from public;
revoke all on function workspace._status_setup() from anon, authenticated;
revoke all on function workspace._status_config() from public;
revoke all on function workspace._status_config() from anon, authenticated;

-- ── engine_status ────────────────────────────────────────────────────────────

create or replace function workspace.engine_status(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_caller uuid;
begin
    select p.id into v_caller
    from workspace.principals p
    where lower(p.email) = lower(p_email)
      and p.active
      and p.role = 'administrator'
    limit 1;

    if p_email is null or v_caller is null then
        raise exception 'forbidden' using errcode = '42501';
    end if;

    return jsonb_build_object(
        'generated_at', now(),
        'connectors', coalesce((
            select jsonb_agg(jsonb_build_object(
                'source', c.source,
                'last_run_at', c.last_run_at,
                'last_success_at', c.last_success_at,
                'consecutive_failures', c.consecutive_failures,
                'last_error', left(c.last_error, 300)
            ) order by c.source)
            from workspace.connector_state c
        ), '[]'::jsonb),
        'review_undecided', (
            select count(*) from workspace.review_items where decision is null
        ),
        'people', coalesce((
            select jsonb_agg(jsonb_build_object(
                'handle', p.handle,
                'display_name', p.display_name,
                'role', p.role,
                'active', p.active,
                'email', p.email,
                'created_at', p.created_at,
                'updated_at', p.updated_at,
                'domains', coalesce((
                    select jsonb_agg(g.domain order by g.domain)
                    from workspace.access_grants g
                    where g.principal_id = p.id
                ), '[]'::jsonb)
            ) order by p.role, p.handle)
            from workspace.principals p
        ), '[]'::jsonb),
        'snapshot', (
            select jsonb_build_object('ts', e.ts, 'attrs', e.attrs)
            from workspace.events e
            where e.event = 'engine.sensors_snapshot'
            order by e.ts desc
            limit 1
        ),
        'documents', coalesce((
            select jsonb_agg(jsonb_build_object(
                'source', d.source,
                'live', d.live,
                'approved', d.approved
            ) order by d.source)
            from (
                select source,
                       count(*) as live,
                       count(*) filter (where review_status = 'approved') as approved
                from workspace.documents
                where deleted_at is null
                group by source
            ) d
        ), '[]'::jsonb),
        'runs_daily', coalesce((
            select jsonb_agg(jsonb_build_object(
                'day', to_char(r.day, 'YYYY-MM-DD'),
                'source', r.source,
                'ok', r.ok,
                'checked', r.checked,
                'changed', r.changed,
                'minutes', r.minutes
            ) order by r.day, r.source)
            from (
                select (e.ts at time zone 'America/Chicago')::date as day,
                       replace(e.component, 'puller-', '') as source,
                       (array_agg(e.status order by e.ts desc))[1] = 'ok' as ok,
                       sum(coalesce((e.attrs->'ingest'->>'scanned')::numeric, 0))::bigint as checked,
                       sum(coalesce((e.attrs->'ingest'->>'inserted')::numeric, 0)
                         + coalesce((e.attrs->'ingest'->>'updated')::numeric, 0))::bigint as changed,
                       round(sum(coalesce(e.duration_ms, 0)) / 60000.0, 1) as minutes
                from workspace.events e
                where e.service = 'kb-engine'
                  and e.event = 'run.finished'
                  and (e.ts at time zone 'America/Chicago')::date
                      >= (now() at time zone 'America/Chicago')::date - 13
                group by 1, 2
            ) r
        ), '[]'::jsonb),
        'review_waiting', coalesce((
            select jsonb_agg(w.row_json order by w.item_number)
            from (
                select ri.item_number,
                       jsonb_build_object(
                           'title', d.title,
                           'source', d.source,
                           'domains', to_jsonb(d.domains)
                       ) as row_json
                from workspace.review_items ri
                join workspace.documents d on d.id = ri.document_id
                where ri.decision is null
                  -- Mail waiting for a decision is listed for its owner only.
                  and (d.source <> 'gmail' or d.owner_principal_id = v_caller)
                order by ri.batch_id, ri.item_number
                limit 10
            ) w
        ), '[]'::jsonb),
        'areas', coalesce((
            select jsonb_agg(jsonb_build_object(
                'domain', dm.domain,
                'sensitive', dm.sensitive,
                'items', coalesce(a.items, 0),
                'sources', coalesce(a.sources, '[]'::jsonb)
            ) order by dm.domain)
            from workspace.domains dm
            left join lateral (
                select count(*) filter (where d.parent_external_id is null) as items,
                       jsonb_agg(distinct d.source) as sources
                from workspace.documents d
                where d.deleted_at is null
                  and dm.domain = any (d.domains)
            ) a on true
        ), '[]'::jsonb),
        'recent', coalesce((
            select jsonb_agg(r.row_json order by r.ts desc)
            from (
                select e.ts,
                       jsonb_build_object(
                           'ts', e.ts,
                           'service', e.service,
                           'component', e.component,
                           'event', e.event,
                           'status', e.status,
                           'level', e.level
                       ) as row_json
                from workspace.events e
                where e.level in ('info', 'warn', 'error')
                  and e.event <> 'engine.sensors_snapshot'
                order by e.ts desc
                limit 12
            ) r
        ), '[]'::jsonb)
    ) || jsonb_build_object(
        'tagging', workspace._status_tagging(),
        'issues', workspace._status_issues(),
        'setup', workspace._status_setup(),
        'config', workspace._status_config()
    );
end;
$$;

comment on function workspace.engine_status(text) is
    'Engine dashboard readings in one call, including tagging, issues, setup and '
    'config state. Administrators only (raises 42501 otherwise).';

revoke all on function workspace.engine_status(text) from public;
grant execute on function workspace.engine_status(text) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_engine';                               -- expect 0
-- select workspace.engine_status('<an administrator email>') ?& array[
--   'tagging', 'issues', 'setup', 'config'];                  -- expect true
-- select workspace.engine_status('<an administrator email>')::text
--   like '%setup_code_hash%';                                 -- expect false


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply 0028_engine_status_v2.sql, then:
-- drop function if exists workspace._status_config();
-- drop function if exists workspace._status_setup();
-- drop function if exists workspace._status_issues();
-- drop function if exists workspace._status_tagging();
