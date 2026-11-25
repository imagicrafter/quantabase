# Supabase migrations

Migration files for the `workspace` schema objects owned by **this** repository.

## Read this before applying anything

A Supabase project can hold more than this Engine. Every statement in these
files is confined to the Engine's own schema (`workspace` unless `KB_SCHEMA`
says otherwise), and one database holds one Engine.

The four-digit prefix is the order the files are applied in. It is not a
Supabase migration version; the Engine keeps its own record of what has run.

## Applying with `kbe`

`python -m kbe db migrate` applies every file here that has not run yet, in
filename order, each in its own transaction, and records it (with a checksum)
in the `kbe_migrations` table. `--dry-run` lists what would run. A database
that was built before the tool existed is marked first with
`python -m kbe db adopt --through NNNN`. See `scripts/kbe/README.md`.

`0000_prelude.sql` creates what the rest take for granted (the `workspace`
schema, pgvector, `workspace.set_updated_at()`), so the files apply to an
empty database.

## The schema name

Write every file for the schema `workspace`. A deployment that set `KB_SCHEMA`
gets the name changed as the file is applied (`scripts/kbe/schema_rewrite.py`);
with the default the file is applied exactly as written. The rename refuses
anything it cannot classify, so use only these forms:

- `workspace.thing` (also inside strings: `'workspace.t'::regclass`,
  `has_table_privilege(role, 'workspace.t', ...)`, dynamic SQL)
- `create schema ... workspace`, `grant ... on schema workspace`,
  `alter default privileges in schema workspace`, `comment on schema workspace`
- `set search_path = workspace, ...` on functions
- `'workspace'::regnamespace`, `table_schema = 'workspace'`,
  `to_regnamespace('workspace')`, `format('%I.%I', 'workspace', ...)` (every
  slot `%I`)

Do not use the bare word as a column, alias or value, do not put it in a
string as prose, and do not name a custom setting after it
(`set workspace.x`, `current_setting('workspace.x')`). Comments may say anything. `scripts/kbe/tests/test_schema_rewrite.py`
checks every file here on each run.

## Conventions

| Rule | Detail |
|---|---|
| **Numbering** | Four-digit zero-padded prefix, monotonic, no gaps: `0001_`, `0002_`, … |
| **Naming** | `NNNN_snake_case_description.sql` |
| **Scope** | One logical change per file. A table and the RPC that reads it are two files. |
| **Rollback** | Every migration ends with a `-- ROLLBACK` comment block containing the exact SQL to undo it. Not executed automatically — it exists so the undo path is never improvised. |
| **Idempotency** | Prefer `create ... if not exists` / `create or replace`. A migration should survive being applied twice. |
| **Application** | With `python -m kbe db migrate`, which records each file and its checksum in `kbe_migrations`. Never paste a file into a SQL editor: it would run without being recorded. |
| **Never edit an applied file** | `kbe db migrate` stops if an applied file's checksum has changed. A change is a new file. |

## Security defaults

Any new table in the `workspace` schema must, in the same migration:

1. `alter table ... enable row level security` — even when no policy is defined yet.
   RLS-on-with-no-policy denies all access through PostgREST while leaving
   `SECURITY DEFINER` functions working. This is deliberate: it fails closed.
2. `revoke all on ... from anon, authenticated` — the `workspace` schema's default
   ACL has previously exposed tables that were assumed private.

See `concepts/Supabase Schema Default ACL Exposure.md` and
`research/Supabase RLS Silent Failures.md` in the knowledge wiki for the incidents
that produced both rules.
