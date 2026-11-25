-- email_visibility_test.sql -- checks for migrations 0038 to 0040.
-- Run by apply_local.sh against a throwaway database, as a superuser (it uses
-- `set role` to act as each service role). Any failed check raises and stops
-- the run. Everything happens in one transaction that is rolled back.
--
-- THE RULE UNDER TEST
--   A row from Gmail is visible to a caller when
--     the caller owns it, or
--     it has an owner, the caller holds one of its topics, and it is approved.
--   A Gmail row with no owner is visible to nobody, and neither is one whose
--   owner has been switched off.
--   Every other row is visible exactly as before: the caller holds one of its
--   topics. Rejected and excluded rows are never returned to anyone.

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

insert into workspace.domains (domain, label, sensitive) values
    ('consulting', 'Consulting', false),
    ('properties', 'Rental Properties', false),
    ('private', 'Private', true)
on conflict (domain) do nothing;

-- One mailbox owner (an administrator), a second administrator who owns no
-- mail, a reader granted the topic, a reader granted another topic, a reader
-- with no grant at all, and an owner who has been switched off.
insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('olive', 'Olive Owner', 'administrator', 'olive@example.com', true, 'sub-olive', 'tok-olive'),
    ('adam', 'Adam Admin', 'administrator', 'adam@example.com', true, 'sub-adam', 'tok-adam'),
    ('gina', 'Gina Granted', 'reader', 'gina@example.com', true, 'sub-gina', 'tok-gina'),
    ('nora', 'Nora Other', 'reader', 'nora@example.com', true, 'sub-nora', 'tok-nora'),
    ('zed', 'Zed Zero', 'reader', 'zed@example.com', true, 'sub-zed', 'tok-zed'),
    ('mona', 'Mona Mailbox', 'reader', 'mona@example.com', true, 'sub-mona', 'tok-mona'),
    ('gone', 'Gone Owner', 'reader', 'gone@example.com', false, 'sub-gone', 'tok-gone');

insert into workspace.access_grants (principal_id, domain)
select p.id, g.domain
from (values ('gina', 'consulting'), ('nora', 'properties')) as g(handle, domain)
join workspace.principals p on p.handle = g.handle;

create temp table who (handle text primary key, id uuid, sub text, tok text);
insert into who
select handle, id, oauth_subject, token_hash from workspace.principals
where handle in ('olive', 'adam', 'gina', 'nora', 'zed', 'mona', 'gone');
grant select on who to kb_engine, kb_ingest, service_role;

-- 1. Privileges: no new way in.
do $$
begin
    assert (select count(*) from information_schema.role_table_grants
            where grantee = 'kb_engine' and table_schema not like 'pg_temp%') = 0,
        'kb_engine must have zero table grants';
    assert not has_table_privilege('kb_engine', 'workspace.documents', 'select');
    assert not has_table_privilege('anon', 'workspace.documents', 'select');
    assert not has_table_privilege('authenticated', 'workspace.documents', 'select');

    assert has_function_privilege('kb_ingest', 'workspace.principal_id_for_email(text)', 'execute');
    assert not has_function_privilege('kb_engine', 'workspace.principal_id_for_email(text)', 'execute');
    assert not has_function_privilege('anon', 'workspace.principal_id_for_email(text)', 'execute');
    assert not has_function_privilege('authenticated', 'workspace.principal_id_for_email(text)', 'execute');

    -- The helpers are internal: no service role may call them.
    assert not has_function_privilege('kb_engine',
        'workspace._document_visible(text, text[], uuid, text, text[], uuid)', 'execute');
    assert not has_function_privilege('anon',
        'workspace._document_visible(text, text[], uuid, text, text[], uuid)', 'execute');
    assert not has_function_privilege('kb_engine',
        'workspace._principal_id_for_oauth_subject(text)', 'execute');
    assert not has_function_privilege('anon',
        'workspace._principal_id_for_token_hash(text)', 'execute');

    assert has_function_privilege('kb_engine', 'workspace.document_get(text, uuid)', 'execute');
    assert not has_function_privilege('anon', 'workspace.document_get(text, uuid)', 'execute');
    assert has_function_privilege('kb_engine',
        'workspace.documents_search_by_oauth_subject(text, text, vector, integer, integer, '
        'integer, double precision, double precision[], double precision, boolean)', 'execute');
    assert not has_function_privilege('anon',
        'workspace.documents_search_by_oauth_subject(text, text, vector, integer, integer, '
        'integer, double precision, double precision[], double precision, boolean)', 'execute');
    assert not has_function_privilege('kb_engine',
        'workspace.documents_search(text, vector, text, integer, integer, integer, '
        'double precision, double precision[], double precision, boolean)', 'execute');
