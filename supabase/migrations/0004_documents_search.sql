-- 0004_documents_search.sql
--
-- Hybrid retrieval over workspace.documents.
--
-- Two deliberate departures from the plan as drafted:
--
--   1. The signature takes `p_token_hash`, NOT `caller_domains text[]`. A caller
--      supplying its own domain list can supply every domain, which makes the
--      access model a suggestion. Domains resolve inside the database.
--
--   2. Rank fusion (RRF), not score blending. Cosine similarity and BM25 are on
--      incompatible scales; hybrid_memory_search normalises BM25 by the batch max,
--      which makes a result's score depend on its neighbours. RRF does not.
--
-- Every tunable is a named parameter with a stated default. Nothing is a magic
-- number buried in the body.

create or replace function workspace.documents_search(
    query_text      text,
    query_embedding vector(384),
    p_token_hash    text,
    match_count     integer          default 10,
    candidate_pool  integer          default 200,
    rrf_k           integer          default 60,
    half_life_days  double precision default 365,
    -- Indexed by tier: [1] verified, [2] curated, [3] distilled, [4] raw.
    tier_weights    double precision[] default array[1.30, 1.15, 1.00, 0.85]
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
    source_created_at timestamptz,
    matched_vector    boolean,
    matched_keyword   boolean,
    fused_score       double precision
)
language plpgsql
stable
security definer
set search_path = workspace, pg_temp
as $$
declare
    v_domains    text[];
    v_total_docs integer;
    v_avg_len    double precision;
    v_query      tsquery;
begin
    v_domains := workspace.resolve_domains(p_token_hash);

    -- Fail closed. An empty resolved set returns zero rows, never every row.
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
          and d.domains && v_domains          -- filter inside the sub-query
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
                d.tsv,
                v_query,
                coalesce(array_length(tsvector_to_array(d.tsv), 1), 1),
                v_total_docs,
                v_avg_len
            ) as score
        ) sc
        where d.deleted_at is null
          and d.tsv is not null
          and d.domains && v_domains          -- filter inside the sub-query
          and d.tsv @@ v_query
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
            d.id                as doc_id,
            d.source            as doc_source,
            d.external_id       as doc_external_id,
            d.parent_external_id as doc_parent,
            d.title             as doc_title,
            d.distillation      as doc_distillation,
            d.url               as doc_url,
            d.tier              as doc_tier,
            d.domains           as doc_domains,
            d.source_created_at as doc_created,
            f.hit_vector,
            f.hit_keyword,
            (
                f.rrf
                -- Age decay against the document's own date, falling back to
                -- when it was indexed.
                * power(
                    0.5,
                    extract(epoch from (now() - coalesce(d.source_created_at, d.indexed_at)))
                        / 86400.0
                        / greatest(half_life_days, 1.0)
                  )
                -- Small proximity bonus, capped so it cannot dominate fusion.
                * (1.0 + least(0.5, ts_rank_cd(d.tsv, v_query)::double precision))
                -- Curation outranks the raw material it was drawn from.
                * coalesce(tier_weights[d.tier], 1.0)
            ) as score
        from fused f
        join workspace.documents d on d.id = f.doc_id
    ),
    -- Collapse sections back to one hit per source document, keeping the best
    -- scoring member of each group.
    collapsed as (
        select distinct on (w.doc_source, coalesce(w.doc_parent, w.doc_external_id))
            w.doc_id,
            w.doc_source,
            w.doc_external_id,
            w.doc_title,
            w.doc_distillation,
            w.doc_url,
            w.doc_tier,
            w.doc_domains,
            w.doc_created,
            w.hit_vector,
            w.hit_keyword,
            w.score
        from weighted w
        order by
            w.doc_source,
            coalesce(w.doc_parent, w.doc_external_id),
            w.score desc
    )
    select
        c.doc_id,
        c.doc_source,
        c.doc_external_id,
        c.doc_title,
        c.doc_distillation,
        c.doc_url,
        c.doc_tier,
        c.doc_domains,
        c.doc_created,
        c.hit_vector,
        c.hit_keyword,
        c.score
    from collapsed c
    order by c.score desc
    limit match_count;
end;
$$;

comment on function workspace.documents_search is
    'Hybrid RRF retrieval over workspace.documents. Domains resolve from the token '
    'hash inside the function; callers never supply a domain list. An unresolved '
    'token returns zero rows.';

revoke all on function workspace.documents_search(
    text, vector, text, integer, integer, integer, double precision, double precision[]
) from anon, authenticated;


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.documents_search(
--     text, vector, text, integer, integer, integer, double precision, double precision[]
-- );
