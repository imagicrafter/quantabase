-- 0079_page_import_key_only.sql
--
-- `kbe pages import` dropped recurring meetings. A weekly meeting has the
-- same title every week but its own meeting id (meeting:01ab..., then
-- meeting:01cd...), or, without an id, its own date-slug key
-- (meeting:2025-06-10-x, then meeting:2025-06-11-x). page_import (0078)
-- matched the second to the first by name and saved nothing: "matched
-- <file>: meeting:<B> is your page meeting:<A> (name)".
--
-- page_import learns one more flag:
--
--   p_page.key_only = true   look for the page's key only, never another
--                            page's name, alias, address or domain. The CLI
--                            sets it for every drawer whose template key
--                            rule is `source_id` (meetings), read from
--                            engine/templates/entities. A key the person
--                            holds still comes back as "exists" and is
--                            never overwritten.
--
-- Without the flag nothing changes: people still match by email and name,
-- organisations by domain and name. Like `restore`, the flag is removed
-- before the save, and every answer now says `key_only` (true or false) so
-- the CLI can tell this database knows the flag before it files a meeting.
-- Same signature; page_import is still granted to no API role.
-- (The curator does not use page_import, and never name-matches a page with
-- a source_id key: quality.ts hasStrongKey.)

create or replace function workspace.page_import(p_owner_email text, p_page jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_owner    workspace.principals%rowtype := workspace._active_principal_by_email(p_owner_email);
    v_key      text := lower(btrim(coalesce(p_page->>'key', '')));
    v_drawer   text := btrim(coalesce(p_page->>'drawer', ''));
    v_created  timestamptz;
    v_updated  timestamptz;
    v_restore  boolean := coalesce(p_page->'restore' = 'true'::jsonb, false);
    v_key_only boolean := coalesce(p_page->'key_only' = 'true'::jsonb, false);
    v_page     jsonb := p_page - 'created' - 'updated' - 'attendees' - 'restore' - 'key_only';
    v_linked   text[] := array[]::text[];
    v_kept     text[] := array[]::text[];
    v_related  text[];
    v_fields   jsonb;
    v_attendee text;
    v_hit      text;
    v_ids      text[];
    v_names    text[];
    v_allowed  text[];
    v_match    record;
    v_saved    record;
begin
    if v_owner.id is null then
        raise exception 'no active person with that email' using errcode = '22023';
    end if;

    begin
        v_created := nullif(btrim(coalesce(p_page->>'created', '')), '')::timestamptz;
        v_updated := nullif(btrim(coalesce(p_page->>'updated', '')), '')::timestamptz;
    exception when others then
        raise exception 'created and updated must be dates' using errcode = '22023';
    end;
    v_created := coalesce(v_created, v_updated);
    v_updated := coalesce(v_updated, v_created);
    if v_updated > now() then
        raise exception 'created and updated cannot be in the future' using errcode = '22023';
    end if;
    if v_created > v_updated then
        raise exception 'created cannot be later than updated' using errcode = '22023';
    end if;
    if p_page ? 'attendees' and jsonb_typeof(p_page->'attendees') <> 'array' then
        raise exception 'attendees must be a list' using errcode = '22023';
    end if;

    if exists (select 1 from workspace.pages p
               where p.owner_principal_id = v_owner.id and p.key = v_key and p.deleted_at is null) then
        return jsonb_build_object('status', 'exists', 'key', v_key, 'restore', v_restore,
                                  'key_only', v_key_only);
    end if;
    v_ids := workspace._page_identities(coalesce(p_page->'fields', '{}'::jsonb)) || v_key;
    v_names := workspace._page_names(p_page->>'title',
                                     workspace._jsonb_lower_list(p_page->'aliases'), v_key);
    -- A restore looks for the key only: a backup page IS that page, and two
    -- of the owner's pages may share a name ("Weekly sync"). So does a
    -- key-only page (0079): a meeting is the same meeting only under the
    -- same key (meeting id, or date-slug key), never by title.
    if not v_restore and not v_key_only then
        select p.key,
               case when (workspace._page_identities(p.fields) || p.key) && v_ids then 'email or domain'
                    else 'name' end as how
          into v_match
        from workspace.pages p
        where p.owner_principal_id = v_owner.id and p.deleted_at is null and p.drawer = v_drawer
          and ((workspace._page_identities(p.fields) || p.key) && v_ids
               or workspace._page_names(p.title, p.aliases, p.key) && v_names)
        order by case when (workspace._page_identities(p.fields) || p.key) && v_ids then 0 else 1 end, p.updated_at desc
        limit 1;
        if v_match.key is not null then
            return jsonb_build_object('status', 'matched', 'key', v_match.key, 'how', v_match.how, 'proposed', v_key,
                                      'restore', false, 'key_only', false);
        end if;
    end if;

    if jsonb_typeof(p_page->'attendees') = 'array' then
        for v_attendee in
            select btrim(x) from jsonb_array_elements_text(p_page->'attendees') x
            where length(btrim(x)) between 1 and 300
        loop
            v_hit := workspace._import_attendee_key(v_owner.id, v_attendee);
            if v_hit is not null and v_hit <> v_key then
                if not (v_hit = any (v_linked)) then
                    v_linked := v_linked || v_hit;
                end if;
            elsif not (v_attendee = any (v_kept)) then
                v_kept := v_kept || v_attendee;
            end if;
        end loop;
        v_related := workspace._jsonb_text_array(p_page->'related', 'related');
        v_related := v_related || array(select k from unnest(v_linked) k where not (k = any (v_related)));
        v_fields := coalesce(nullif(p_page->'fields', 'null'::jsonb), '{}'::jsonb);
        if cardinality(v_kept) > 0 then
            v_fields := v_fields || jsonb_build_object('attendees', to_jsonb(v_kept));
        end if;
        v_page := v_page || jsonb_build_object('related', to_jsonb(v_related), 'fields', v_fields);
    end if;

    v_allowed := array(select g.domain from workspace.access_grants g where g.principal_id = v_owner.id);
    select * into v_saved from workspace._page_save_as(v_owner.id, v_allowed, v_page, null);

    if v_created is not null then
        update workspace.pages p set created_at = v_created, updated_at = v_updated
        where p.id = v_saved.id;
        update workspace.page_history h set saved_at = v_updated
        where h.page_id = v_saved.id;
    end if;

    return jsonb_build_object('status', 'created', 'key', v_saved.key, 'id', v_saved.id,
                              'linked', to_jsonb(v_linked), 'kept', to_jsonb(v_kept),
                              'restore', v_restore, 'key_only', v_key_only);
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function workspace.page_import(text, jsonb) from public;
revoke all on function workspace.page_import(text, jsonb) from anon, authenticated;


-- VERIFY ------------------------------------------------------------------
-- select workspace.page_import('nobody@example.com', '{}'::jsonb);  -- error: no active person
-- select has_function_privilege('kb_engine', 'workspace.page_import(text, jsonb)', 'execute');  -- f


-- ROLLBACK ------------------------------------------------------------------
-- Re-run the 0078 page_import definition. (A CLI that sends key_only then
-- stops before filing a meeting, so no meeting is matched by name.)
