-- 0020_generalise_oauth_subject.sql
--
-- Generalises the OAuth identity column from `workos_user_id` to a provider-neutral
-- `oauth_subject` (+ `oauth_issuer`), and renames the six functions keyed on it, ahead
-- of KB-Engine's move from WorkOS AuthKit to Cloudflare Access Managed OAuth
-- (plans/2026-08-18-kb-engine-cloudflare-access-oauth.md).
--
-- WHY NOW: both principals (`owner`, `agent-embed`/`kb-engine`) have
-- workos_user_id IS NULL as of 2026-08-18 — nothing is pinned yet. Renaming after a
-- login would require un-pinning a live identity. This window closes at first login,
-- so the rename happens before any provider is wired up, not after.
--
-- ALSO FIXES the TOFU bootstrap bug recorded in the plan: `resolved_domain_count_for_*`
-- returned 0 (not null) for an unknown subject, so `engine/src/auth/principal.ts`'s
-- `if (domainCount !== null)` check treated "unknown" as "exists," returned early, and
-- the bootstrap-by-email path never ran. This migration makes the count function
-- return NULL for an unknown/unprovisioned subject and 0 for a known principal with
-- zero grants — the two outcomes this codebase is explicitly built never to collapse.
--
-- SCOPE: `workspace` schema only. Does not touch any other app's schema.
-- Does not touch the token path (`resolve_domains`, `documents_search`) at all.

-- ── Rename the identity column, add the issuer column ─────────────────────────

alter table workspace.principals
    rename column workos_user_id to oauth_subject;

comment on column workspace.principals.oauth_subject is
    'Verified OAuth subject (sub claim). The PRIMARY identifier for OAuth resolution. '
    'Null until the first successful OAuth login claims and pins it (TOFU). '
    'Once set, this is the sole authorization key; email becomes display-only. '
    'Provider-neutral: previously workos_user_id, generalised in 0020 ahead of the '
    'WorkOS -> Cloudflare Access transition.';

alter table workspace.principals
    add column if not exists oauth_issuer text;

comment on column workspace.principals.oauth_issuer is
    'OAuth issuer (iss claim) that pinned oauth_subject, e.g. the WorkOS AuthKit '
    'issuer or a Cloudflare Access team domain. Informational only — not yet used '
    'for authorization. Null for principals pinned before 2026-08-18.';

do $$
begin
    if exists (
        select 1 from pg_constraint
        where conrelid = 'workspace.principals'::regclass
          and conname  = 'principals_workos_user_id_key'
    ) then
        alter table workspace.principals
            rename constraint principals_workos_user_id_key to principals_oauth_subject_key;
    end if;
end $$;

-- ── resolve_domains_for_oauth_subject (was resolve_domains_for_workos_user) ───

create or replace function workspace.resolve_domains_for_oauth_subject(p_sub text)
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal workspace.principals%rowtype;
begin
    if p_sub is null or length(btrim(p_sub)) = 0 then
        return array[]::text[];
    end if;

    select * into v_principal
    from workspace.principals p
    where p.oauth_subject = p_sub
      and p.active is true;

    if not found then
        return array[]::text[];
    end if;

    return workspace._resolve_domains_for_principal(v_principal);
end;
$$;

comment on function workspace.resolve_domains_for_oauth_subject(text) is
    'OAuth subject -> granted domains. PRIMARY OAuth resolution path. '
    'Fail-closed: null, blank, unknown, and inactive all return array[]::text[]. '
    'Delegates to _resolve_domains_for_principal for the sensitivity rule. '
    'Provider-neutral successor to resolve_domains_for_workos_user (0020).';

revoke all on function workspace.resolve_domains_for_oauth_subject(text) from public;
grant execute on function workspace.resolve_domains_for_oauth_subject(text) to kb_engine;

-- ── resolve_domains_for_email — body updated to the renamed column ───────────
-- Function name is unchanged (not one of the six renamed functions); only the
-- column reference inside it moves from workos_user_id to oauth_subject.

