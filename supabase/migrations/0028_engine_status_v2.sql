-- 0028_engine_status_v2.sql
--
-- Widens workspace.engine_status(p_email) for the live Engine dashboard. Same
-- signature, same SECURITY DEFINER posture, same guard as 0027 (active
-- administrator by email, else SQLSTATE 42501). Every 0027 key is unchanged;
-- four are added:
--
--   documents       [{source, live, approved}] per source, deleted_at is null.
--                   ASSUMPTION: "approved" = documents.review_status = 'approved'
--                   (gold layer, migration 0009). "live" = every non-deleted row,
--                   sections included.
--   runs_daily      last 14 days (America/Chicago) of kb-engine `run.finished`
--                   events, one row per (day, source). Counts are summed when a
--                   source ran twice in a day; `ok` is the LAST run's status.
--                   ASSUMPTION: attrs.ingest has scanned/inserted/updated.
--   review_waiting  up to 10 undecided review_items joined to documents.
--   areas           one row per workspace.domains row; `items` counts live
--                   parent pages only (parent_external_id is null).
--
-- Access is unchanged: kb_engine holds zero table grants and may only EXECUTE.

create or replace function workspace.engine_status(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_admin boolean;
begin
    select exists (
        select 1
        from workspace.principals
        where lower(email) = lower(p_email)
          and active
          and role = 'administrator'
    ) into v_admin;

    if p_email is null or not coalesce(v_admin, false) then
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
    );
end;
$$;

comment on function workspace.engine_status(text) is
    'Engine dashboard readings in one call. Administrators only (raises 42501 otherwise).';

revoke all on function workspace.engine_status(text) from public;
grant execute on function workspace.engine_status(text) to kb_engine;