end $$;

-- 2. The pullers' role resolves an owner and writes the column.
set local role kb_ingest;
do $$
declare
    v_olive uuid := (select id from who where handle = 'olive');
    v_mona  uuid := (select id from who where handle = 'mona');
    v_gone  uuid := (select id from who where handle = 'gone');
    v_vec   vector(384) := array_fill(0.1::real, array[384])::vector;
begin
    assert workspace.principal_id_for_email(' Olive@Example.com ') = v_olive;
    assert workspace.principal_id_for_email('gone@example.com') is null, 'inactive owner';
    assert workspace.principal_id_for_email('nobody@example.com') is null;
    assert workspace.principal_id_for_email('') is null;
    assert workspace.principal_id_for_email(null) is null;

    insert into workspace.documents
        (source, external_id, source_hash, title, body, distillation, domains,
         review_status, owner_principal_id, embedding, deleted_at)
    values
        -- Email owned by olive, topic consulting.
        ('gmail', 'm-new', 'h', 'budget thread new', 'budget words', 'budget', '{consulting}',
            'unreviewed', v_olive, v_vec, null),
        ('gmail', 'm-ok', 'h', 'budget thread approved', 'budget words', 'budget', '{consulting}',
            'approved', v_olive, v_vec, null),
        ('gmail', 'm-rejected', 'h', 'budget thread rejected', 'budget words', 'budget',
            '{consulting}', 'rejected', v_olive, v_vec, null),
        ('gmail', 'm-excluded', 'h', 'budget thread excluded', 'budget words', 'budget',
            '{consulting}', 'excluded', v_olive, v_vec, null),
        ('gmail', 'm-deleted', 'h', 'budget thread deleted', 'budget words', 'budget',
            '{consulting}', 'approved', v_olive, v_vec, now()),
        -- Email with an unknown label: unclassified, owner-only.
        ('gmail', 'm-unclassified', 'h', 'budget thread unsorted', 'budget words', 'budget',
            '{unclassified}', 'approved', v_olive, v_vec, null),
        -- Email from before owners existed: nobody's.
        ('gmail', 'm-legacy', 'h', 'budget thread legacy', 'budget words', 'budget',
            '{consulting}', 'approved', null, v_vec, null),
        -- Email owned by a reader with no grants at all.
        ('gmail', 'm-mona', 'h', 'budget thread mona', 'budget words', 'budget', '{properties}',
            'unreviewed', v_mona, v_vec, null),
        -- Approved email whose owner has since been switched off.
        ('gmail', 'm-gone', 'h', 'budget thread gone', 'budget words', 'budget', '{consulting}',
            'approved', v_gone, v_vec, null),
        -- Everything else.
        ('wiki', 'w-new', 'h', 'budget page new', 'budget words', 'budget', '{consulting}',
            'unreviewed', null, v_vec, null),
        ('wiki', 'w-ok', 'h', 'budget page approved', 'budget words', 'budget', '{consulting}',
            'approved', null, v_vec, null),
        ('wiki', 'w-rejected', 'h', 'budget page rejected', 'budget words', 'budget',
            '{consulting}', 'rejected', null, v_vec, null),
        ('wiki', 'w-private', 'h', 'budget page private', 'budget words', 'budget', '{private}',
            'approved', null, v_vec, null),
        ('wiki', 'w-unclassified', 'h', 'budget page unsorted', 'budget words', 'budget',
            '{unclassified}', 'unreviewed', null, v_vec, null),
        ('drive', 'd-prop', 'h', 'budget file properties', 'budget words', 'budget',
            '{properties}', 'unreviewed', null, v_vec, null),
        ('drive', 'd-both', 'h', 'budget file both', 'budget words', 'budget',
            '{consulting,properties}', 'approved', null, v_vec, null),
        ('drive', 'd-deleted', 'h', 'budget file deleted', 'budget words', 'budget',
            '{consulting}', 'approved', null, v_vec, now()),
        ('fireflies', 'f-new', 'h', 'budget meeting', 'budget words', 'budget', '{consulting}',
            'unreviewed', null, v_vec, null);
    perform workspace.refresh_documents_term_stats();
end $$;
reset role;

-- Every id in the fixture, so a service role can ask for each one by id.
create temp table doc_ids as
    select d.id from workspace.documents d where d.source_hash = 'h';
grant select on doc_ids to kb_engine;

-- What each read path returns, as sorted external ids.
create or replace function pg_temp.via_get(p_sub text) returns text[]
language sql as $$
    select coalesce(array_agg(g.external_id order by g.external_id), '{}')
    from doc_ids d
    cross join lateral workspace.document_get(p_sub, d.id) g;
$$;

