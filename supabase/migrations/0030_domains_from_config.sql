-- 0030_domains_from_config.sql
--
-- Topics ("domains") come from the Engine config, not from seed rows.
-- workspace.domains_apply() makes workspace.domains match the config's list:
--
--   * adds new topics and updates the label on existing ones. An existing
--     topic may become sensitive, but NEVER the reverse: unlocking a sensitive
--     topic would show it to every administrator at once, so a config (which
--     the pullers' role may apply, and where leaving out `sensitive: true` is
--     an easy mistake) is refused. An administrator unlocks a topic by hand;
--   * removes a topic that is no longer listed -- but REFUSES (raises, changes
--     nothing) while any document still carries it or anyone is still granted
--     it. Retag the documents and remove the grants first;
--   * keeps `unclassified`: it always exists, is always sensitive, may not be
--     declared in a config, and is granted to the owner and nobody else.
--
-- The owner is the principal whose email is engine.owner.email in the applied
-- config (workspace.engine_settings, 0029). Called by engine_config_apply();
-- only service_role may call it directly.

create or replace function workspace.domains_apply(p_domains jsonb)
returns integer
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_item     jsonb;
    v_id       text;
    v_locked   boolean;
    v_ids      text[] := array[]::text[];
    v_stale    text;
    v_owner_id uuid;
begin
    if p_domains is null or jsonb_typeof(p_domains) <> 'array' then
        raise exception 'domains must be a list' using errcode = '22023';
    end if;

    for v_item in select * from jsonb_array_elements(p_domains) loop
        v_id := v_item->>'id';
        if v_id is null or v_id !~ '^[a-z][a-z0-9-]*$' then
            raise exception 'topic id % is not valid', coalesce(v_id, '(missing)')
                using errcode = '22023';
        end if;
        if v_id = 'unclassified' then
            raise exception '"unclassified" is reserved and may not be declared'
                using errcode = '22023';
        end if;
        if v_id = any (v_ids) then
            raise exception 'topic % is declared twice', v_id using errcode = '22023';
        end if;
        if coalesce(btrim(v_item->>'label'), '') = '' then
            raise exception 'topic % needs a label', v_id using errcode = '22023';
        end if;
        v_ids := v_ids || v_id;
        v_locked := coalesce((v_item->>'sensitive')::boolean, false);

        if not v_locked and exists (
            select 1 from workspace.domains d where d.domain = v_id and d.sensitive
        ) then
            raise exception
                'topic % is sensitive; a config cannot unlock it. '
                'Keep "sensitive: true", or have an administrator unlock it', v_id
                using errcode = '42501';
        end if;

        insert into workspace.domains (domain, label, sensitive)
        values (v_id, v_item->>'label', v_locked)
        on conflict (domain) do update
            set label = excluded.label,
                sensitive = excluded.sensitive;
    end loop;

    -- Refuse to drop a topic that is still in use.
    for v_stale in
        select d.domain from workspace.domains d
        where d.domain <> 'unclassified' and d.domain <> all (v_ids)
        order by d.domain
    loop
        if exists (select 1 from workspace.documents doc where v_stale = any (doc.domains)) then
            raise exception 'topic % still has documents; retag them before removing it', v_stale
                using errcode = '23503';
        end if;
        if exists (select 1 from workspace.access_grants g where g.domain = v_stale) then
            raise exception 'topic % is still granted to someone; remove the grants first', v_stale
                using errcode = '23503';
        end if;
        delete from workspace.domains where domain = v_stale;
    end loop;

    insert into workspace.domains (domain, label, description, sensitive)
    values ('unclassified', 'Unclassified',
            'Items with no topic tag. Only the owner can see them.', true)
    on conflict (domain) do update set sensitive = true;

    select p.id into v_owner_id
    from workspace.principals p
    join workspace.engine_settings s on s.id
    where lower(btrim(p.email)) = lower(btrim(s.config #>> '{engine,owner,email}'));

    delete from workspace.access_grants g
    where g.domain = 'unclassified'
      and g.principal_id is distinct from v_owner_id;

    if v_owner_id is not null then
        insert into workspace.access_grants (principal_id, domain, granted_by)
        values (v_owner_id, 'unclassified', 'engine_config')
        on conflict (principal_id, domain) do nothing;
    end if;

    return coalesce(array_length(v_ids, 1), 0);
end;
$$;

comment on function workspace.domains_apply(jsonb) is
    'Make workspace.domains match the config. Refuses to remove a topic that '
    'still has documents or grants, or to unlock a sensitive one. Keeps '
    'unclassified sensitive and owner-only.';

revoke all on function workspace.domains_apply(jsonb) from public;
grant execute on function workspace.domains_apply(jsonb) to service_role;


-- VERIFY ------------------------------------------------------------------
-- select domain, sensitive from workspace.domains order by domain;
-- select p.email from workspace.access_grants g
--   join workspace.principals p on p.id = g.principal_id
--  where g.domain = 'unclassified';                  -- expect the owner only


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.domains_apply(jsonb);
