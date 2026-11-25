/**
 * The Postgres schema that holds the knowledge index (KB_SCHEMA).
 *
 * The same rule lives in scripts/knowledge/kb_schema.py for the jobs and the
 * `kbe` CLI, and in the embed function. Keep them in step: a name one side accepts and the other
 * refuses would leave half a deployment looking at the wrong place.
 */

export const DEFAULT_KB_SCHEMA = "workspace";

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED_PREFIX = "pg_";
const RESERVED: ReadonlySet<string> = new Set([
  "public",
  "auth",
  "storage",
  "extensions",
  "graphql",
  "graphql_public",
  "realtime",
  "vault",
  "pgsodium",
  "supabase_migrations",
  "information_schema",
]);

// PostgreSQL's reserved key words. The same fixed list as
// scripts/knowledge/kb_schema.py and the embed function; a test compares them.
const SQL_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "all", "analyse", "analyze", "and", "any", "array",
  "as", "asc", "asymmetric", "authorization", "binary", "both",
  "case", "cast", "check", "collate", "collation", "column",
  "concurrently", "constraint", "create", "cross", "current_catalog", "current_date",
  "current_role", "current_schema", "current_time", "current_timestamp", "current_user", "default",
  "deferrable", "desc", "distinct", "do", "else", "end",
  "except", "false", "fetch", "for", "foreign", "freeze",
  "from", "full", "grant", "group", "having", "ilike",
  "in", "initially", "inner", "intersect", "into", "is",
  "isnull", "join", "lateral", "leading", "left", "like",
  "limit", "localtime", "localtimestamp", "natural", "not", "notnull",
  "null", "offset", "on", "only", "or", "order",
  "outer", "overlaps", "placing", "primary", "references", "returning",
  "right", "select", "session_user", "similar", "some", "symmetric",
  "system_user", "table", "tablesample", "then", "to", "trailing",
  "true", "union", "unique", "user", "using", "variadic",
  "verbose", "when", "where", "window", "with",
]);

/** Why `name` cannot be used as the schema, or null when it can. */
export function kbSchemaProblem(name: string): string | null {
  if (!NAME.test(name)) {
    return "must be 1-63 characters: lowercase letters, digits and underscores, not starting with a digit";
  }
  if (RESERVED.has(name) || name.startsWith(RESERVED_PREFIX)) {
    return `cannot be "${name}": that schema belongs to Postgres or Supabase`;
  }
  if (SQL_RESERVED_WORDS.has(name)) {
    return `cannot be "${name}": that is a reserved word in SQL`;
  }
  return null;
}
