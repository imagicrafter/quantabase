-- pipeline_tickets_test.sql -- checks for migration 0072.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * a failed curator run and held mail open tickets (QB-nnnn) on their step
--   * the same open problem never opens twice; it is seen again instead
--   * a cleared cause marks "looks fixed" and never closes the ticket
--   * notes and closing: administrators only, closer and time recorded
--   * after closing, the same problem opens a NEW ticket
--   * grants: kb_engine only; nothing to anon or authenticated

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('tk-boss', 'Ticket Admin', 'administrator', 'tk-boss@example.com', true, 'sub-tk-boss', 'tok-tk-boss'),
    ('tk-ann',  'Ticket Reader', 'reader',       'tk-ann@example.com',  true, 'sub-tk-ann',  'tok-tk-ann');

do $$
declare
    v        jsonb;
    v_ref    text;
    v_ref2   text;
    v_denied boolean := false;
    v_run    uuid;
begin
    assert has_function_privilege('kb_engine', 'workspace.app_tickets_list(text, text)', 'execute'), 'kb_engine list';
    assert has_function_privilege('kb_engine', 'workspace.app_ticket_close(text, text, text)', 'execute'), 'kb_engine close';
    assert not has_function_privilege('anon', 'workspace.app_tickets_list(text, text)', 'execute'), 'anon list';
    assert not has_function_privilege('authenticated', 'workspace.app_ticket_note(text, text, text)', 'execute'), 'authenticated note';
    assert has_function_privilege('kb_engine', 'workspace.admin_ticket_note(text, text, text)', 'execute'), 'kb_engine mcp note';
    assert to_regprocedure('workspace.admin_ticket_close(text, text, text)') is null, 'no close for the MCP side';
    assert not has_function_privilege('anon', 'workspace.admin_tickets_list(text, text)', 'execute'), 'anon mcp list';
    assert not has_function_privilege('kb_engine', 'workspace._ticket_raise(text, text, text, text, text, text, text)', 'execute'), 'raise is internal';

    -- start clean: no runs, no held mail
    delete from workspace.pipeline_tickets;
    delete from workspace.curator_runs;

    insert into workspace.curator_runs (status, started_at, finished_at, stats)
    values ('failed', now() - interval '10 minutes', now() - interval '9 minutes', '{"error": "writer timed out"}')
    returning id into v_run;

    v := workspace.app_tickets_list('tk-boss@example.com', 'open');
    assert jsonb_array_length(v) >= 1, 'a ticket opened';
    select t->>'ref' into v_ref from jsonb_array_elements(v) t where t->>'kind' = 'curator_failed';
    assert v_ref ~ '^QB-[0-9]{4,}$', 'readable ref ' || coalesce(v_ref, 'null');
    assert (select step from workspace.pipeline_tickets where ref = v_ref) = 'author', 'on the Author step';
    assert (select what_happened from workspace.pipeline_tickets where ref = v_ref) like '%writer timed out%', 'what happened';

    -- dedupe: the same open problem does not open twice
    perform workspace.app_tickets_list('tk-boss@example.com', 'open');
    assert (select count(*) from workspace.pipeline_tickets where kind = 'curator_failed') = 1, 'no duplicate';

    -- the cause clears: looks fixed, still open
    insert into workspace.curator_runs (status, started_at, finished_at, stats)
    values ('ok', now() - interval '1 minute', now(), '{}');
    perform workspace.app_tickets_list('tk-boss@example.com', 'open');
    assert (select status from workspace.pipeline_tickets where ref = v_ref) = 'open', 'never closed automatically';
    assert (select cleared_at from workspace.pipeline_tickets where ref = v_ref) is not null, 'looks fixed';

    -- a reader is refused
    begin
        perform workspace.app_tickets_list('tk-ann@example.com', 'open');
    exception when others then v_denied := true;
    end;
    assert v_denied, 'reader refused list';
    v_denied := false;
    begin
        perform workspace.app_ticket_close('tk-ann@example.com', v_ref, null);
    exception when others then v_denied := true;
    end;
    assert v_denied, 'reader refused close';

    -- notes and close
    assert workspace.admin_ticket_note('tk-boss@example.com', lower(v_ref), 'Looked at the log; retry worked.'), 'note added (MCP side)';
    assert jsonb_array_length(workspace.admin_tickets_list('tk-boss@example.com', null)) >= 1, 'MCP list';
    assert workspace.app_ticket_close('tk-boss@example.com', v_ref, 'fixed by the retry'), 'closed';
    assert not workspace.app_ticket_close('tk-boss@example.com', v_ref, null), 'closing twice is false';
    v := workspace.app_ticket_get('tk-boss@example.com', v_ref);
    assert v->>'status' = 'closed' and v->>'closed_by' = 'tk-boss@example.com', 'who closed it';
    assert jsonb_array_length(v->'notes') = 2, 'note plus closing note';
    assert workspace.app_ticket_get('tk-boss@example.com', 'QB-9999999') is null, 'unknown ref';

    -- the problem comes back: a new ticket
    insert into workspace.curator_runs (status, started_at, finished_at, stats)
    values ('failed', now() + interval '1 minute', now() + interval '2 minutes', '{}');
    v := workspace.app_tickets_list('tk-boss@example.com', 'open');
    select t->>'ref' into v_ref2 from jsonb_array_elements(v) t where t->>'kind' = 'curator_failed';
    assert v_ref2 is not null and v_ref2 <> v_ref, 'a new ticket after close';

    -- the hourly tick runs the checks with nobody looking (no engine_url: no poke)
    update workspace.pipeline_tickets set status = 'closed', closed_at = now(), closed_by = 'test' where status = 'open';
    insert into workspace.curator_runs (status, started_at, finished_at, stats)
    values ('failed', now() + interval '3 minutes', now() + interval '4 minutes', '{}');
    perform workspace.curator_tick_poke();
    assert exists (select 1 from workspace.pipeline_tickets where kind = 'curator_failed' and status = 'open'), 'tick opened a ticket';
    -- and so does the end of a run (the service's call)
    update workspace.pipeline_tickets set status = 'closed', closed_at = now(), closed_by = 'test' where status = 'open';
    perform workspace.curator_tickets_sync();
    assert exists (select 1 from workspace.pipeline_tickets where kind = 'curator_failed' and status = 'open'), 'run end opened a ticket';
    assert has_function_privilege('kb_engine', 'workspace.curator_tickets_sync()', 'execute'), 'kb_engine sync';
    assert not has_function_privilege('kb_engine', 'workspace._tickets_sync()', 'execute'), 'inner sync not granted';
    assert not has_function_privilege('kb_engine', 'workspace.curator_tick_poke(text)', 'execute'), 'tick stays cron-only';

    -- bad status is refused
    v_denied := false;
    begin
        perform workspace.app_tickets_list('tk-boss@example.com', 'maybe');
    exception when sqlstate '22023' then v_denied := true;
    end;
    assert v_denied, 'status checked';
end;
$$;

rollback;
