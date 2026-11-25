import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeDatabaseRoutes } from "../../src/app/database-routes.js";
import {
  LIST_MIGRATION,
  migrationState,
  runDbUpdate,
  updateBanner,
  warnPendingAtBoot,
  type DatabaseDeps,
} from "../../src/app/db-update.js";
import { makeFirstRunRoutes } from "../../src/app/first-run-routes.js";
import { makeIndexingRoutes } from "../../src/app/indexing-routes.js";
import { makePipelineRoutes } from "../../src/app/pipeline-routes.js";
import { createMgmt } from "../../src/app/mgmt.js";
import { makeSettingsRoutes } from "../../src/app/settings-routes.js";
import { SETUP_NAV, setupMenu } from "../../src/app/shell.js";
import { AppMissingFunctionError } from "../../src/app/store.js";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { createFakeSupabase, MGMT_TOKEN, REF } from "./fake-supabase.js";
import { ACCESS, ASSERT, client, createScreens, csrfIn, OWNER } from "./fakes.js";

const SHIPPED = [
  { name: "0000_prelude.sql", sql: "create schema if not exists workspace;" },
  { name: "0057_curator_wake_and_claim.sql", sql: "select 57;" },
  { name: "0058_knowledge_ui.sql", sql: "select 58;" },
  { name: LIST_MIGRATION, sql: "select 59;" },
];
const FILES = { migrations: () => SHIPPED, embedSource: () => "" };

type Over = Partial<DatabaseDeps>;

function dbDeps(fake: ReturnType<typeof createFakeSupabase>, over: Over = {}): DatabaseDeps {
  return {
    projectRef: REF,
    kbSchema: "workspace",
    files: () => FILES,
    fetch: fake.fetch,
    applied: async () => [...fake.state.applied.keys()].sort(),
    ...over,
  };
}

const missing = () => Promise.reject(new AppMissingFunctionError("engine_migrations_applied"));

describe("which migrations are pending", () => {
  it("lists the shipped files the database has not applied, by name", async () => {
    const s = await migrationState({ ...dbDeps(createFakeSupabase()), applied: async () => ["0000_prelude.sql", LIST_MIGRATION] });
    expect(s.pending).toEqual(["0057_curator_wake_and_claim.sql", "0058_knowledge_ui.sql"]);
    expect(s.applied).toBe(2);
    expect(s.shipped).toBe(4);
    expect(s.exact).toBe(true);
  });

  it("falls back to the newest applied file when the list function itself is missing", async () => {
    const s = await migrationState({ ...dbDeps(createFakeSupabase()), applied: missing }, async () => "0000_prelude.sql");
    expect(s.pending).toEqual(["0057_curator_wake_and_claim.sql", "0058_knowledge_ui.sql", LIST_MIGRATION]);
    expect(s.exact).toBe(false);
  });

  it("without any fallback, at least the list function's own file is pending", async () => {
    const s = await migrationState({ ...dbDeps(createFakeSupabase()), applied: missing });
    expect(s.pending).toEqual([LIST_MIGRATION]);
    expect(s.exact).toBe(false);
  });

  it("is unknown, not alarming, when the database does not answer or the SQL files are absent", async () => {
    const down = await migrationState({ ...dbDeps(createFakeSupabase()), applied: () => Promise.reject(new Error("down")) });
    expect(down.known).toBe(false);
    expect(down.pending).toEqual([]);
    const noFiles = await migrationState({ ...dbDeps(createFakeSupabase()), files: () => null });
    expect(noFiles.known).toBe(false);
  });

  it("the banner names the count and links to the Database screen; none when up to date", () => {
    const html = updateBanner({ known: true, exact: true, shipped: 4, applied: 2, pending: ["a.sql", "b.sql"] });
    expect(html).toContain("Database update needed: 2 pending");
    expect(html).toContain('href="/setup/database"');
    expect(updateBanner({ known: true, exact: false, shipped: 4, applied: 3, pending: ["a.sql"] })).toContain("at least 1 pending");
    expect(updateBanner({ known: true, exact: true, shipped: 4, applied: 4, pending: [] })).toBe("");
  });
});

