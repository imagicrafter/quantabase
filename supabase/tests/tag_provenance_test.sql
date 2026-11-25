-- tag_provenance_test.sql -- checks for migration 0031.
-- Run by apply_local.sh against a throwaway database, as a superuser. Any
-- failed check raises and stops the run. One transaction, rolled back.

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
        raise exception 'expected SQLSTATE % but got % (%) for: %',
            p_state, sqlstate, sqlerrm, p_sql;
    end if;
    return true;
end;
$$;

insert into workspace.principals (handle, display_name, role, email)
values ('owner', 'Pat Owner', 'administrator', 'owner@example.com'),
       ('reader', 'A Reader', 'reader', 'reader@example.com');

-- 1. Who may run it: kb_engine only, and no new table grant.
do $$
begin
    assert has_function_privilege('kb_engine', 'workspace.tagging_health(text)', 'execute');
    assert not has_function_privilege('anon', 'workspace.tagging_health(text)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.tagging_health(text)', 'execute');
    assert not has_function_privilege('kb_ingest', 'workspace.tagging_health(text)', 'execute');
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
end $$;

-- 2. The pullers' role writes both columns; a made-up tag_source is refused.
set local role kb_ingest;
insert into workspace.documents
    (source, external_id, source_hash, title, body, domains, tag_source, tag_signals,
     parent_external_id, deleted_at)
values
    ('wiki', 'a.md', 'h', 'A', 'b', '{consulting}', 'content', '{consulting}', null, null),
    ('wiki', 'a.md#00-x', 'h', 'A x', 'b', '{consulting}', 'content', '{consulting}', 'a.md', null),
    ('wiki', 'b.md', 'h', 'B', 'b', '{unclassified}', 'default', '{}', null, null),
    ('wiki', 'c.md', 'h', 'C', 'b', '{unclassified}', 'content',
        '{unknown_tag,unknown_tag:privte}', null, null),
    ('wiki', 'gone.md', 'h', 'Gone', 'b', '{unclassified}', 'default', '{}', null, now()),
    ('wiki', 'old.md', 'h', 'Old', 'b', '{unclassified}', null, null, null, null),
    ('drive', 'f1', 'h', 'F1', 'b', '{properties}', 'container', '{properties}', null, null),
    ('drive', 'f2', 'h', 'F2', 'b', '{properties}', 'source_default', '{}', null, null);
do $$
begin
    assert pg_temp.raises($q$
        insert into workspace.documents
            (source, external_id, source_hash, title, body, domains, tag_source)
        values ('wiki', 'bad.md', 'h', 'Bad', 'b', '{consulting}', 'keywords')$q$, '23514'),
        'an unknown tag_source must be refused';
end $$;
reset role;

-- 3. Counts: whole, live documents only.
set local role kb_engine;
do $$
declare
    v_all  jsonb := workspace.tagging_health('Owner@Example.com');
    v_wiki jsonb;
    v_drive jsonb;
begin
    assert jsonb_array_length(v_all) = 2, v_all::text;
    v_drive := v_all->0;
    v_wiki := v_all->1;
    assert v_wiki->>'source' = 'wiki' and v_drive->>'source' = 'drive';
    assert (v_wiki->>'total')::int = 4, v_wiki::text;
    assert (v_wiki #>> '{by_tag_source,content}')::int = 2;
    assert (v_wiki #>> '{by_tag_source,default}')::int = 1;
    assert (v_wiki #>> '{by_tag_source,not_recorded}')::int = 1;
    assert (v_wiki->>'untagged')::int = 1;
    assert (v_wiki->>'unknown_tag')::int = 1;
    assert (v_drive #>> '{by_tag_source,container}')::int = 1;
    assert (v_drive #>> '{by_tag_source,source_default}')::int = 1;
    assert (v_drive->>'untagged')::int = 0 and (v_drive->>'unknown_tag')::int = 0;

    -- 4. Administrators only.
    assert pg_temp.raises($q$select workspace.tagging_health('reader@example.com')$q$, '42501');
    assert pg_temp.raises($q$select workspace.tagging_health('nobody@example.com')$q$, '42501');
    assert pg_temp.raises($q$select workspace.tagging_health(null)$q$, '42501');
    assert pg_temp.raises('select count(*) from workspace.documents', '42501'),
        'kb_engine must not read the table directly';
end $$;
reset role;

rollback;
