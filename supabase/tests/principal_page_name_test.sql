-- principal_page_name_test.sql -- checks for migration 0077 (the name the
-- curator uses for a person in page text). One transaction, rolled back.

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('pn-ann',   'Ann Example',         'administrator', 'PN-Ann@Example.com', true, 'sub-pn-ann',   'tok-pn-ann'),
    ('pn-mail',  'pn-mail@example.com', 'administrator', 'pn-mail@example.com', true, 'sub-pn-mail', 'tok-pn-mail'),
    ('pn-pat',   'Pat Reader',          'reader',        'pn-pat@example.com',  true, 'sub-pn-pat',  'tok-pn-pat');

-- The default: the display name, unless it is an email.
do $$
begin
    assert exists (select 1 from workspace.curator_account_people() a
                   where a.email = 'pn-ann@example.com' and a.page_name = 'Ann Example'), 'display name is the default page name';
    assert exists (select 1 from workspace.curator_account_people() a
                   where a.email = 'pn-mail@example.com' and a.page_name is null), 'an email display name gives no page name';
    assert exists (select 1 from workspace.curator_account_people() a
                   where a.email = 'pn-pat@example.com' and a.display_name = 'Pat Reader' and a.page_name = 'Pat Reader'), 'readers too';
end $$;

-- The column's shape is enforced.
do $$
begin
    begin
        update workspace.principals set page_name = ' Ann' where handle = 'pn-ann';
        assert false, 'untrimmed page name accepted';
    exception when check_violation then null;
    end;
    begin
        update workspace.principals set page_name = repeat('a', 61) where handle = 'pn-ann';
        assert false, '61 characters accepted';
    exception when check_violation then null;
    end;
    begin
        update workspace.principals set page_name = E'Ann\nX' where handle = 'pn-ann';
        assert false, 'a newline accepted';
    exception when check_violation then null;
    end;
    begin
        update workspace.principals set page_name = '' where handle = 'pn-ann';
        assert false, 'an empty page name accepted';
    exception when check_violation then null;
    end;
end $$;

-- An administrator sets their own names; the result is the new state.
do $$
declare
    v jsonb;
begin
    v := workspace.app_my_names_set('pn-mail@example.com', '  Mo Example ', ' Mo ');
    assert v->>'display_name' = 'Mo Example', 'display name trimmed and set';
    assert v->>'page_name' = 'Mo', 'page name trimmed and set';
    assert v->>'page_name_used' = 'Mo', 'page name used';
    assert exists (select 1 from workspace.curator_account_people() a
                   where a.email = 'pn-mail@example.com' and a.page_name = 'Mo'), 'curator sees it';
    -- An empty page name goes back to the default.
    v := workspace.app_my_names_set('pn-mail@example.com', 'Mo Example', '');
    assert v->>'page_name' is null, 'page name cleared';
    assert v->>'page_name_used' = 'Mo Example', 'default is the display name';
    v := workspace.app_my_names('PN-MAIL@example.com');
    assert v->>'email' = 'pn-mail@example.com', 'reads the caller by email, any case';
end $$;

-- Bad values are refused (22023) and nothing changes.
do $$
begin
    begin
        perform workspace.app_my_names_set('pn-ann@example.com', 'Ann Example', repeat('x', 61));
        assert false, 'a 61-character page name accepted';
    exception when sqlstate '22023' then null;
    end;
    begin
        perform workspace.app_my_names_set('pn-ann@example.com', 'Ann Example', E'Ann\tB');
        assert false, 'a control character accepted';
    exception when sqlstate '22023' then null;
    end;
    begin
        perform workspace.app_my_names_set('pn-ann@example.com', '   ', 'Ann');
        assert false, 'an empty display name accepted';
    exception when sqlstate '22023' then null;
    end;
    assert (select page_name from workspace.principals where handle = 'pn-ann') is null, 'nothing changed';
end $$;

-- Administrators only, and only their own row.
do $$
begin
    begin
        perform workspace.app_my_names_set('pn-pat@example.com', 'Pat', 'Pat');
        assert false, 'a reader changed names';
    exception when sqlstate '42501' then null;
    end;
    begin
        perform workspace.app_my_names('pn-pat@example.com');
        assert false, 'a reader read names';
    exception when sqlstate '42501' then null;
    end;
    begin
        perform workspace.app_my_names_set('nobody@example.com', 'X', 'X');
        assert false, 'a stranger changed names';
    exception when sqlstate '42501' then null;
    end;
    perform workspace.app_my_names_set('pn-ann@example.com', 'Ann Example', 'Ann');
    assert (select page_name from workspace.principals where handle = 'pn-pat') is null, 'another person untouched';
    assert (select display_name from workspace.principals where handle = 'pn-pat') = 'Pat Reader', 'another person untouched';
end $$;

-- Only the Engine's role may call them.
do $$
begin
    assert not has_function_privilege('anon', 'workspace.curator_account_people()', 'execute'), 'anon cannot list people';
    assert not has_function_privilege('authenticated', 'workspace.curator_account_people()', 'execute'), 'authenticated cannot list people';
    assert has_function_privilege('kb_engine', 'workspace.curator_account_people()', 'execute'), 'kb_engine lists people';
    assert not has_function_privilege('anon', 'workspace.app_my_names_set(text, text, text)', 'execute'), 'anon cannot set names';
    assert not has_function_privilege('authenticated', 'workspace.app_my_names_set(text, text, text)', 'execute'), 'authenticated cannot set names';
    assert has_function_privilege('kb_engine', 'workspace.app_my_names_set(text, text, text)', 'execute'), 'kb_engine sets names';
    assert not has_function_privilege('anon', 'workspace.app_my_names(text)', 'execute'), 'anon cannot read names';
    assert has_function_privilege('kb_engine', 'workspace.app_my_names(text)', 'execute'), 'kb_engine reads names';
    assert not has_function_privilege('kb_engine', 'workspace._principal_page_name(text, text)', 'execute'), 'the rule is internal';
end $$;

rollback;
