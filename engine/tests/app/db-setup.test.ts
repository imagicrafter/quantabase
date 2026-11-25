import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { findRepoDir, repoSqlFiles, runDbSetup } from "../../src/app/db-setup.js";
import { createMgmt, MgmtError, refFromUrl } from "../../src/app/mgmt.js";
import { ANON_KEY, createFakeSupabase, FILES, JWT_SECRET, MGMT_TOKEN, REF } from "./fake-supabase.js";

const BOOT = "first-run-code-0123456789abcdef";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function inputs(fake: ReturnType<typeof createFakeSupabase>, over: Record<string, unknown> = {}) {
  return {
    mgmt: createMgmt(MGMT_TOKEN, REF, fake.fetch),
    ownerEmail: "owner@example.com",
    bootCode: BOOT,
    jwtSecret: JWT_SECRET,
    anonKey: ANON_KEY,
    kbSchema: "workspace",
    files: FILES,
    ...over,
  };
}

const statuses = (r: Awaited<ReturnType<typeof runDbSetup>>) => Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

describe("the Database screen's steps", () => {
  it("sets up a fresh project end to end", async () => {
    const fake = createFakeSupabase();
    const result = await runDbSetup(inputs(fake));
    expect(result.ok).toBe(true);
    expect(statuses(result)).toEqual({
      project: "done", keys: "done", extensions: "done", migrations: "done", schema: "done",
      embed: "done", embed_token: "done", owner: "done", setup_code: "done",
    });
    expect([...fake.state.applied.keys()]).toEqual(["0000_prelude.sql", "0001_documents_table.sql"]);
    expect(fake.state.dbSchema).toBe("public,graphql_public,workspace");
    expect(fake.state.deployed).toEqual(["embed"]);
    // The embed token: its hash on the principal, the token itself only in the vault.
    const token = fake.state.vault.get("kbe_embed_token") ?? "";
    expect(token.length).toBeGreaterThan(30);
    expect(fake.state.principals.embedHash).toBe(sha(token));
    expect(fake.state.principals.admins).toEqual(["owner@example.com"]);
    expect(fake.state.reopenedWith).toBe(sha(BOOT));
    // Secrets travel as bound parameters, never inside the SQL text.
    for (const q of fake.state.sql) {
      expect(q.query).not.toContain(token);
      expect(q.query).not.toContain(BOOT);
      expect(q.query).not.toContain("owner@example.com");
    }
    // Every call went to the Management API for this one project.
    for (const r of fake.state.requests) expect(r.url.startsWith("https://api.supabase.com/v1/projects")).toBe(true);
  });

  it("is safe to run again: nothing is repeated", async () => {
    const fake = createFakeSupabase();
    await runDbSetup(inputs(fake));
    const token = fake.state.vault.get("kbe_embed_token");
    const again = await runDbSetup(inputs(fake));
    expect(again.ok).toBe(true);
    expect(statuses(again)).toMatchObject({ migrations: "unchanged", schema: "unchanged", embed_token: "unchanged", owner: "unchanged" });
    expect(fake.state.vault.get("kbe_embed_token")).toBe(token);
  });

  it("stops when the app's JWT secret is not this project's, and runs nothing after", async () => {
    const fake = createFakeSupabase({ jwtSecret: "another-projects-secret-0123456789" });
    const result = await runDbSetup(inputs(fake));
    expect(result.ok).toBe(false);
    expect(statuses(result)).toMatchObject({ keys: "failed", migrations: "not_run", owner: "not_run" });
    expect(fake.state.applied.size).toBe(0);
  });

  it("stops when the anon key is not this project's", async () => {
    const fake = createFakeSupabase();
    const result = await runDbSetup(inputs(fake, { anonKey: "someone-elses-anon-key" }));
    expect(statuses(result)).toMatchObject({ keys: "failed" });
  });

  it("refuses an applied migration whose contents changed", async () => {
    const fake = createFakeSupabase();
    fake.state.applied.set("0000_prelude.sql", "0".repeat(64));
    const result = await runDbSetup(inputs(fake));
    expect(statuses(result)).toMatchObject({ migrations: "failed", schema: "not_run" });
    expect(result.steps.find((s) => s.id === "migrations")?.note).toMatch(/never edited/);
  });

  it("reports a failing file without the token in the note", async () => {
    const fake = createFakeSupabase({ failSqlMatching: /create table workspace\.documents/ });
    const result = await runDbSetup(inputs(fake));
    const note = result.steps.find((s) => s.id === "migrations")?.note ?? "";
    expect(note).toMatch(/0001_documents_table\.sql did not apply/);
    expect(note).not.toContain(MGMT_TOKEN);
    expect(note).toContain("[redacted]");
  });

  it("refuses to make a second owner", async () => {
    const fake = createFakeSupabase({ admins: ["first@example.com"] });
    const result = await runDbSetup(inputs(fake));
    expect(statuses(result)).toMatchObject({ owner: "failed", setup_code: "not_run" });
    expect(fake.state.reopenedWith).toBeNull();
  });

  it("waits for a project that is not running", async () => {
    const fake = createFakeSupabase({ status: "COMING_UP" });
    expect(statuses(await runDbSetup(inputs(fake)))).toMatchObject({ project: "failed" });
  });

  it("warns about a token that reaches several projects", async () => {
    const fake = createFakeSupabase({ projects: 3 });
    const result = await runDbSetup(inputs(fake));
    expect(result.ok).toBe(true);
    expect(statuses(result)["project"]).toBe("warning");
  });

  it("sets up the default schema only", async () => {
    const fake = createFakeSupabase();
    const result = await runDbSetup(inputs(fake, { kbSchema: "kb_acme" }));
    expect(result.ok).toBe(false);
    expect(fake.state.requests).toHaveLength(0);
  });
});