describe("the update itself", () => {
  it("applies only the pending files, then exposes the schema and reloads the Data API, with timings", async () => {
    const fake = createFakeSupabase();
    fake.state.applied.set("0000_prelude.sql", "x"); // pretend: applied before (checksum not compared here)
    const files = { migrations: () => SHIPPED.slice(1), embedSource: () => "" };
    let t = 0;
    const result = await runDbUpdate({ mgmt: createMgmt(MGMT_TOKEN, REF, fake.fetch), files, kbSchema: "workspace", now: () => (t += 5) });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ["project", "done"],
      ["migrations", "done"],
      ["schema", "done"],
    ]);
    for (const s of result.steps) expect(s.ms).toBe(5);
    expect([...fake.state.applied.keys()]).toEqual(["0000_prelude.sql", ...SHIPPED.slice(1).map((f) => f.name)]);
    expect(fake.state.dbSchema).toContain("workspace");
    expect(fake.state.sql.some((q) => /notify pgrst, 'reload schema'/.test(q.query))).toBe(true);
    // No setup-only step runs: no keys, no embed deploy, no owner, no setup code.
    expect(fake.state.deployed).toEqual([]);
    expect(fake.state.reopenedWith).toBeNull();
  });

  it("stops at a failing file and runs nothing after it", async () => {
    const fake = createFakeSupabase({ failSqlMatching: /select 58/ });
    const result = await runDbUpdate({ mgmt: createMgmt(MGMT_TOKEN, REF, fake.fetch), files: FILES, kbSchema: "workspace" });
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(["done", "failed", "not_run"]);
    expect(result.steps[1]?.note).toContain("0058_knowledge_ui.sql");
    expect(JSON.stringify(result)).not.toContain(MGMT_TOKEN);
  });

  it("refuses a non-default schema (kbe db migrate does those)", async () => {
    const fake = createFakeSupabase();
    const result = await runDbUpdate({ mgmt: createMgmt(MGMT_TOKEN, REF, fake.fetch), files: FILES, kbSchema: "kb_acme" });
    expect(result.ok).toBe(false);
    expect(fake.state.requests).toHaveLength(0);
  });
});

describe("the boot warning", () => {
  it("logs the pending migrations by name once the Engine is ready", async () => {
    const logs = _captureLogsForTests();
    try {
      const pending = await warnPendingAtBoot(
        { ...dbDeps(createFakeSupabase()), applied: async () => ["0000_prelude.sql", LIST_MIGRATION] },
        async () => ({ kind: "ready", access: ACCESS, setupOpen: false }),
      );
      expect(pending).toEqual(["0057_curator_wake_and_claim.sql", "0058_knowledge_ui.sql"]);
      const text = logs.lines().join("\n");
      expect(text).toContain("database update needed");
      expect(text).toContain("0057_curator_wake_and_claim.sql");
      expect(text).toContain("/setup/database");
    } finally {
      logs.stop();
    }
  });

  it("says nothing when up to date, and does not look while the Engine is in setup", async () => {
    const logs = _captureLogsForTests();
    try {
      const all = SHIPPED.map((f) => f.name);
      expect(await warnPendingAtBoot({ ...dbDeps(createFakeSupabase()), applied: async () => all }, async () => ({ kind: "ready", access: ACCESS, setupOpen: false }))).toEqual([]);
      let asked = false;
      const setup = { ...dbDeps(createFakeSupabase()), applied: async () => ((asked = true), []) };
      await warnPendingAtBoot(setup, async () => ({ kind: "setup", reason: "unset" }) as never);
      expect(asked).toBe(false);
      expect(logs.lines().join("\n")).not.toContain("database update needed");
    } finally {
      logs.stop();
    }
  });
});

// ── the screen ───────────────────────────────────────────────────────────────

