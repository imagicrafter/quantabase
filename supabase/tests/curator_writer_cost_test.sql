-- curator_writer_cost_test.sql -- checks for migration 0069 (single writer,
-- triage, cost this month). One transaction, rolled back.

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('wc-boss', 'Boss', 'administrator', 'wc-boss@example.com', true, 'sub-wc-boss', 'tok-wc-boss'),
    ('wc-ann',  'Ann',  'reader',        'wc-ann@example.com',  true, 'sub-wc-ann',  'tok-wc-ann');

-- Settings: consensus off, Sonnet writer, triage on with gpt-oss.
do $$
declare
    v jsonb := workspace.curator_consensus_get();
begin
    assert (v->>'enabled')::boolean is false, v::text;
    assert v->>'writer_model' = 'anthropic-claude-sonnet-5.5', v::text;
    assert (v->>'triage')::boolean is true, v::text;
    assert v->>'triage_model' = 'openai-gpt-oss-120b', v::text;
end $$;

update workspace.curator_settings set writer_model = 'anthropic-claude-5.5-haiku' where id;

do $$
begin
    begin
        update workspace.curator_settings set writer_model = 'some-cheap-model' where id;
        raise exception 'a writer model off the list was accepted';
    exception when check_violation then null;
    end;
end $$;

-- Cost: two priced runs this month, one older run without usd, one last month.
delete from workspace.curator_runs;
insert into workspace.curator_runs (mode, started_at, status, stats) values
    ('tick', now(), 'ok', '{"items": 10, "usd": 0.25}'),
    ('tick', now(), 'ok', '{"items": 5, "usd": 0.05}'),
    ('tick', now(), 'ok', '{"items": 3}'),
    ('tick', date_trunc('month', now()) - interval '2 days', 'ok', '{"items": 100, "usd": 9}');

set local role kb_engine;
do $$
declare
    v jsonb := workspace.app_curator_cost('wc-boss@example.com');
begin
    assert (v->>'usd')::numeric = 0.30, v::text;
    assert (v->>'items')::int = 15, v::text;
    assert (v->>'per_item_usd')::numeric = 0.02, v::text;
    assert (v->>'runs_without_cost')::int = 1, v::text;
    begin
        perform workspace.app_curator_cost('wc-ann@example.com');
        raise exception 'a reader saw the cost';
    exception when others then
        if sqlerrm like 'a reader saw%' then raise; end if;
    end;
end $$;

rollback;
