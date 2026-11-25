-- curator_consensus_test.sql -- checks for migration 0062 (consensus curation).
-- Run by apply_local.sh as a superuser. One transaction, rolled back.

begin;

create or replace function pg_temp.raises(p_sql text, p_state text default null)
returns boolean
language plpgsql
as $$
begin
    execute p_sql;
    return false;
exception when others then
    if p_state is not null and sqlstate <> p_state then
        raise exception 'expected SQLSTATE % but got % (%) for: %', p_state, sqlstate, sqlerrm, p_sql;
    end if;
    return true;
end;
$$;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('cc-boss', 'Boss', 'administrator', 'cc-boss@example.com', true, 'sub-cc-boss', 'tok-cc-boss'),
    ('cc-ann',  'Ann',  'reader',        'cc-ann@example.com',  true, 'sub-cc-ann',  'tok-cc-ann');

do $$
begin
    assert (select relrowsecurity from pg_class where oid = 'workspace.curator_uncertain'::regclass), 'RLS';
    assert not has_table_privilege('kb_engine', 'workspace.curator_uncertain', 'select'), 'no table grant';
    assert has_function_privilege('kb_engine', 'workspace.curator_consensus_get()', 'execute');
    assert not has_function_privilege('anon', 'workspace.curator_consensus_get()', 'execute');
    assert has_function_privilege('kb_engine', 'workspace.curator_uncertain_record(uuid, text, text[])', 'execute');
    assert not has_function_privilege('anon', 'workspace.curator_uncertain_record(uuid, text, text[])', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.curator_uncertain_record(uuid, text, text[])', 'execute');
    -- Defaults: off since 0069 (one writer), primary gpt-oss-120b, tiebreak deepseek-v4.1-flash.
    assert workspace.curator_consensus_get() @> jsonb_build_object(
        'enabled', false, 'primary_model', 'openai-gpt-oss-120b', 'tiebreak_model', 'deepseek-v4.1-flash',
        'strong_model', 'deepseek-v4.1-flash'),
        workspace.curator_consensus_get()::text;
    assert pg_temp.raises($q$update workspace.curator_settings set tiebreak_model = 'tiny-model'$q$, '23514');
end $$;

set local role kb_engine;
do $$
declare
    v_item uuid;
    v jsonb;
begin
    v_item := (workspace.source_item_record('sub-cc-ann', jsonb_build_object(
        'source', 'drive', 'source_id', 'cc-1', 'title', 'Pilot pricing', 'body', 'x'))->>'id')::uuid;
    perform workspace.curator_uncertain_record(v_item, 'field:deal:x:stage', array['"lead"', '"proposal"', '"won"']);
    assert pg_temp.raises(format($q$select workspace.curator_uncertain_record(%L, 'd', array['a'])$q$,
                                 gen_random_uuid()), '22023');

    v := workspace.app_indexing('cc-boss@example.com');
    assert (v->'curator'->>'consensus')::boolean is false, v::text;  -- off by default since 0069
    assert v->'curator'->>'tiebreak_model' = 'deepseek-v4.1-flash';
    assert v->'uncertain'->0->>'item_title' = 'Pilot pricing', v::text;
    assert v->'uncertain'->0->'proposals' = '["\"lead\"", "\"proposal\"", "\"won\""]'::jsonb, v::text;
    assert pg_temp.raises($q$select workspace.app_indexing('cc-ann@example.com')$q$, '42501');
end $$;
reset role;

rollback;