create or replace function workspace.resolve_domains_for_email(p_email text)
returns text[]
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_principal workspace.principals%rowtype;
    v_normalised text;
begin
    if p_email is null or length(btrim(p_email)) = 0 then
        return array[]::text[];
    end if;

    v_normalised := lower(btrim(p_email));

    -- Bootstrap-only: only matches when oauth_subject is null (not yet claimed).
    -- Once pinned, this path returns empty — resolution is via oauth_subject only.
    select * into v_principal
    from workspace.principals p
    where lower(btrim(p.email)) = v_normalised
      and p.active is true
      and p.oauth_subject is null;

    if not found then
        return array[]::text[];
    end if;

    return workspace._resolve_domains_for_principal(v_principal);
end;
$$;

comment on function workspace.resolve_domains_for_email(text) is
    'Email -> granted domains. BOOTSTRAP ONLY — used when oauth_subject is null. '
    'Once pinned, returns empty (steady-state is resolve_domains_for_oauth_subject). '
    'Fail-closed: null, blank, unknown, inactive, already-claimed all return array[].';

-- ── documents_search_by_oauth_subject (was documents_search_by_workos_user) ──

create or replace function workspace.documents_search_by_oauth_subject(
    p_oauth_subject   text,
    query_text       text,
    query_embedding  vector(384),
    match_count      integer            default 10,
    candidate_pool   integer            default 200,
    rrf_k            integer            default 60,
    half_life_days   double precision   default 365,
    tier_weights     double precision[] default array[1.30, 1.15, 1.00, 0.85],
    approved_weight  double precision   default 1.25,
    require_approved boolean            default false
)
returns table (
    id                uuid,
    source            text,
    external_id       text,
    title             text,
    distillation      text,
    url               text,
    tier              smallint,
    domains           text[],
    review_status     text,
    source_created_at timestamptz,
    matched_vector    boolean,
    matched_keyword   boolean,
    fused_score       double precision
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $fn$
declare
    v_domains    text[];
    v_total_docs integer;
    v_avg_len    double precision;
    v_query      tsquery;
begin
    -- OAuth path: resolve domains by verified subject, not by token hash.
    v_domains := workspace.resolve_domains_for_oauth_subject(p_oauth_subject);

    if v_domains is null or cardinality(v_domains) = 0 then
        return;
    end if;

    select s.total_docs, s.avg_doc_length
    into v_total_docs, v_avg_len
    from workspace.documents_search_stats s
    where s.id = 1;

    if v_total_docs is null or v_total_docs = 0 then
        return;
    end if;

    v_query := websearch_to_tsquery('english', coalesce(query_text, ''));

    return query
    with vector_hits as (
        select
            d.id as doc_id,
            row_number() over (order by d.embedding <=> query_embedding) as rnk
        from workspace.documents d
        where d.deleted_at is null
          and d.embedding is not null
          and d.domains && v_domains
          and d.review_status not in ('rejected', 'excluded')
          and (not require_approved or d.review_status = 'approved')
        order by d.embedding <=> query_embedding
        limit candidate_pool
    ),
    keyword_hits as (
        select
            d.id as doc_id,
            row_number() over (order by sc.score desc) as rnk
        from workspace.documents d
        cross join lateral (
            select workspace.documents_bm25_score(
                d.tsv, v_query,
                coalesce(array_length(tsvector_to_array(d.tsv), 1), 1),
                v_total_docs, v_avg_len
            ) as score
        ) sc
        where d.deleted_at is null
          and d.tsv is not null
          and d.domains && v_domains
          and d.tsv @@ v_query
          and d.review_status not in ('rejected', 'excluded')
          and (not require_approved or d.review_status = 'approved')
        order by sc.score desc
        limit candidate_pool
    ),
    fused as (
        select
            coalesce(v.doc_id, k.doc_id) as doc_id,
            (v.doc_id is not null) as hit_vector,
            (k.doc_id is not null) as hit_keyword,
            coalesce(1.0::double precision / (rrf_k + v.rnk), 0.0)
          + coalesce(1.0::double precision / (rrf_k + k.rnk), 0.0) as rrf
        from vector_hits v
        full outer join keyword_hits k on k.doc_id = v.doc_id
    ),
    weighted as (
        select
            d.id                 as doc_id,
            d.source             as doc_source,
            d.external_id        as doc_external_id,
            d.parent_external_id as doc_parent,
            d.title              as doc_title,
            d.distillation       as doc_distillation,
            d.url                as doc_url,
            d.tier               as doc_tier,
            d.domains            as doc_domains,
            d.review_status      as doc_review,
            d.source_created_at  as doc_created,
            f.hit_vector,
            f.hit_keyword,
            (
                f.rrf
                * power(
                    0.5,
                    extract(epoch from (now() - coalesce(d.source_created_at, d.indexed_at)))
                        / 86400.0 / greatest(half_life_days, 1.0)
                  )
                * (1.0 + least(0.5, ts_rank_cd(d.tsv, v_query)::double precision))
                * coalesce(tier_weights[d.tier], 1.0)
                * case when d.review_status = 'approved' then approved_weight else 1.0 end
            ) as score
        from fused f
        join workspace.documents d on d.id = f.doc_id
    ),
    collapsed as (
        select distinct on (w.doc_source, coalesce(w.doc_parent, w.doc_external_id))
            w.doc_id, w.doc_source, w.doc_external_id, w.doc_title,
            w.doc_distillation, w.doc_url, w.doc_tier, w.doc_domains,
            w.doc_review, w.doc_created, w.hit_vector, w.hit_keyword, w.score
        from weighted w
        order by w.doc_source, coalesce(w.doc_parent, w.doc_external_id), w.score desc
    )
    select
        c.doc_id, c.doc_source, c.doc_external_id, c.doc_title,
        c.doc_distillation, c.doc_url, c.doc_tier, c.doc_domains,
        c.doc_review, c.doc_created, c.hit_vector, c.hit_keyword, c.score
    from collapsed c
    order by c.score desc
    limit match_count;
end;
$fn$;

comment on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) is
    'OAuth path: verified subject -> resolved domains -> hybrid RRF search. '
    'Same body as documents_search; keyed on oauth_subject instead of token_hash. '
    'Fail-closed: unknown/inactive subject returns zero rows, not an error. '
    'Provider-neutral successor to documents_search_by_workos_user (0020).';