create or replace function pg_temp.via_search(p_sub text, p_approved boolean default false)
returns text[]
language sql as $$
    select coalesce(array_agg(s.external_id order by s.external_id), '{}')
    from workspace.documents_search_by_oauth_subject(
        p_sub, 'budget', array_fill(0.1::real, array[384])::vector, 100, 200, 60,
        365, array[1.30, 1.15, 1.00, 0.85], 1.25, p_approved) s;
$$;

create or replace function pg_temp.via_token(p_tok text, p_approved boolean default false)
returns text[]
language sql as $$
    select coalesce(array_agg(s.external_id order by s.external_id), '{}')
    from workspace.documents_search(
        'budget', array_fill(0.1::real, array[384])::vector, p_tok, 100, 200, 60,
        365, array[1.30, 1.15, 1.00, 0.85], 1.25, p_approved) s;
$$;

-- The rule as it stood BEFORE these migrations, for rows that are not email:
-- live, not rejected or excluded, and sharing a topic with the caller.
create or replace function pg_temp.before(p_sub text) returns text[]
language sql as $$
    select coalesce(array_agg(d.external_id order by d.external_id), '{}')
    from workspace.documents d
    where d.source <> 'gmail'
      and d.deleted_at is null
      and d.review_status not in ('rejected', 'excluded')
      and d.domains && workspace.resolve_domains_for_oauth_subject(p_sub);
$$;

create or replace function pg_temp.not_email(p_ids text[]) returns text[]
language sql as $$
    select coalesce(array_agg(x order by x), '{}') from unnest(p_ids) x where x not like 'm-%';
$$;

create or replace function pg_temp.only_email(p_ids text[]) returns text[]
language sql as $$
    select coalesce(array_agg(x order by x), '{}') from unnest(p_ids) x where x like 'm-%';
$$;

-- 3. Email, through the connector's two read paths (as kb_engine).
do $$
declare
    r record;
    v_expected text[];
    v_get text[];
    v_search text[];
begin
    for r in
        select * from (values
            -- The owner sees her own mail, approved or not, and her unsorted mail.
            ('sub-olive', array['m-new', 'm-ok', 'm-unclassified']),
            -- Another administrator gets no way round: approved mail in a topic
            -- he holds, and nothing else.
            ('sub-adam',  array['m-ok']),
            -- A reader with the topic: nothing until it is approved.
            ('sub-gina',  array['m-ok']),
            -- A reader with another topic, and one with none: never.
            ('sub-nora',  array[]::text[]),
            ('sub-zed',   array[]::text[]),
            -- An owner with no grants still sees her own mail.
            ('sub-mona',  array['m-mona']),
            -- Switched off, unknown, blank: nothing.
            ('sub-gone',  array[]::text[]),
            ('sub-nobody', array[]::text[]),
            ('',          array[]::text[])
        ) as t(sub, expected)
    loop
        v_expected := r.expected;
        set local role kb_engine;
        v_get := pg_temp.only_email(pg_temp.via_get(r.sub));
        v_search := pg_temp.only_email(pg_temp.via_search(r.sub));
        reset role;
        assert v_get = v_expected, format('document_get for %s: %s', r.sub, v_get);
        assert v_search = v_expected, format('search for %s: %s', r.sub, v_search);
    end loop;

    set local role kb_engine;
    assert pg_temp.only_email(pg_temp.via_get(null)) = '{}';
    assert pg_temp.only_email(pg_temp.via_search(null)) = '{}';
    -- "Approved only" narrows the owner's own view too.
    assert pg_temp.only_email(pg_temp.via_search('sub-olive', true))
        = array['m-ok', 'm-unclassified'];
    reset role;
end $$;

-- 4. Approval is what opens a thread to a granted reader; unapproving closes it.
do $$
begin
    set local role kb_engine;
    assert not ('m-new' = any (pg_temp.via_search('sub-gina')));
    assert not ('m-new' = any (pg_temp.via_get('sub-gina')));
    reset role;

    update workspace.documents set review_status = 'approved' where external_id = 'm-new';
    set local role kb_engine;
    assert 'm-new' = any (pg_temp.via_search('sub-gina')), 'approved mail reaches a granted reader';
    assert 'm-new' = any (pg_temp.via_get('sub-gina'));
    assert not ('m-new' = any (pg_temp.via_search('sub-nora'))), 'still needs the topic';
    assert not ('m-new' = any (pg_temp.via_get('sub-zed')));
    reset role;

    update workspace.documents set review_status = 'unreviewed' where external_id = 'm-new';
    set local role kb_engine;
    assert not ('m-new' = any (pg_temp.via_search('sub-gina'))), 'unapproved again: hidden again';
    assert 'm-new' = any (pg_temp.via_search('sub-olive'));
    reset role;

    -- Taking the grant away closes approved mail as well.
    delete from workspace.access_grants
    where principal_id = (select id from who where handle = 'gina');
    set local role kb_engine;
    assert pg_temp.only_email(pg_temp.via_search('sub-gina')) = '{}';
    assert pg_temp.only_email(pg_temp.via_get('sub-gina')) = '{}';
    reset role;
    insert into workspace.access_grants (principal_id, domain)
    select id, 'consulting' from who where handle = 'gina';
