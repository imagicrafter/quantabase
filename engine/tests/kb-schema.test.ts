import { describe, expect, it } from "vitest";
import { DEFAULT_KB_SCHEMA, kbSchemaProblem } from "../src/kb-schema.js";

describe("KB_SCHEMA validation", () => {
  it("defaults to workspace", () => {
    expect(DEFAULT_KB_SCHEMA).toBe("workspace");
  });

  it.each(["workspace", "kb_acme", "_x", "a", "a".repeat(63), "kb2"])(
    "accepts %s",
    (name) => {
      expect(kbSchemaProblem(name)).toBeNull();
    },
  );

  it.each([
    "",
    " ",
    "Workspace",
    "kb-acme",
    "1kb",
    "kb acme",
    "a".repeat(64),
    "kb;drop",
    'kb"x',
    "kb.x",
    "kb$",
    " workspace",
    "workspace\n",
  ])("rejects %j as not a plain identifier", (name) => {
    expect(kbSchemaProblem(name)).toMatch(/lowercase letters/);
  });

  it.each([
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
    "pg_catalog",
    "pg_temp",
    "pg_anything",
  ])("rejects the reserved schema %s", (name) => {
    expect(kbSchemaProblem(name)).toMatch(/belongs to Postgres or Supabase/);
  });

  it.each(["user", "table", "select", "order", "group", "default", "end"])(
    "rejects the SQL reserved word %s",
    (name) => {
      expect(kbSchemaProblem(name)).toMatch(/reserved word in SQL/);
    },
  );

  it.each(["users", "kb_user", "_user"])("accepts %s, which only contains one", (name) => {
    expect(kbSchemaProblem(name)).toBeNull();
  });
});
