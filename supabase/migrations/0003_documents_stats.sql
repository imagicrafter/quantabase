-- 0003_documents_stats.sql
--
-- BM25 support for workspace.documents.
--
-- These are SEPARATE objects from memory_search_stats / memory_term_stats /
-- refresh_memory_term_stats / bm25_score. Reusing those would have two indexers
-- writing the same total_docs and avg_doc_length rows, silently degrading BM25
-- for whichever store ran second. workspace.bm25_score also hardcodes a read of
-- workspace.memory_term_stats, so it cannot be reused here at all.
--
-- Applied BEFORE the retrieval RPC because the RPC reads these objects.
-- (This swaps the numbering the plan proposed -- plan 0004 -- for dependency order.)

create table if not exists workspace.documents_search_stats (
    id             smallint primary key default 1,
    total_docs     integer          not null default 0,
    avg_doc_length double precision not null default 0,
    updated_at     timestamptz      not null default now(),
    constraint documents_search_stats_singleton check (id = 1)
);

create table if not exists workspace.documents_term_stats (
    word   text primary key,
    ndoc   integer not null,
    nentry integer not null
);

create index if not exists documents_term_stats_word
    on workspace.documents_term_stats (word);

-- Refresh -------------------------------------------------------------------

create or replace function workspace.refresh_documents_term_stats()
returns void
language plpgsql
security definer
set search_path = workspace, pg_temp
as $$
begin
    truncate workspace.documents_term_stats;
    insert into workspace.documents_term_stats (word, ndoc, nentry)
    select word, ndoc, nentry
    from ts_stat(
        'select tsv from workspace.documents where deleted_at is null and tsv is not null'
    );

    insert into workspace.documents_search_stats (id, total_docs, avg_doc_length, updated_at)
    select
        1,
        count(*)::integer,
        coalesce(avg(array_length(tsvector_to_array(d.tsv), 1)), 1)::double precision,
        now()
    from workspace.documents d
    where d.deleted_at is null
      and d.tsv is not null
    on conflict (id) do update set
        total_docs     = excluded.total_docs,
        avg_doc_length = excluded.avg_doc_length,
        updated_at     = excluded.updated_at;
end;
$$;

comment on function workspace.refresh_documents_term_stats() is
    'Rebuilds BM25 stats for workspace.documents. Does not touch memory_chunks stats.';

-- Scoring -------------------------------------------------------------------
-- Mirrors workspace.bm25_score, reading documents_term_stats instead of
-- memory_term_stats. Kept as a separate function rather than parameterising the
-- original, so the existing memory_chunks path is not modified at all.

create or replace function workspace.documents_bm25_score(
    doc_tsv         tsvector,
    query_tsquery   tsquery,
    doc_length      integer,
    total_docs      integer,
    avg_doc_length  double precision,
    k1              double precision default 1.2,
    b               double precision default 0.75
)
returns double precision
language plpgsql
immutable
as $$
declare
    score    double precision := 0;
    term_rec record;
    tf       integer;
    df       integer;
    idf      double precision;
    tf_norm  double precision;
begin
    for term_rec in
        select lexeme, positions
        from unnest(doc_tsv) as t(lexeme, positions, weights)
        where lexeme = any(
            select lexeme from unnest(query_tsquery::text::tsvector) as q(lexeme, positions, weights)
        )
    loop
        tf := array_length(term_rec.positions, 1);

        select coalesce(dts.ndoc, 1) into df
        from workspace.documents_term_stats dts
        where dts.word = term_rec.lexeme;

        if df is null then df := 1; end if;

        idf := ln((total_docs - df + 0.5) / (df + 0.5) + 1);
        tf_norm := (tf * (k1 + 1))
                 / (tf + k1 * (1 - b + b * doc_length / greatest(avg_doc_length, 1)));

        score := score + idf * tf_norm;
    end loop;

    return score;
end;
$$;

revoke all on workspace.documents_search_stats from anon, authenticated;
revoke all on workspace.documents_term_stats   from anon, authenticated;

alter table workspace.documents_search_stats enable row level security;
alter table workspace.documents_term_stats   enable row level security;


-- ROLLBACK -------------------------------------------------------------------
-- drop function if exists workspace.documents_bm25_score(tsvector, tsquery, integer, integer, double precision, double precision, double precision);
-- drop function if exists workspace.refresh_documents_term_stats();
-- drop table if exists workspace.documents_term_stats;
-- drop table if exists workspace.documents_search_stats;