describe("the Management API client", () => {
  it("refuses a bad ref or token before any request", () => {
    const fake = createFakeSupabase();
    expect(() => createMgmt(MGMT_TOKEN, "Not-A-Ref", fake.fetch)).toThrow(MgmtError);
    expect(() => createMgmt("short", REF, fake.fetch)).toThrow(/access token/);
    expect(() => createMgmt("has spaces in it and is long enough", REF, fake.fetch)).toThrow(MgmtError);
    expect(fake.state.requests).toHaveLength(0);
  });

  it("explains a refused token without repeating it", async () => {
    const fake = createFakeSupabase();
    const wrong = "sbp_wrongwrongwrongwrongwrongwrong0000";
    await expect(createMgmt(wrong, REF, fake.fetch).get("")).rejects.toThrow(/refused the token/);
    try {
      await createMgmt(wrong, REF, fake.fetch).get("");
    } catch (err) {
      expect(String(err)).not.toContain(wrong);
    }
  });

  it("reads the ref from the app's own Supabase address", () => {
    expect(refFromUrl(`https://${REF}.supabase.co`)).toBe(REF);
    expect(refFromUrl("https://example.com")).toBeNull();
    expect(refFromUrl("not a url")).toBeNull();
  });
});

describe("the repository's SQL", () => {
  it("is found next to the engine folder and read in order", () => {
    const dir = findRepoDir();
    expect(dir).not.toBeNull();
    const files = repoSqlFiles(dir as string);
    const names = files.migrations().map((f) => f.name);
    expect(names[0]).toBe("0000_prelude.sql");
    expect(names).toContain("0054_app_screens.sql");
    expect([...names].sort()).toEqual(names);
    expect(files.embedSource()).toMatch(/Deno|serve/);
  });
});

describe("the owner's name (0077)", () => {
  it("stores the name as the display name and the name used on pages", async () => {
    const fake = createFakeSupabase();
    const result = await runDbSetup(inputs(fake, { ownerName: "Ann" }));
    expect(statuses(result)).toMatchObject({ owner: "done" });
    expect(fake.state.principals.names.get("owner@example.com")).toEqual({ display: "Ann", page: "Ann" });
    const insert = fake.state.sql.find((q) => /insert into \w+\.principals/.test(q.query));
    expect(insert?.query).not.toContain("Ann");
  });

  it("without a name the display name is the email and no page name is stored", async () => {
    const fake = createFakeSupabase();
    await runDbSetup(inputs(fake));
    expect(fake.state.principals.names.get("owner@example.com")).toEqual({ display: "owner@example.com", page: null });
  });

  it("run again with a name, it names the existing owner", async () => {
    const fake = createFakeSupabase({ admins: ["owner@example.com"] });
    const result = await runDbSetup(inputs(fake, { ownerName: "Ann" }));
    expect(statuses(result)).toMatchObject({ owner: "done", setup_code: "done" });
    expect(fake.state.principals.names.get("owner@example.com")).toEqual({ display: "Ann", page: "Ann" });
  });

  it("run again without a name, the existing owner is unchanged", async () => {
    const fake = createFakeSupabase({ admins: ["owner@example.com"] });
    const result = await runDbSetup(inputs(fake));
    expect(statuses(result)).toMatchObject({ owner: "unchanged" });
    expect(fake.state.sql.some((q) => /set page_name/.test(q.query))).toBe(false);
  });
});
