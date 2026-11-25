-- 0024_restrictive_default_domain.sql
--
-- Adds `unclassified` -- the new ingest fall-through domain, sensitive and
-- granted to nobody by default. Plan Design Decision 5.
--
-- Today an unclassified page falls through to `general`, which is grantable
-- -- acceptable for the owner's own hand-tuned corpus, unacceptable pointed at a
-- client's mailbox. This inverts the failure from a leak to a miss: content
-- nobody classified is now invisible until reviewed and relabelled, not
-- readable by the first person given any grant.
--
-- Application-side changes (scripts/knowledge/config.py DEFAULT_DOMAIN,
-- DOMAINS, SENSITIVE_DOMAINS; taxonomy.py's fall-through comment) land in the
-- same commit as this migration -- verify_taxonomy() will fail loudly if the
-- two drift.
--
-- Deliberately NOT backfilled: the existing ~213 `general` rows were
-- classified under the old rule against a corpus whose keyword/directory
-- rules were hand-tuned. Relabelling them wholesale would hide them from
-- search with no review. This default applies to NEW content only.
--
-- APPLY WITH `apply_migration`, NEVER `execute_sql`. NOT YET APPLIED.

insert into workspace.domains (domain, label, description, sensitive)
values (
    'unclassified',
    'Unclassified',
    'Ingest fall-through. Granted to nobody by default; review and relabel.',
    true
);


-- VERIFY ------------------------------------------------------------------
-- select domain, sensitive from workspace.domains where domain = 'unclassified';
-- -- expect: sensitive = true
--
-- select workspace.resolve_domains_for_oauth_subject('<owner-sub>')
--        @> array['unclassified'];
-- -- expect: false -- an administrator's implicit grant must NOT include it
--
-- Then: cd scripts && ../.venv/bin/python -m knowledge.connector_contract_test --network
-- to confirm verify_taxonomy() still agrees with the database.


-- ROLLBACK ------------------------------------------------------------------
-- delete from workspace.domains where domain = 'unclassified';