function world(over: { applied?: () => Promise<readonly string[]>; fake?: ReturnType<typeof createFakeSupabase>; database?: false } = {}) {
  const fake = over.fake ?? createFakeSupabase();
  const database = over.database === false ? undefined : { ...dbDeps(fake), ...(over.applied ? { applied: over.applied } : {}) };
  const screens = createScreens(database ? { database } : {});
  const app = new Hono();
  app.route("/setup", makeDatabaseRoutes(() => screens.deps));
  app.route("/setup", makeSettingsRoutes(() => screens.deps));
  app.route("/setup", makeIndexingRoutes(() => screens.deps));
  app.route("/setup", makePipelineRoutes(() => screens.deps));
  return { ...screens, supa: fake, http: client(app) };
}

const upToDate = async () => SHIPPED.map((f) => f.name);
const behind = async () => ["0000_prelude.sql", LIST_MIGRATION];

describe("/setup/database after sign-in", () => {
  it("is for administrators only", async () => {
    const w = world();
    expect((await w.http.get("/setup/database")).status).toBe(401);
    expect((await w.http.get("/setup/database", ASSERT.reader)).status).toBe(403);
    expect((await w.http.post("/setup/database", { access_token: MGMT_TOKEN }, ASSERT.reader)).status).toBe(403);
    expect(w.supa.state.requests).toHaveLength(0);
  });

  it("shows applied vs shipped, names the pending files, and offers the update", async () => {
    const w = world({ applied: behind });
    const res = await w.http.get("/setup/database", ASSERT.owner);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Database update needed: 2 pending");
    expect(html).toMatch(/2 of 4/);
    expect(html).toContain("0057_curator_wake_and_claim.sql");
    expect(html).toContain("0058_knowledge_ui.sql");
    expect(html).toContain('name="access_token"');
    expect(html).toContain("Update the database");
    expect(html).not.toMatch(/<script/i);
    // The token box links to Supabase's token page; the project ID links to the project.
    expect(html).toContain('href="https://supabase.com/dashboard/account/tokens"');
    expect(html).toContain(`href="https://supabase.com/dashboard/project/${REF}"`);
  });

  it("says up to date when nothing is pending", async () => {
    const html = await (await world({ applied: upToDate }).http.get("/setup/database", ASSERT.owner)).text();
    expect(html).toContain("up to date");
    expect(html).not.toContain("Database update needed");
  });

  it("applies the pending files with a one-time token that is never shown, logged or kept", async () => {
    const fake = createFakeSupabase();
    fake.state.applied.set("0000_prelude.sql", createHash("sha256").update(SHIPPED[0]?.sql ?? "").digest("hex"));
    const w = world({ fake, applied: async () => [...fake.state.applied.keys()].sort() });
    const csrf = csrfIn(await (await w.http.get("/setup/database", ASSERT.owner)).text());
    const logs = _captureLogsForTests();
    let html: string;
    try {
      const res = await w.http.post("/setup/database", { csrf, access_token: MGMT_TOKEN }, ASSERT.owner);
      expect(res.status).toBe(200);
      html = await res.text();
      const logged = logs.lines().join("\n");
      expect(logged).not.toContain(MGMT_TOKEN);
      expect(logged).toContain("database update finished");
    } finally {
      logs.stop();
    }
    expect(html).not.toContain(MGMT_TOKEN);
    expect(html).toContain("The database is up to date");
    expect(html).toMatch(/\d+ ms/);
    expect(fake.state.applied.has("0058_knowledge_ui.sql")).toBe(true);
    expect(fake.state.deployed).toEqual([]);
    for (const r of fake.state.requests) expect(r.url.startsWith(`https://api.supabase.com/v1/projects`)).toBe(true);
  });

  it("refuses a post without the page's form token, and touches nothing", async () => {
    const w = world({ applied: behind });
    const res = await w.http.post("/setup/database", { csrf: "nope", access_token: MGMT_TOKEN }, ASSERT.owner);
    expect(res.status).toBe(403);
    expect(w.supa.state.requests).toHaveLength(0);
  });

  it("refuses a malformed token without echoing it", async () => {
    const w = world({ applied: behind });
    const csrf = csrfIn(await (await w.http.get("/setup/database", ASSERT.owner)).text());
    const res = await w.http.post("/setup/database", { csrf, access_token: "short bad" }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("short bad");
    expect(w.supa.state.requests).toHaveLength(0);
  });

  it("shows the failed step and its timing, with a 422", async () => {
    const fake = createFakeSupabase({ failSqlMatching: /select 58/ });
    const w = world({ fake, applied: behind });
    const csrf = csrfIn(await (await w.http.get("/setup/database", ASSERT.owner)).text());
    const res = await w.http.post("/setup/database", { csrf, access_token: MGMT_TOKEN }, ASSERT.owner);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("0058_knowledge_ui.sql did not apply");
    expect(html).not.toContain(MGMT_TOKEN);
  });

  it("says plainly when this app cannot update its own database", async () => {
    const w = world({ database: false });
    const html = await (await w.http.get("/setup/database", ASSERT.owner)).text();
    expect(html).toContain("kbe db migrate");
    expect(html).not.toContain('name="access_token"');
  });

  it("is in the setup menu and the nav", () => {
    expect(SETUP_NAV.some((i) => i.href === "/setup/database" && i.label === "Database")).toBe(true);
    expect(setupMenu()).toContain('href="/setup/database"');
  });
});

describe("Health and Indexing say when the database is behind", () => {
  it("Health shows the banner with the count", async () => {
    const html = await (await world({ applied: behind }).http.get("/setup/health", ASSERT.owner)).text();
    expect(html).toContain("Database update needed: 2 pending");
    expect(html).toContain('href="/setup/database"');
  });

  it("Health shows both sign-in lengths", async () => {
    const w = world({ applied: upToDate });
    w.mode.current = { kind: "ready", access: { ...ACCESS, session: "8760h" }, setupOpen: false };
    const html = await (await w.http.get("/setup/health", ASSERT.owner)).text();
    expect(html).toContain("You stay signed in for 1 year; Claude&#39;s connector re-approves every 1 year.");
  });

  it("Health shows no banner when up to date", async () => {
    const html = await (await world({ applied: upToDate }).http.get("/setup/health", ASSERT.owner)).text();
    expect(html).not.toContain("Database update needed");
  });

  it("Indexing shows the banner instead of a raw failure when its function is missing (PGRST202)", async () => {
    const w = world({ applied: behind });
    const deps = w.deps as { store: typeof w.fake.store };
    deps.store = { ...w.fake.store, indexing: async () => Promise.reject(new AppMissingFunctionError("app_indexing")) };
    const res = await w.http.get("/setup/pipeline", ASSERT.owner);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Database update needed: 2 pending");
    expect(html).toContain('href="/setup/database"');
    expect(html).not.toMatch(/did not answer/);
  });

  it("Indexing shows the banner above its status when behind", async () => {
    const html = await (await world({ applied: behind }).http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toContain("Database update needed: 2 pending");
    expect(html).toContain("Details for experts");
  });

  it("any admin screen whose function is missing shows the banner", async () => {
    const w = world({ applied: behind });
    const deps = w.deps as { store: typeof w.fake.store };
    deps.store = { ...w.fake.store, topics: async () => Promise.reject(new AppMissingFunctionError("app_topics_list")) };
    const html = await (await w.http.get("/setup/people", ASSERT.owner)).text();
    expect(html).toContain("Database update needed: 2 pending");
  });
});

describe("the first-run Database screen and the update screen share the address", () => {
  it("after setup, /setup/database is the update screen, not a 404", async () => {
    const fake = createFakeSupabase();
    const screens = createScreens({ database: { ...dbDeps(fake), applied: behind } });
    const app = new Hono();
    app.route(
      "/setup",
      makeFirstRunRoutes(() => ({
        boot: () => ({ original: () => undefined, resumable: () => false }) as never,
        envCode: undefined,
        mode: screens.deps.mode,
        projectRef: REF,
        kbSchema: "workspace",
        jwtSecret: "x",
        anonKey: "y",
        files: () => FILES,
        fetch: fake.fetch,
        onDatabaseReady: () => undefined,
      })),
    );
    app.route("/setup", makeDatabaseRoutes(() => screens.deps));
    const res = await client(app).get("/setup/database", ASSERT.owner);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Database update needed: 2 pending");
    expect(OWNER).toBe("owner@example.com");
  });
});
