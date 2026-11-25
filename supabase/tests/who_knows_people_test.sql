-- who_knows_people_test.sql -- checks for migration 0043.
-- Run by apply_local.sh against a throwaway database, as a superuser (it uses
-- `set role` to act as the service role). Any failed check raises and stops
-- the run. Everything happens in one transaction that is rolled back.
--
-- THE RULE UNDER TEST
--   The connector's search returns each row's author and participants, and
--   only for rows the caller may see. A person named only in a document the
--   caller cannot see is never returned to that caller.

begin;

insert into workspace.domains (domain, label, sensitive) values
    ('consulting', 'Consulting', false),
    ('private', 'Private', true)
on conflict (domain) do nothing;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject) values
    ('gina', 'Gina Granted', 'reader', 'gina@example.com', true, 'sub-gina'),
    ('paula', 'Paula Private', 'reader', 'paula@example.com', true, 'sub-paula'),
    ('zed', 'Zed Zero', 'reader', 'zed@example.com', true, 'sub-zed'),
    ('gone', 'Gone Reader', 'reader', 'gone@example.com', false, 'sub-gone');

insert into workspace.access_grants (principal_id, domain)
select p.id, g.domain
from (values ('gina', 'consulting'), ('paula', 'private'), ('gone', 'consulting'))
    as g(handle, domain)
join workspace.principals p on p.handle = g.handle;

insert into workspace.documents
    (source, external_id, source_hash, title, body, distillation, domains,
     review_status, author, metadata, embedding)
select v.source, v.external_id, 'wk', v.title, 'roadmap words', 'roadmap', v.domains,
       v.review_status, v.author, v.metadata::jsonb,
       array_fill(0.1::real, array[384])::vector
from (values
    ('wiki', 'wk-open', 'roadmap page', '{consulting}'::text[], 'approved', 'Ada Open',
        '{}'),
    ('drive', 'wk-people', 'roadmap file', '{consulting}'::text[], 'unreviewed', null,
        '{"participants": ["Bea Open", "Cy Open"]}'),
    ('wiki', 'wk-private', 'roadmap secret', '{private}'::text[], 'approved', 'Pat Private',
        '{"participants": ["Quinn Private"]}'),
    ('wiki', 'wk-rejected', 'roadmap rejected', '{consulting}'::text[], 'rejected', 'Rex Rejected',
        '{"participants": ["Ria Rejected"]}'),
    ('wiki', 'wk-odd', 'roadmap odd', '{consulting}'::text[], 'approved', '',
        '{"participants": "not a list"}')
) as v(source, external_id, title, domains, review_status, author, metadata);
select workspace.refresh_documents_term_stats();

-- Every name the search returns to one caller, sorted.
create or replace function pg_temp.people(p_sub text) returns text[]
language sql as $$
    select coalesce(array_agg(distinct n order by n), '{}')
    from workspace.documents_search_by_oauth_subject(
        p_sub, 'roadmap', array_fill(0.1::real, array[384])::vector, 100) s
    cross join lateral unnest(
        array_remove(array[nullif(s.author, '')], null) || s.participants) as n;
$$;

-- 1. Privileges are as before the function was dropped and made again.
do $$
declare
    v_sig text := 'workspace.documents_search_by_oauth_subject(text, text, vector, integer, '
        'integer, integer, double precision, double precision[], double precision, boolean)';
begin
    assert has_function_privilege('kb_engine', v_sig, 'execute');
    assert not has_function_privilege('anon', v_sig, 'execute');
    assert not has_function_privilege('authenticated', v_sig, 'execute');
    assert not has_function_privilege('kb_ingest', v_sig, 'execute');
    assert not has_function_privilege('public', v_sig, 'execute');
    assert (select p.prosecdef from pg_proc p where p.oid = v_sig::regprocedure),
        'still SECURITY DEFINER';
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
end $$;

set local role kb_engine;

-- 2. A caller gets people only from the documents they can see.
do $$
begin
    assert pg_temp.people('sub-gina') = array['Ada Open', 'Bea Open', 'Cy Open'],
        format('gina saw %s', pg_temp.people('sub-gina'));
    assert pg_temp.people('sub-paula') = array['Pat Private', 'Quinn Private'],
        format('paula saw %s', pg_temp.people('sub-paula'));
    -- No topics, inactive, unknown, empty: nobody.
    assert pg_temp.people('sub-zed') = '{}'::text[];
    assert pg_temp.people('sub-gone') = '{}'::text[];
    assert pg_temp.people('sub-nobody') = '{}'::text[];
    assert pg_temp.people('') = '{}'::text[];
end $$;

-- 3. Participants that are not a list read as an empty list, never an error.
do $$
declare
    v_row record;
begin
    select s.author, s.participants into v_row
    from workspace.documents_search_by_oauth_subject(
        'sub-gina', 'roadmap', array_fill(0.1::real, array[384])::vector, 100) s
    where s.external_id = 'wk-odd';
    assert found;
    assert v_row.participants = '{}'::text[];
end $$;

reset role;

-- 4. A long participant list is cut at 50 names.
do $$
declare
    v_n integer;
begin
    update workspace.documents
    set metadata = jsonb_build_object('participants',
        (select jsonb_agg('Person ' || g) from generate_series(1, 80) g))
    where external_id = 'wk-people';
    select coalesce(array_length(s.participants, 1), 0) into v_n
    from workspace.documents_search_by_oauth_subject(
        'sub-gina', 'roadmap', array_fill(0.1::real, array[384])::vector, 100) s
    where s.external_id = 'wk-people';
    assert v_n = 50, format('expected 50 participants, got %s', v_n);
end $$;

rollback;
