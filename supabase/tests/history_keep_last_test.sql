-- history_keep_last_test.sql -- checks for migration 0061: page history
-- thinning always keeps the newest 10 versions of every page.
-- Run by apply_local.sh as a superuser. One transaction, rolled back.

begin;

insert into workspace.principals
    (handle, display_name, role, email, active, oauth_subject, token_hash) values
    ('hk-ann', 'Ann Owner', 'reader', 'hk-ann@example.com', true, 'sub-hk-ann', 'tok-hk-ann');

do $$
declare
    v_ann  uuid := (select id from workspace.principals where handle = 'hk-ann');
    v_old  uuid;
    v_mix  uuid;
    v_now  timestamptz := '2026-11-21T12:00:00Z';
    n      integer;
begin
    insert into workspace.pages (owner_principal_id, drawer, key, title, body, content_hash)
    values (v_ann, 'concepts', 'concept:hk-old', 'Old', 'x', 'hk-1') returning id into v_old;
    insert into workspace.pages (owner_principal_id, drawer, key, title, body, content_hash)
    values (v_ann, 'concepts', 'concept:hk-mix', 'Mix', 'x', 'hk-2') returning id into v_mix;
    delete from workspace.page_history where page_id in (v_old, v_mix);

    -- 15 versions on one day two years ago: thinning alone would keep one.
    insert into workspace.page_history (page_id, content_hash, snapshot, saved_at)
    select v_old, 'o' || g, '{}'::jsonb, v_now - interval '730 days' + g * interval '1 minute'
    from generate_series(1, 15) g;

    -- 12 versions, one per day, 100 to 111 days ago: day buckets differ, all would stay
    -- anyway; plus 5 more on one old month to be thinned beyond the newest 10.
    insert into workspace.page_history (page_id, content_hash, snapshot, saved_at)
    select v_mix, 'm' || g, '{}'::jsonb, v_now - interval '900 days' + g * interval '1 hour'
    from generate_series(1, 5) g;
    insert into workspace.page_history (page_id, content_hash, snapshot, saved_at)
    select v_mix, 'd' || g, '{}'::jsonb, v_now - (100 + g) * interval '1 day'
    from generate_series(1, 12) g;

    n := workspace.page_history_prune(v_now);

    assert (select count(*) from workspace.page_history where page_id = v_old) = 10,
        format('old page keeps its newest 10, has %s',
               (select count(*) from workspace.page_history where page_id = v_old));
    assert exists (select 1 from workspace.page_history where page_id = v_old and content_hash = 'o15'), 'newest kept';
    assert not exists (select 1 from workspace.page_history where page_id = v_old and content_hash = 'o5'), 'older thinned';

    -- Mix: 12 day-versions stay (each its own day, and newest 10); the 5 in
    -- one old month thin to one.
    assert (select count(*) from workspace.page_history where page_id = v_mix) = 13,
        format('mix has %s', (select count(*) from workspace.page_history where page_id = v_mix));
    assert exists (select 1 from workspace.page_history where page_id = v_mix and content_hash = 'm5');

    assert workspace.page_history_prune(v_now) = 0, 'second run removes nothing';
end $$;

rollback;