revoke all on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) from public;
grant execute on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) to kb_engine;

-- ── resolved_domain_count_for_oauth_subject — fixes the bootstrap bug ─────────
--
-- Returns NULL for an unknown/unprovisioned subject and an integer (possibly 0)
-- for a known principal. Previously (resolved_domain_count_for_workos_user) this
-- coalesced straight to 0 for BOTH cases, which made
-- engine/src/auth/principal.ts's `if (domainCount !== null)` check treat "unknown"
-- as "exists" and skip the TOFU bootstrap path entirely. The two outcomes below
-- must never collapse into one — see engine/tests/auth/bootstrap-tofu.test.ts.

create or replace function workspace.resolved_domain_count_for_oauth_subject(p_sub text)
returns integer
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_exists boolean;
begin
    if p_sub is null or length(btrim(p_sub)) = 0 then
        return null;
    end if;

    select exists(
        select 1 from workspace.principals p
        where p.oauth_subject = p_sub
          and p.active is true
    ) into v_exists;

    if not v_exists then
        return null;
    end if;

    return coalesce(
        array_length(workspace.resolve_domains_for_oauth_subject(p_sub), 1),
        0
    );
end;
$$;

comment on function workspace.resolved_domain_count_for_oauth_subject(text) is
    'Count of domains the OAuth subject resolves to. NULL means unknown/unprovisioned '
    'subject (bootstrap should run); an integer (including 0) means a known principal '
    '(bootstrap must NOT run). These two outcomes must never collapse into one — doing '
    'so previously caused the TOFU bootstrap path to be skipped on first login.';

revoke all on function workspace.resolved_domain_count_for_oauth_subject(text) from public;
grant execute on function workspace.resolved_domain_count_for_oauth_subject(text) to kb_engine;

