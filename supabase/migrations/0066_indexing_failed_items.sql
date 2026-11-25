-- 0066_indexing_failed_items.sql
--
-- The Indexing screen lists the failed items, each with the last error the
-- curator recorded for it (source_items.curator_error, written by
-- curator_item_done; 500 characters at most, the curator's own reason or
-- the database's RAISE text, never mail content). Before this, Indexing
-- showed only a count, so a failure could not be told apart from another.
--
-- app_indexing as in 0062, plus 'failed_items': the 20 most recent failed
-- items (id, title, source, attempts, error, received_at).

create or replace function workspace.app_indexing(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_run jsonb;
begin
    perform workspace._admin_require(p_email);
    select jsonb_build_object('started_at', r.started_at, 'finished_at', r.finished_at,
                              'status', r.status, 'stats', r.stats)
      into v_run
    from workspace.curator_runs r order by r.started_at desc limit 1;
    return jsonb_build_object(
        'pages', (select count(*) from workspace.pages p where p.deleted_at is null),
        'summaries_pending', (select count(*) from workspace.pages p
                              where p.deleted_at is null and p.summary_queued_at is not null),
        'items_waiting', (select count(*) from workspace.source_items s
                          where s.deleted_at is null and s.curated_at is null
                            and (s.flagged is false or s.released_at is not null)),
        'items_flagged', (select count(*) from workspace.source_items s
                          where s.deleted_at is null and s.curated_at is null
                            and s.flagged is true and s.released_at is null),
        'items_failed', (select count(*) from workspace.source_items s
                         where s.deleted_at is null and s.curator_outcome = 'failed'),
        'failed_items', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', x.id, 'title', x.title, 'source', x.source,
                       'attempts', x.curator_attempts, 'error', x.curator_error,
                       'received_at', x.received_at)
                   order by x.received_at desc)
            from (select s.id, s.title, s.source, s.curator_attempts, s.curator_error, s.received_at
                  from workspace.source_items s
                  where s.deleted_at is null and s.curator_outcome = 'failed'
                  order by s.received_at desc
                  limit 20) x), '[]'::jsonb),
        'last_run', v_run,
        'curator', (select jsonb_build_object('enabled', s.enabled, 'model', s.model,
                                              'last_wake_at', s.last_wake_at,
                                              'has_engine_url', s.engine_url is not null,
                                              'consensus', s.consensus,
                                              'tiebreak_model', s.tiebreak_model)
                    from workspace.curator_settings s where s.id),
        'uncertain', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'item_title', x.title, 'source', x.source, 'decision', x.decision,
                       'proposals', x.proposals, 'created_at', x.created_at)
                   order by x.created_at desc)
            from (select si.title, si.source, u.decision, u.proposals, u.created_at
                  from workspace.curator_uncertain u
                  join workspace.source_items si on si.id = u.item_id
                  order by u.created_at desc
                  limit 20) x), '[]'::jsonb),
        'has_model_key', workspace._curator_vault_secret('kbe_model_key') is not null,
        'backup', (select jsonb_build_object('enabled', b.enabled, 'last_finished_at', b.last_finished_at,
                                             'last_status', b.last_status)
                   from workspace.backup_settings b where b.id));
end;
$$;

revoke all on function workspace.app_indexing(text) from public;
revoke all on function workspace.app_indexing(text) from anon, authenticated;
grant execute on function workspace.app_indexing(text) to kb_engine;

-- VERIFY ------------------------------------------------------------------
-- select workspace.app_indexing('<admin email>')->'failed_items';
--
-- ROLLBACK ----------------------------------------------------------------
-- re-run 0062's app_indexing(text).
