-- ticket_work_items_test.sql -- checks for migration 0073.
--   * a work item (held mail) closes by itself when its queue empties, with a note
--   * a fault (failed run) only looks fixed, and stays open for a person

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('wi-boss', 'Work Admin', 'administrator', 'wi-boss@example.com', true, 'sub-wi-boss', 'tok-wi-boss');

do $$
declare
    v_ref text;
begin
    delete from workspace.pipeline_tickets;
    delete from workspace.curator_runs;
    update workspace.source_items set flagged = false where flagged is true;

    perform workspace._ticket_raise('held_mail', 'held_mail', 'mailroom', 'Mail is held', 'x', 'y', '/app/flagged');
    perform workspace._ticket_raise('curator_failed', 'curator_failed', 'author', 'Run failed', 'x', 'y', '/setup/pipeline');
    select ref into v_ref from workspace.pipeline_tickets where kind = 'held_mail';

    -- nothing is held and the last run did not fail: both causes are gone
    perform workspace.curator_tickets_sync();

    assert (select status from workspace.pipeline_tickets where ref = v_ref) = 'closed', 'work item closed itself';
    assert (select closed_by from workspace.pipeline_tickets where ref = v_ref) = 'the Engine', 'closed by the Engine';
    assert exists (select 1 from workspace.pipeline_ticket_notes n join workspace.pipeline_tickets t on t.id = n.ticket_id
                   where t.ref = v_ref and n.body = 'Closed by itself: nothing left waiting.'), 'closing note';
    assert (select status from workspace.pipeline_tickets where kind = 'curator_failed') = 'open', 'fault stays open';
    assert (select cleared_at from workspace.pipeline_tickets where kind = 'curator_failed') is not null, 'fault looks fixed';
    -- a failed item opens a fault ticket on the Author step
    insert into workspace.source_items (owner_principal_id, source, source_id, version, title, body, topics, content_hash, curator_outcome)
    select p.id, 'gmail', 'wi-m1', 1, 'Broken mail', 'x', array[]::text[], 'wi-h1', 'failed'
    from workspace.principals p where p.handle = 'wi-boss';
    perform workspace.curator_tickets_sync();
    assert (select step from workspace.pipeline_tickets where kind = 'items_failed' and status = 'open') = 'author', 'failed items ticket';
    -- a fault: it is not closed by itself when the item goes
    update workspace.source_items set deleted_at = now() where source_id = 'wi-m1';
    perform workspace.curator_tickets_sync();
    assert (select status from workspace.pipeline_tickets where kind = 'items_failed') = 'open', 'fault stays open';
    assert not has_function_privilege('kb_engine', 'workspace._ticket_clear(text, text[])', 'execute'), 'internal';
end;
$$;

rollback;
