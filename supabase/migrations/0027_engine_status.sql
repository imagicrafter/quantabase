-- 0027_engine_status.sql
--
-- One read for the Engine dashboard (`GET /status`). The dashboard is the set of
-- gauges defined in engine/engine.yaml; this function returns the readings the
-- gauges point at, in one round trip:
--
--   connectors        workspace.connector_state (Knowledge sources)
--   review_undecided  open items in the review queue
--   people            principals + their domain grants (people have an email;
--                     machine principals do not)
--   snapshot          the latest `engine.sensors_snapshot` event, written by the
--                     caretaker (kb-health) every 2 hours: agent job
--                     state, workshop jobs, Slack status, open health findings
--   recent            the last 12 info/warn/error events
--
-- Access: kb_engine still holds zero table grants. It may EXECUTE this one
-- SECURITY DEFINER function, which refuses unless the caller's email belongs to
-- an ACTIVE ADMINISTRATOR principal. The route passes the email from a verified
-- Cloudflare Access assertion; a bug in the route cannot widen who sees this.

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