-- ── document_get / wiki_page_get — parameter renamed, body unchanged shape ───
-- Function names are unchanged (not among the four renamed functions); only the
-- parameter and the inner resolver call move to oauth_subject.
--
-- Postgres refuses `CREATE OR REPLACE` when only the parameter NAME changes
-- (42P13: cannot change name of input parameter) — verified against this project
-- 2026-08-18. Drop and recreate instead; this drops their kb_engine grants too,
-- which are restored explicitly below the two function bodies.

drop function if exists workspace.document_get(text, uuid);
drop function if exists workspace.wiki_page_get(text, text);

create function workspace.document_get(
    p_oauth_subject  text,
    p_id             uuid
)
returns table (
    id                uuid,
    source            text,
    external_id       text,
    title             text,
    body              text,
    distillation      text,
    url               text,
    author            text,
    tier              smallint,
    domains           text[],
    review_status     text,
    metadata          jsonb,
    source_created_at timestamptz,
    indexed_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_domains text[];
begin
    v_domains := workspace.resolve_domains_for_oauth_subject(p_oauth_subject);

    -- Zero domains means unknown or unprovisioned identity. Return nothing.
    -- The caller (engine tool layer) surfaces this as not_found, byte-identical
    -- to a truly nonexistent id, so the caller cannot distinguish domain exclusion
    -- from nonexistence.
    if v_domains is null or cardinality(v_domains) = 0 then
        return;
    end if;

    return query
    select
        d.id,
        d.source,
        d.external_id,
        d.title,
        d.body,
        d.distillation,
        d.url,
        d.author,
        d.tier,
        d.domains,
        d.review_status,
        d.metadata,
        d.source_created_at,
        d.indexed_at
    from workspace.documents d
    where d.id = p_id
      and d.deleted_at is null
      and d.review_status not in ('rejected', 'excluded')
      and d.domains && v_domains;
end;
$$;

comment on function workspace.document_get(text, uuid) is
    'Fetch a single document by id, access-controlled by oauth_subject. '
    'The domain intersection is in the WHERE clause — never filter in the caller. '
    'Out-of-domain and nonexistent return identically empty (tool maps both to not_found).';

-- ── wiki_page_get ─────────────────────────────────────────────────────────────

create function workspace.wiki_page_get(
    p_oauth_subject  text,
    p_title_or_path  text
)
returns table (
    id                uuid,
    source            text,
    external_id       text,
    title             text,
    body              text,
    distillation      text,
    url               text,
    author            text,
    tier              smallint,
    domains           text[],
    review_status     text,
    metadata          jsonb,
    source_created_at timestamptz,
    indexed_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = workspace, public, pg_temp
as $$
declare
    v_domains  text[];
    v_escaped  text;
    v_pattern  text;
begin
    if p_title_or_path is null or length(btrim(p_title_or_path)) = 0 then
        return;
    end if;

    v_domains := workspace.resolve_domains_for_oauth_subject(p_oauth_subject);

    if v_domains is null or cardinality(v_domains) = 0 then
        return;
    end if;

    -- Escape ILIKE metacharacters BEFORE building the pattern.
    -- An unescaped `%` or `_` in the caller-supplied title is a
    -- page-enumeration primitive: `get_wiki_page('%')` would return every page
    -- the principal can see. Escape them so they match literally.
    v_escaped := replace(replace(p_title_or_path, '\', '\\'), '%', '\%');
    v_escaped := replace(v_escaped, '_', '\_');
    v_pattern := '%' || v_escaped || '%';

    return query
    select
        d.id,
        d.source,
        d.external_id,
        d.title,
        d.body,
        d.distillation,
        d.url,
        d.author,
        d.tier,
        d.domains,
        d.review_status,
        d.metadata,
        d.source_created_at,
        d.indexed_at
    from workspace.documents d
    where d.source = 'wiki'
      and d.deleted_at is null
      and d.review_status not in ('rejected', 'excluded')
      and d.domains && v_domains
      and (
            d.title ilike v_pattern
         or d.external_id ilike v_pattern
      )
    order by
        -- Exact title match first, then partial
        case when lower(d.title) = lower(btrim(p_title_or_path)) then 0 else 1 end,
        d.tier asc,
        d.source_created_at desc nulls last
    limit 5;
end;
$$;

comment on function workspace.wiki_page_get(text, text) is
    'Fuzzy-fetch wiki documents by title or path, access-controlled by oauth_subject. '
    'ILIKE metacharacters (%, _) are escaped before use — prevents page enumeration. '
    'Out-of-domain documents never returned; domain intersection is in the WHERE clause.';

revoke all on function workspace.document_get(text, uuid) from public;
grant execute on function workspace.document_get(text, uuid) to kb_engine;

revoke all on function workspace.wiki_page_get(text, text) from public;
grant execute on function workspace.wiki_page_get(text, text) to kb_engine;

-- ── claim_oauth_subject (was claim_workos_user_id) ────────────────────────────

create or replace function workspace.claim_oauth_subject(
    p_email          text,
    p_oauth_subject  text
)
returns table (
    id           uuid,
    handle       text,
    display_name text,
    role         text,
    active       boolean
)
language plpgsql
volatile
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_normalised text;
begin
    if p_email is null or p_oauth_subject is null then
        return;
    end if;

    v_normalised := lower(btrim(p_email));

    -- Atomically claim: find a matching email with no oauth_subject, pin the sub.
    -- If another request already claimed this principal, this UPDATE matches zero
    -- rows and the SELECT below still finds it (via oauth_subject) for the return.
    update workspace.principals
    set oauth_subject = p_oauth_subject
    where lower(btrim(email)) = v_normalised
      and oauth_subject is null
      and active is true;

    -- Return the principal (whether we just claimed it or it was already claimed).
    return query
    select p.id, p.handle, p.display_name, p.role, p.active
    from workspace.principals p
    where (
            (lower(btrim(p.email)) = v_normalised and p.oauth_subject = p_oauth_subject)
         or p.oauth_subject = p_oauth_subject
      )
      and p.active is true
    limit 1;
end;
$$;

comment on function workspace.claim_oauth_subject(text, text) is
    'TOFU: atomically pin a verified OAuth subject to a principal matched by email. '
    'Called once per principal during first OAuth login. After this call, '
    'the principal is reachable by oauth_subject only. '
    'Provider-neutral successor to claim_workos_user_id (0020). Unknown email '
    '(no matching unclaimed principal) returns zero rows — the caller in '
    'principal.ts already treats this as "not provisioned," distinct from the '
    '"known, zero grants" case resolved via resolved_domain_count_for_oauth_subject.';

revoke all on function workspace.claim_oauth_subject(text, text) from public;
grant execute on function workspace.claim_oauth_subject(text, text) to kb_engine;

-- ── Drop the old WorkOS-named functions ───────────────────────────────────────

drop function if exists workspace.resolve_domains_for_workos_user(text);
drop function if exists workspace.documents_search_by_workos_user(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
);
drop function if exists workspace.resolved_domain_count_for_workos_user(text);
drop function if exists workspace.claim_workos_user_id(text, text);


-- ROLLBACK -------------------------------------------------------------------
-- (Only safe to run before any principal has oauth_subject pinned.)
-- alter table workspace.principals rename constraint principals_oauth_subject_key to principals_workos_user_id_key;
-- alter table workspace.principals rename column oauth_subject to workos_user_id;
-- alter table workspace.principals drop column if exists oauth_issuer;
-- drop function if exists workspace.claim_oauth_subject(text, text);
-- drop function if exists workspace.resolved_domain_count_for_oauth_subject(text);
-- drop function if exists workspace.documents_search_by_oauth_subject(
--     text, text, vector, integer, integer, integer,
--     double precision, double precision[], double precision, boolean);
-- drop function if exists workspace.resolve_domains_for_oauth_subject(text);
-- -- restore document_get / wiki_page_get / resolve_domains_for_email bodies from 0014/0017
-- -- restore *_for_workos_user functions from 0014/0015/0018
