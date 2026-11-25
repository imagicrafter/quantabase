-- 0038_document_owner.sql
--
-- Email is the first source where a document belongs to one person: the owner
-- of the mailbox it was read from. This adds the owner to a document and the
-- one rule that decides who may see a row. The read functions that apply the
-- rule are replaced in 0039 (connector) and 0040 (token).
--
-- THE RULE (workspace._document_visible)
--
--   A row from Gmail (source = 'gmail') is visible to a caller when
--       the caller is its owner, or
--       it has an owner who is still an active person AND the caller holds
--       one of its topics AND it has been approved
--       (review_status = 'approved').
--   A Gmail row with NO owner is visible to nobody. Rows indexed before this
--   migration have none, so they drop out of every search at once; the next
--   run of the Gmail source gives a labelled thread its owner and takes the
--   rest out.
--   Mail whose owner has been switched off is visible to nobody either: the
--   person who shared it can no longer take it back, and the source can no
--   longer run for them, so it is hidden until an administrator names a new
--   owner in the config (which puts it back in review).
--
--   Every other row is visible exactly as before: the caller holds one of its
--   topics. The owner column stays null on those rows and is not consulted.
--
-- There is no way round it for an administrator: an administrator who does
-- not own a thread sees it on the same terms as anyone else.
--
-- The rule is one function, used by every read path. Never copy it.
--
-- Who writes the owner: the pullers (kb_ingest), which may already write any
-- column of a document. They resolve the mailbox owner's email to a principal
-- with principal_id_for_email() -- kb_ingest cannot read the people table.

alter table workspace.documents
    add column if not exists owner_principal_id uuid
        references workspace.principals(id) on delete restrict;

comment on column workspace.documents.owner_principal_id is
    'The person whose mailbox this row came from. Set on Gmail rows only. '
    'A Gmail row with no owner is visible to nobody.';

create index if not exists documents_owner_idx
    on workspace.documents (owner_principal_id)
    where owner_principal_id is not null;

-- ── The rule ─────────────────────────────────────────────────────────────────
--
-- Plain SQL, so the planner can fold it into the query. It is not SECURITY
-- DEFINER: it is only ever called from the SECURITY DEFINER read functions,
-- and runs with their rights. Anything unknown (a null owner, a null caller,
-- null topics, an owner who cannot be found) is "not visible".

create or replace function workspace._document_visible(
    p_source        text,
    p_domains       text[],
    p_owner         uuid,
    p_review_status text,
    p_granted       text[],
    p_principal     uuid
)
returns boolean
language sql
stable
as $$
    select coalesce(
        case
            when p_source = 'gmail' then
                p_owner is not null
                and p_principal is not null
                and (
                    p_owner = p_principal
                    or (
                        p_domains && p_granted
                        and p_review_status = 'approved'
                        and exists (
                            select 1 from workspace.principals o
                            where o.id = p_owner and o.active is true)
                    )
                )
            else p_domains && p_granted
        end,
        false);
$$;

comment on function workspace._document_visible(text, text[], uuid, text, text[], uuid) is
    'Internal: may this caller see this row? The one implementation of the '
    'visibility rule; every read function calls it. Unknown means no.';

revoke all on function workspace._document_visible(text, text[], uuid, text, text[], uuid)
    from public;
revoke all on function workspace._document_visible(text, text[], uuid, text, text[], uuid)
    from anon, authenticated;

-- ── Who is calling ───────────────────────────────────────────────────────────
--
-- The same lookups resolve_domains_for_oauth_subject() and resolve_domains()
-- make: an ACTIVE principal, or nothing.

create or replace function workspace._principal_id_for_oauth_subject(p_sub text)
returns uuid
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select p.id
    from workspace.principals p
    where p_sub is not null
      and length(btrim(p_sub)) > 0
      and p.oauth_subject = p_sub
      and p.active is true;
$$;

create or replace function workspace._principal_id_for_token_hash(p_token_hash text)
returns uuid
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select p.id
    from workspace.principals p
    where p_token_hash is not null
      and length(btrim(p_token_hash)) > 0
      and p.token_hash = p_token_hash
      and p.active is true;
$$;

revoke all on function workspace._principal_id_for_oauth_subject(text) from public;
revoke all on function workspace._principal_id_for_oauth_subject(text) from anon, authenticated;
revoke all on function workspace._principal_id_for_token_hash(text) from public;
revoke all on function workspace._principal_id_for_token_hash(text) from anon, authenticated;

-- ── principal_id_for_email (pullers) ─────────────────────────────────────────
--
-- The id of the ACTIVE person with this email, or null. The pullers use it to
-- turn the mailbox owner from the config into the owner of a row. It returns
-- an id and nothing else about the person.

create or replace function workspace.principal_id_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select (workspace._active_principal_by_email(p_email)).id;
$$;

comment on function workspace.principal_id_for_email(text) is
    'The id of the active person with this email, or null. For the pullers, '
    'to record whose mailbox a row came from.';

revoke all on function workspace.principal_id_for_email(text) from public;
revoke all on function workspace.principal_id_for_email(text) from anon, authenticated;
grant execute on function workspace.principal_id_for_email(text) to kb_ingest;


-- VERIFY ------------------------------------------------------------------
-- select count(*) from information_schema.role_table_grants
--  where grantee = 'kb_engine';                               -- expect 0
-- select has_function_privilege('kb_engine',
--   'workspace.principal_id_for_email(text)', 'execute');     -- expect false
-- select count(*) from workspace.documents
--  where source = 'gmail' and owner_principal_id is null
--    and deleted_at is null;      -- rows no one can see until the source runs


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply 0020 and 0011 first (the read functions call the helpers).
-- drop function if exists workspace.principal_id_for_email(text);
-- drop function if exists workspace._principal_id_for_token_hash(text);
-- drop function if exists workspace._principal_id_for_oauth_subject(text);
-- drop function if exists workspace._document_visible(text, text[], uuid, text, text[], uuid);
-- drop index if exists workspace.documents_owner_idx;
-- alter table workspace.documents drop column if exists owner_principal_id;