end $$;

-- 4b. Mail whose owner is switched off is hidden from everyone; switching the
-- owner back on shows it again, on the usual terms.
do $$
begin
    set local role kb_engine;
    assert not ('m-gone' = any (pg_temp.via_search('sub-olive')));
    assert not ('m-gone' = any (pg_temp.via_search('sub-gina')));
    assert not ('m-gone' = any (pg_temp.via_get('sub-adam')));
    assert not ('m-gone' = any (pg_temp.via_get('sub-gone')));
    reset role;

    update workspace.principals set active = true where handle = 'gone';
    set local role kb_engine;
    assert 'm-gone' = any (pg_temp.via_search('sub-gina'));
    assert 'm-gone' = any (pg_temp.via_get('sub-gone'));
    assert not ('m-gone' = any (pg_temp.via_search('sub-nora')));
    reset role;
    update workspace.principals set active = false where handle = 'gone';
end $$;

-- 5. Everything that is not email: the same rows as before, for every caller.
do $$
declare
    r record;
    v_before text[];
    v_get text[];
    v_search text[];
begin
    for r in select unnest(array['sub-olive', 'sub-adam', 'sub-gina', 'sub-nora', 'sub-zed',
                                 'sub-mona', 'sub-gone', 'sub-nobody', '']) as sub
    loop
        v_before := pg_temp.before(r.sub);
        set local role kb_engine;
        v_get := pg_temp.not_email(pg_temp.via_get(r.sub));
        v_search := pg_temp.not_email(pg_temp.via_search(r.sub));
        reset role;
        assert v_get = v_before,
            format('document_get changed for %s: %s vs %s', r.sub, v_get, v_before);
        assert v_search = v_before,
            format('search changed for %s: %s vs %s', r.sub, v_search, v_before);
    end loop;

    -- And the fixture is not trivially empty.
    assert pg_temp.before('sub-olive')
        = array['d-both', 'd-prop', 'f-new', 'w-new', 'w-ok'], pg_temp.before('sub-olive')::text;
    assert pg_temp.before('sub-gina') = array['d-both', 'f-new', 'w-new', 'w-ok'];
    assert pg_temp.before('sub-nora') = array['d-both', 'd-prop'];
    assert pg_temp.before('sub-zed') = '{}';
end $$;

-- 6. The token path follows the same rule. (A hosted project gives
-- service_role the schema when the schema is exposed; this database does not.)
grant usage on schema workspace to service_role;
set local role service_role;
do $$
begin
    assert pg_temp.via_token('tok-olive')
        = array['d-both', 'd-prop', 'f-new', 'm-new', 'm-ok', 'm-unclassified', 'w-new', 'w-ok'],
        pg_temp.via_token('tok-olive')::text;
    assert pg_temp.via_token('tok-adam') = array['d-both', 'd-prop', 'f-new', 'm-ok', 'w-new', 'w-ok'];
    assert pg_temp.via_token('tok-gina') = array['d-both', 'f-new', 'm-ok', 'w-new', 'w-ok'];
    assert pg_temp.via_token('tok-nora') = array['d-both', 'd-prop'];
    assert pg_temp.via_token('tok-zed') = '{}';
    assert pg_temp.via_token('tok-mona') = array['m-mona'];
    assert pg_temp.via_token('tok-gone') = '{}';
    assert pg_temp.via_token('tok-nobody') = '{}';
    assert pg_temp.via_token('') = '{}';
    assert pg_temp.via_token(null) = '{}';
end $$;
reset role;

-- 7. The wiki page lookup never returns email, whatever its title.
set local role kb_engine;
do $$
begin
    assert not exists (
        select 1 from workspace.wiki_page_get('sub-olive', 'budget') w where w.source <> 'wiki');
    assert (select count(*) from workspace.wiki_page_get('sub-olive', 'budget thread')) = 0;
end $$;
reset role;

-- 8. An owner cannot be removed while mail still names them.
do $$
begin
    assert pg_temp.raises(
        $q$delete from workspace.principals where handle = 'mona'$q$, '23503'),
        'a principal who owns documents must not be deleted out from under them';
end $$;

rollback;
