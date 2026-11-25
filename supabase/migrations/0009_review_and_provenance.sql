-- 0009_review_and_provenance.sql
--
-- GOLD layer -- human review, and the state that makes the loop terminate.
--
-- Three design points, each fixing a specific defect in the drafted design:
--
-- 1. PROVENANCE IS NOT ONE SCORE. Verified / fresh / authoritative are orthogonal
--    facts. Collapsing them into a single number makes "show me only human-
--    approved knowledge" -- the enterprise ask -- unanswerable separately from
--    "show me recent". The inputs are stored as columns; the ranking weight is
--    computed at query time, alongside the existing tier and age-decay terms.
--
-- 2. REJECTION MUST TERMINATE. Detection asks "changed, or never distilled?".
--    A rejected row has unchanged content and no accepted distillation, so it
--    looks new again on the next run -- forever. Rejections are therefore keyed to
--    the CONTENT HASH: this exact content was rejected, do not re-propose. If the
--    source changes the hash changes and it becomes eligible again, which is
--    correct.
--
-- 3. REJECTION IS NOT ONE VERB. "Reject" conflates three different faults: the
--    summary is weak (regenerate), the document does not belong in the index
--    (exclude), or the label is wrong (relabel). One verb cannot heal the right
--    thing, and would let a weak sentence permanently exclude a good document.

-- Review state on the document ----------------------------------------------

alter table workspace.documents
    add column if not exists review_status text not null default 'unreviewed',
    add column if not exists reviewed_at   timestamptz,
    add column if not exists reviewed_by   text,
    -- Whether the access label was set by rules or merely proposed by a model.
    -- A model may PROPOSE a domain; rules decide. A generation must never widen
    -- access, because domains gate who can read the row.
    add column if not exists label_source  text not null default 'rules';

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'documents_review_status_values'
    ) then
        alter table workspace.documents
            add constraint documents_review_status_values
            check (review_status in ('unreviewed', 'approved', 'rejected', 'excluded'));
    end if;

    if not exists (
        select 1 from pg_constraint where conname = 'documents_label_source_values'
    ) then
        alter table workspace.documents
            add constraint documents_label_source_values
            check (label_source in ('rules', 'model_proposed', 'human_confirmed'));
    end if;
end;
$$;

comment on column workspace.documents.review_status is
    'unreviewed (silver) | approved (gold) | rejected (summary refused) | excluded (never index)';
comment on column workspace.documents.label_source is
    'Who set `domains`. A model may propose; rules decide. Never let a generation widen access.';

create index if not exists documents_review_status
    on workspace.documents (review_status)
    where deleted_at is null;

-- Terminal rejections --------------------------------------------------------

create table if not exists workspace.distillation_rejections (
    source        text        not null,
    external_id   text        not null,
    -- Hash of the CONTENT that was rejected. New content = new hash = eligible again.
    content_hash  text        not null,
    action        text        not null,
    reason        text,
    rejected_at   timestamptz not null default now(),
    rejected_by   text,
    primary key (source, external_id, content_hash),
    constraint rejections_action_values
        check (action in ('regenerate', 'exclude', 'relabel'))
);

comment on table workspace.distillation_rejections is
    'Terminal state keyed to content hash, so a rejected row is not re-proposed forever.';
comment on column workspace.distillation_rejections.action is
    'regenerate = summary weak, retry. exclude = never index. relabel = domains wrong.';

-- Review batches -------------------------------------------------------------
-- The email is a notification; these tables are the control plane. Applying a
-- decision is keyed on (batch, item), so replaying a reply is idempotent.

create table if not exists workspace.review_batches (
    id           uuid primary key default gen_random_uuid(),
    channel      text        not null default 'email',
    recipient    text        not null,
    sent_at      timestamptz not null default now(),
    item_count   integer     not null default 0,
    -- Opaque token echoed in the email subject, used to match a reply to a batch
    -- without relying on threading headers.
    reply_token  text        not null unique,
    thread_id    text,
    replied_at   timestamptz,
    raw_reply    text,
    parse_status text        not null default 'awaiting',
    constraint review_batches_parse_values
        check (parse_status in ('awaiting', 'parsed', 'unparseable', 'expired'))
);

comment on column workspace.review_batches.parse_status is
    'unparseable replies are kept and re-queued, never guessed at.';

create table if not exists workspace.review_items (
    batch_id    uuid        not null references workspace.review_batches(id) on delete cascade,
    item_number integer     not null,
    document_id uuid        not null references workspace.documents(id) on delete cascade,
    decision    text,
    decided_at  timestamptz,
    applied_at  timestamptz,
    note        text,
    primary key (batch_id, item_number),
    constraint review_items_one_per_doc unique (batch_id, document_id),
    constraint review_items_decision_values
        check (decision is null or decision in
               ('approve', 'regenerate', 'exclude', 'relabel'))
);

comment on table workspace.review_items is
    'Numbered items so a reply can say "1 A, 2 R". applied_at makes replay idempotent.';

-- Access posture -------------------------------------------------------------

alter table workspace.distillation_rejections enable row level security;
alter table workspace.review_batches          enable row level security;
alter table workspace.review_items            enable row level security;

revoke all on workspace.distillation_rejections from anon, authenticated;
revoke all on workspace.review_batches          from anon, authenticated;
revoke all on workspace.review_items            from anon, authenticated;

grant select, insert, update, delete on workspace.distillation_rejections to service_role;
grant select, insert, update, delete on workspace.review_batches          to service_role;
grant select, insert, update, delete on workspace.review_items            to service_role;


-- ROLLBACK -------------------------------------------------------------------
-- drop table if exists workspace.review_items;
-- drop table if exists workspace.review_batches;
-- drop table if exists workspace.distillation_rejections;
-- alter table workspace.documents
--     drop column if exists review_status,
--     drop column if exists reviewed_at,
--     drop column if exists reviewed_by,
--     drop column if exists label_source;
