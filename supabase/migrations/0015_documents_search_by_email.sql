-- 0015_documents_search_by_email.sql
--
-- Adds the OAuth-keyed search RPC and a diagnostic count function.
--
-- IMPORTANT: The file is named "by_email" for historical order, but the primary
-- function is `documents_search_by_workos_user` — keyed on the WorkOS `sub`, NOT
-- on email. Email never reaches this function. See design decision 10 in the plan.
--
-- Why a new function rather than modifying documents_search:
--   documents_search is live and its anon-key path is called by the search edge
--   function. Modifying its body risks a regression in the working path. A new
--   function with the same body but a different resolver is the safe change.
--
-- Note: `matched_domains` is NOT in the return signature — it was incorrectly
-- asserted in an earlier draft of this plan and does not exist in the 0011
-- return type. Instead, `resolved_domain_count_for_workos_user` is added as a
-- companion function for diagnostics: a count, not names, consistent with the
-- logging posture (never log domain names).
--
-- search_path includes `public` — required because pgvector's `<=>` operator
-- lives in `public`. Omitting it causes "operator does not exist" errors.
-- This is a documented trap from migration 0006.
--
-- GRANT posture: revoke from public first, then grant to kb_engine only.
-- The kb_engine role is created in 0018_kb_engine_role.sql. The grants here
-- reference that role by name; the migration must be applied after 0018 is
-- created, OR the grants can be re-run after 0018. In practice these are applied
-- together in the same PR.

-- ── documents_search_by_workos_user ──────────────────────────────────────────

create or replace function workspace.documents_search_by_workos_user(
    p_workos_user_id text,
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
    -- OAuth path: resolve domains by WorkOS sub, not by token hash.
    v_domains := workspace.resolve_domains_for_workos_user(p_workos_user_id);

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

comment on function workspace.documents_search_by_workos_user(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) is
    'OAuth path: WorkOS sub -> resolved domains -> hybrid RRF search. '
    'Same body as documents_search; keyed on workos_user_id instead of token_hash. '
    'Fail-closed: unknown/inactive sub returns zero rows, not an error.';

revoke all on function workspace.documents_search_by_workos_user(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) from public;
-- grant to kb_engine is in 0018_kb_engine_role.sql

-- ── resolved_domain_count_for_workos_user ────────────────────────────────────
--
-- Returns the NUMBER of domains a WorkOS user resolves to, not the names.
-- Used by the search tool to produce a diagnosable "principal has no domain grants"
-- message when results are empty, without disclosing the grant list.

create or replace function workspace.resolved_domain_count_for_workos_user(p_sub text)
returns integer
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select coalesce(
        array_length(workspace.resolve_domains_for_workos_user(p_sub), 1),
        0
    );
$$;

comment on function workspace.resolved_domain_count_for_workos_user(text) is
    'Count of domains the WorkOS sub resolves to. Never returns domain names — '
    'a count is sufficient to distinguish "unknown identity" from "zero grants" '
    'without disclosing the grant list.';

revoke all on function workspace.resolved_domain_count_for_workos_user(text) from public;
-- grant to kb_engine is in 0018_kb_engine_role.sql


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.resolved_domain_count_for_workos_user(text);
-- drop function if exists workspace.documents_search_by_workos_user(
--     text, text, vector, integer, integer, integer,
--     double precision, double precision[], double precision, boolean);
