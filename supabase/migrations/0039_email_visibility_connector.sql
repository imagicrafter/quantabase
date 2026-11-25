-- 0039_email_visibility_connector.sql
--
-- The connector's two read functions now apply the visibility rule from 0038
-- (workspace._document_visible) instead of the bare topic check:
--
--   documents_search_by_oauth_subject   search and who_knows
--   document_get                        get_document
--
-- Both keep their signature, return type, SECURITY DEFINER posture, pinned
-- search_path and grants (kb_engine only). The bodies are the ones from 0020
-- with exactly two changes each:
--
--   1. `d.domains && v_domains` became a call to _document_visible(), which
--      gives the same answer for every row that is not email.
--   2. A caller with no topics is no longer turned away at the door, because
--      the owner of a thread sees it whatever their topics. An unknown or
--      inactive caller still gets nothing.
--
-- wiki_page_get is not touched: it reads `source = 'wiki'` rows only.

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
    v_principal  uuid;
    v_total_docs integer;
    v_avg_len    double precision;
    v_query      tsquery;
begin
    v_principal := workspace._principal_id_for_oauth_subject(p_oauth_subject);

    -- Unknown, inactive or absent caller: nothing. A known caller with no
    -- topics goes on: they may still own mail (see _document_visible).
    if v_principal is null then
        return;
    end if;

    v_domains := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);

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
          and workspace._document_visible(
              d.source, d.domains, d.owner_principal_id, d.review_status,
              v_domains, v_principal)
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
          and workspace._document_visible(
              d.source, d.domains, d.owner_principal_id, d.review_status,
              v_domains, v_principal)
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
    'Connector search: verified subject -> hybrid search over the rows that '
    'caller may see (workspace._document_visible). Unknown or inactive subject '
    'returns zero rows, not an error.';

revoke all on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) from public;
grant execute on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) to kb_engine;

-- ── document_get ─────────────────────────────────────────────────────────────

create or replace function workspace.document_get(
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
    v_domains   text[];
    v_principal uuid;
begin
    v_principal := workspace._principal_id_for_oauth_subject(p_oauth_subject);

    -- Unknown, inactive or absent caller: nothing. The tool layer reports this
    -- as not_found, the same as an id that does not exist, so a caller cannot
    -- tell "not yours" from "not there".
    if v_principal is null then
        return;
    end if;

    v_domains := coalesce(
        workspace.resolve_domains_for_oauth_subject(p_oauth_subject), array[]::text[]);

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
      and workspace._document_visible(
              d.source, d.domains, d.owner_principal_id, d.review_status,
              v_domains, v_principal);
end;
$$;

comment on function workspace.document_get(text, uuid) is
    'Fetch one document by id, if the caller may see it '
    '(workspace._document_visible). Not visible and not there both return '
    'nothing.';

revoke all on function workspace.document_get(text, uuid) from public;
grant execute on function workspace.document_get(text, uuid) to kb_engine;


-- VERIFY ------------------------------------------------------------------
-- supabase/tests/email_visibility_test.sql proves the rule for both functions
-- and that rows that are not email come back exactly as before.


-- ROLLBACK ------------------------------------------------------------------
-- Re-apply the two function bodies from 0020_generalise_oauth_subject.sql.
