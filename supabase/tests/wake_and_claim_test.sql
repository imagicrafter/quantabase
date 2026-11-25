-- wake_and_claim_test.sql -- checks for migration 0057.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.
--
--   * engine_setup_claim_held: kb_engine only; true once a code hash is stored
--     with the window open, false once setup completes; never returns a hash
--   * the wake trigger is on source_items; a wake with the curator off sends
--     nothing; curator_wake has no grant to any API role

begin;

do $$
declare
    v jsonb;
begin
    assert has_function_privilege('kb_engine', 'workspace.engine_setup_claim_held()', 'execute'), 'kb_engine claim_held';
    assert not has_function_privilege('anon', 'workspace.engine_setup_claim_held()', 'execute'), 'anon claim_held';
    assert not has_function_privilege('authenticated', 'workspace.engine_setup_claim_held()', 'execute'), 'authenticated claim_held';
    assert not has_function_privilege('kb_engine', 'workspace.curator_wake(boolean)', 'execute'), 'wake hidden from kb_engine';
    assert not has_function_privilege('anon', 'workspace.curator_wake(boolean)', 'execute'), 'wake hidden from anon';

    update workspace.engine_settings set setup_state = 'open', setup_code_hash = null where id;
    v := workspace.engine_setup_claim_held();
    assert (v->>'held')::boolean is false, 'no hash, nothing held';

    perform workspace.engine_setup_reopen(repeat('a', 64));
    v := workspace.engine_setup_claim_held();
    assert (v->>'held')::boolean, 'held after the Database screen stored the hash';
    assert v::text not like '%aaaaaaaa%', 'no hash returned';
    assert not (v ? 'setup_code_hash'), 'no hash key';

    update workspace.engine_settings set setup_state = 'complete' where id;
    assert (workspace.engine_setup_claim_held()->>'held')::boolean is false, 'complete: nothing held';

    assert exists (select 1 from pg_trigger t
                   where t.tgname = 'source_items_wake_curator'
                     and t.tgrelid = 'workspace.source_items'::regclass), 'wake trigger present';

    update workspace.curator_settings set enabled = false, last_wake_at = null where id;
    assert workspace.curator_wake(false) is null, 'off: no poke';
    assert (select last_wake_at from workspace.curator_settings where id) is null, 'off: no wake recorded';
end;
$$;

rollback;
