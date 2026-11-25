-- 0048_page_links.sql
--
-- Links between pages, keyed on the entity key (never on a page id or a
-- title), so a rename or a second person's page on the same key breaks
-- nothing.
--
-- page_save (0051) rewrites a page's rows on every content change from:
--   related    the header's `related` list
--   wikilink   [[links]] in the body
--   tag        the header's tags (they only lead somewhere when a page has
--              that key)
--   entity     named entities; written by the curator (Step C)
--
-- Read through page_related (0050), which applies the page access rule to
-- both ends. Backlinks come from the same table (target_key index).

create table if not exists workspace.page_links (
    page_id     uuid not null references workspace.pages(id) on delete cascade,
    target_key  text not null,
    reason      text not null,
    primary key (page_id, target_key, reason),
    constraint page_links_reason_values
        check (reason in ('related', 'wikilink', 'tag', 'entity')),
    constraint page_links_target_key_shape
        check (target_key = lower(target_key) and length(target_key) between 1 and 200)
);

comment on table workspace.page_links is
    'One row per link from a page to an entity key. Rewritten on every save.';

create index if not exists page_links_target_idx on workspace.page_links (target_key);

alter table workspace.page_links enable row level security;
revoke all on workspace.page_links from public;
revoke all on workspace.page_links from anon, authenticated;


-- VERIFY ------------------------------------------------------------------
-- select has_table_privilege('kb_engine', 'workspace.page_links', 'select');  -- f


-- ROLLBACK ------------------------------------------------------------------
-- drop table if exists workspace.page_links;
