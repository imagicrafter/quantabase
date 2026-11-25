-- curator_account_people_test.sql -- checks for migration 0070 (the
-- account people the curator never makes a person page for). One
-- transaction, rolled back.

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('ap-boss', 'Avery Boss', 'administrator', 'AP-Boss@Example.com', true,  'sub-ap-boss', 'tok-ap-boss'),
    ('ap-ann',  'Ann Reader', 'reader',        'ap-ann@example.com',  true,  'sub-ap-ann',  'tok-ap-ann'),
    ('ap-gone', 'Gone Person','reader',        'ap-gone@example.com', false, 'sub-ap-gone', 'tok-ap-gone');

do $$
begin
    assert exists (select 1 from workspace.curator_account_people() a
                   where a.email = 'ap-boss@example.com' and a.display_name = 'Avery Boss'), 'owner listed, email lower case';
    assert exists (select 1 from workspace.curator_account_people() a where a.email = 'ap-ann@example.com'), 'reader listed';
    assert not exists (select 1 from workspace.curator_account_people() a where a.email = 'ap-gone@example.com'), 'inactive left out';
end $$;

-- Only the Engine's role may call it.
do $$
begin
    assert not has_function_privilege('anon', 'workspace.curator_account_people()', 'execute'), 'anon cannot call it';
    assert not has_function_privilege('authenticated', 'workspace.curator_account_people()', 'execute'), 'authenticated cannot call it';
    assert has_function_privilege('kb_engine', 'workspace.curator_account_people()', 'execute'), 'kb_engine can call it';
end $$;

rollback;
