-- 0031_tag_provenance.sql
--
-- Topics ("domains") are now decided only by tags a person can see at the
-- source (scripts/knowledge/tag_resolver.py). This records, on every row, HOW
-- its topics were decided, so untagged and mistagged items can be counted and
-- listed instead of guessed at.
--
--   tag_source    which level of the source carried the tag:
--                   content         a tag on the item itself
--                   container       a tag on its folder / channel
--                   source_default  the source's default topic in the config
--                   default         nothing matched -> `unclassified`
--                 NULL means the row was written before this migration.
--   tag_signals   what was read there: the topic ids that matched, or
--                 'unknown_tag' plus 'unknown_tag:<text>' for a tag naming a
--                 topic the config does not declare.
--
-- Both columns are nullable and there is no backfill: the next run of each
-- source fills them in. Apply this BEFORE deploying pullers that write them.
--
-- tagging_health(email) returns the counts for the status page. It follows
-- engine_status (0027/0028): SECURITY DEFINER, pinned search_path, no table
-- grant for kb_engine, and it refuses unless the email belongs to an active
-- administrator. Only whole documents are counted (section rows repeat their
-- page), and only live ones.

alter table workspace.documents
    add column if not exists tag_source  text,
    add column if not exists tag_signals text[];

comment on column workspace.documents.tag_source is
    'How the topics were decided: content | container | source_default | default. '
    'Null on rows written before 0031.';
comment on column workspace.documents.tag_signals is
    'What the tag resolver read: matched topic ids, or unknown_tag markers.';

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'documents_tag_source_values'
          and conrelid = 'workspace.documents'::regclass
    ) then
        alter table workspace.documents
            add constraint documents_tag_source_values
            check (tag_source is null
                   or tag_source in ('content', 'container', 'source_default', 'default'));
    end if;
end $$;

-- Makes "how many untagged per source" (and every other count by tag_source)
-- cheap: the planner answers those from this index. The unknown-tag count
-- also reads tag_signals from the table for the rows the index selects.
create index if not exists documents_tag_source
    on workspace.documents (source, tag_source)
    where deleted_at is null and parent_external_id is null;

-- ── tagging_health ───────────────────────────────────────────────────────────

create or replace function workspace.tagging_health(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_admin boolean;
begin
    select exists (
        select 1
        from workspace.principals
        where lower(email) = lower(p_email)
          and active
          and role = 'administrator'
    ) into v_admin;

    if p_email is null or not coalesce(v_admin, false) then
        raise exception 'forbidden' using errcode = '42501';
    end if;

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'source', s.source,
            'total', s.total,
            'by_tag_source', jsonb_build_object(
                'content', s.by_content,
                'container', s.by_container,
                'source_default', s.by_source_default,
                'default', s.untagged,
                'not_recorded', s.not_recorded
            ),
            'untagged', s.untagged,
            'unknown_tag', s.unknown_tag
        ) order by s.source)
        from (
            select d.source,
                   count(*) as total,
                   count(*) filter (where d.tag_source = 'content') as by_content,
                   count(*) filter (where d.tag_source = 'container') as by_container,
                   count(*) filter (where d.tag_source = 'source_default') as by_source_default,
                   count(*) filter (where d.tag_source = 'default') as untagged,
                   count(*) filter (where d.tag_source is null) as not_recorded,
                   count(*) filter (
                       where d.tag_signals @> array['unknown_tag']
                   ) as unknown_tag
            from workspace.documents d
            where d.deleted_at is null
              and d.parent_external_id is null
            group by d.source
        ) s
    ), '[]'::jsonb);
end;
$$;

comment on function workspace.tagging_health(text) is
    'Per source: live documents by tag_source, untagged, and unknown-tag counts. '
    'Administrators only (raises 42501 otherwise).';

revoke all on function workspace.tagging_health(text) from public;
grant execute on function workspace.tagging_health(text) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_engine';                               -- expect 0
-- select has_function_privilege('anon',
--   'workspace.tagging_health(text)', 'execute');             -- expect false
-- select workspace.tagging_health('<an administrator email>');


-- ROLLBACK ------------------------------------------------------------------
-- drop function if exists workspace.tagging_health(text);
-- drop index if exists workspace.documents_tag_source;
-- alter table workspace.documents drop constraint if exists documents_tag_source_values;
-- alter table workspace.documents drop column if exists tag_signals;
-- alter table workspace.documents drop column if exists tag_source;
