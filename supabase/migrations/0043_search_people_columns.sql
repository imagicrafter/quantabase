-- 0043_search_people_columns.sql
--
-- who_knows needs to know who wrote a document and who took part in it. The
-- connector's search function did not return either, so who_knows always
-- answered with nobody.
--
-- documents_search_by_oauth_subject now returns two more columns, taken from
-- the SAME rows it already returned:
--
--   author        documents.author
--   participants  documents.metadata->'participants' when that is a list
--                 (at most 50 names per row), otherwise an empty list
--
-- Nothing else changes. The body is the one from 0039, character for
-- character, plus those two columns: the same arguments, the same visibility
-- rule (workspace._document_visible), the same ranking, SECURITY DEFINER, the
-- same pinned search_path, execute for kb_engine only. A person is only ever
-- named from a row the caller could already read with get_document.
--
-- A function's return type cannot be changed in place, so it is dropped and
-- made again here, in one transaction, and its grants are set again below.

drop function if exists workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
);

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
    fused_score       double precision,
    author            text,
    participants      text[]
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
            d.author             as doc_author,
            case when jsonb_typeof(d.metadata->'participants') = 'array'
                 then array(
                     select jsonb_array_elements_text(d.metadata->'participants')
                     limit 50)
                 else array[]::text[]
            end                  as doc_participants,
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
            w.doc_review, w.doc_created, w.hit_vector, w.hit_keyword, w.score,
            w.doc_author, w.doc_participants
        from weighted w
        order by w.doc_source, coalesce(w.doc_parent, w.doc_external_id), w.score desc
    )
    select
        c.doc_id, c.doc_source, c.doc_external_id, c.doc_title,
        c.doc_distillation, c.doc_url, c.doc_tier, c.doc_domains,
        c.doc_review, c.doc_created, c.hit_vector, c.hit_keyword, c.score,
        c.doc_author, c.doc_participants
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
    'returns zero rows, not an error. Also returns each row''s author and '
    'participants, for who_knows.';

revoke all on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) from public;
grant execute on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) to kb_engine;

revoke all on function workspace.documents_search_by_oauth_subject(
    text, text, vector, integer, integer, integer,
    double precision, double precision[], double precision, boolean
) from anon, authenticated;


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.documents_search_by_oauth_subject(
--     text, text, vector, integer, integer, integer,
--     double precision, double precision[], double precision, boolean);
-- (then re-run the definition from 0039_email_visibility_connector.sql)
