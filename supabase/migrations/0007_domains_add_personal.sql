-- 0007_domains_add_personal.sql
--
-- Historical. This migration once added a sensitive topic for private,
-- non-commercial pages, after an audit found such pages sitting in a topic that
-- any reader could be granted.
--
-- It now does nothing: topics are no longer seeded by migrations. Each Engine
-- declares its own in its config, including which are sensitive
-- (workspace.domains_apply, migration 0030). The file is kept so the numbering
-- has no gap.

select 1;


-- ROLLBACK -------------------------------------------------------------------
-- (nothing to undo)
