-- 0006_documents_search_search_path_fix.sql
--
-- Fixes a defect in 0004: `set search_path = workspace, pg_temp` locked the
-- SECURITY DEFINER function down so tightly that pgvector's `<=>` operator became
-- unresolvable, because the `vector` extension is installed in `public` on this
-- project. Every call failed with:
--
--     operator does not exist: public.vector <=> public.vector
--
-- `public` is added to the search path. The hardening intent still holds: the path
-- is explicit and fixed, so a caller cannot prepend a schema of their own and
-- shadow the objects this function resolves. `workspace` stays first.
--
-- The existing workspace.hybrid_memory_search sets no search_path at all, which is
-- why it never hit this.
--
-- 0004 is left as applied. This migration supersedes its function body.

create or replace function workspace.documents_search(
    query_text      text,
    query_embedding vector(384),
    p_token_hash    text,
    match_count     integer            default 10,
    candidate_pool  integer            default 200,
    rrf_k           integer            default 60,
    half_life_days  double precision   default 365,
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
set search_path = workspace, public, pg_temp
as $fn$
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
            d.id                 as doc_id,
            d.source             as doc_source,
            d.external_id        as doc_external_id,
            d.parent_external_id as doc_parent,
            d.title              as doc_title,
            d.distillation       as doc_distillation,
            d.url                as doc_url,
            d.tier               as doc_tier,
            d.domains            as doc_domains,
            d.source_created_at  as doc_created,
            f.hit_vector,
            f.hit_keyword,
            (
                f.rrf
                * power(
                    0.5,
                    extract(epoch from (now() - coalesce(d.source_created_at, d.indexed_at)))
                        / 86400.0
                        / greatest(half_life_days, 1.0)
                  )
                * (1.0 + least(0.5, ts_rank_cd(d.tsv, v_query)::double precision))
                * coalesce(tier_weights[d.tier], 1.0)
            ) as score
        from fused f
        join workspace.documents d on d.id = f.doc_id
    ),
    collapsed as (
        select distinct on (w.doc_source, coalesce(w.doc_parent, w.doc_external_id))
            w.doc_id, w.doc_source, w.doc_external_id, w.doc_title,
            w.doc_distillation, w.doc_url, w.doc_tier, w.doc_domains,
            w.doc_created, w.hit_vector, w.hit_keyword, w.score
        from weighted w
        order by w.doc_source, coalesce(w.doc_parent, w.doc_external_id), w.score desc
    )
    select
        c.doc_id, c.doc_source, c.doc_external_id, c.doc_title,
        c.doc_distillation, c.doc_url, c.doc_tier, c.doc_domains,
        c.doc_created, c.hit_vector, c.hit_keyword, c.score
    from collapsed c
    order by c.score desc
    limit match_count;
end;
$fn$;

revoke all on function workspace.documents_search(
    text, vector, text, integer, integer, integer, double precision, double precision[]
) from anon, authenticated;

grant execute on function workspace.documents_search(
    text, vector, text, integer, integer, integer, double precision, double precision[]
) to service_role;


-- ROLLBACK -------------------------------------------------------------------
-- Re-apply 0004's function body (which is non-functional -- see the header).
