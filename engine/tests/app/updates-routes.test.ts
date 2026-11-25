import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { ReleaseCheck } from "../../src/app/release-check.js";
import type { UpdatesDeps } from "../../src/app/updates-routes.js";
import { makeUpdatesRoutes } from "../../src/app/updates-routes.js";
import { LIST_MIGRATION, type DatabaseDeps } from "../../src/app/db-update.js";
import { SETUP_NAV, setupMenu, helperFor } from "../../src/app/shell.js";
import { ASSERT, client, createScreens } from "./fakes.js";

const APP_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SHIPPED = ["0000_prelude.sql", "0058_knowledge_ui.sql", LIST_MIGRATION].map((name) => ({ name, sql: "select 1;" }));

function database(applied: readonly string[]): DatabaseDeps {
  return {
    projectRef: "abcdefghijklmnopqrst",
    kbSchema: "workspace",
    files: () => ({ migrations: () => SHIPPED, embedSource: () => "" }),
    fetch: async () => new Response("", { status: 500 }),
    applied: async () => applied,
  };
}

const newer: ReleaseCheck = {
  ok: true,
  repo: "imagicrafter/quantabase",
  latest: "1.2.0",
  newer: true,
  notes: [{ version: "1.2.0", text: "- Added <script>alert(1)</script> & [a link](javascript:x)" }],
};

function world(updates: Partial<UpdatesDeps> = {}, applied: readonly string[] = SHIPPED.map((f) => f.name)) {
  let checks = 0;
  const deps: UpdatesDeps = {
    running: "1.0.0",
    appId: null,
    check: async () => {
      checks += 1;
      return newer;
    },
    ...updates,
  };
  const screens = createScreens({ database: database(applied), updates: deps });
  const app = new Hono();
  app.route("/setup", makeUpdatesRoutes(() => screens.deps));
  return { http: client(app), checks: () => checks };
}

describe("/setup/updates", () => {
  it("is for administrators only, and checks nothing for anyone else", async () => {
    const w = world();
    expect((await w.http.get("/setup/updates")).status).toBe(401);
    expect((await w.http.get("/setup/updates", ASSERT.reader)).status).toBe(403);
    expect(w.checks()).toBe(0);
  });

  it("shows the running and the latest version, what is new, and how to update", async () => {
    const html = await (await world().http.get("/setup/updates", ASSERT.owner)).text();
    expect(html).toContain("1.0.0");
    expect(html).toContain("1.2.0");
    expect(html).toContain("A new version is available");
    expect(html).toContain("What's new");
    expect(html).toContain("Actions → Force Rebuild and Deploy");
    expect(html).toContain('href="https://cloud.digitalocean.com/apps"');
    expect(html).toContain('href="/setup/database"');
  });

  it("escapes everything fetched: no script, no live link", async () => {
    const html = await (await world().http.get("/setup/updates", ASSERT.owner)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("links straight to the app when DigitalOcean gave its id", async () => {
    const html = await (await world({ appId: APP_ID }).http.get("/setup/updates", ASSERT.owner)).text();
    expect(html).toContain(`href="https://cloud.digitalocean.com/apps/${APP_ID}"`);
  });

  it("says up to date when nothing newer is out", async () => {
    const same: ReleaseCheck = { ok: true, repo: "a/b", latest: "1.0.0", newer: false, notes: [] };
    const html = await (await world({ check: async () => same }).http.get("/setup/updates", ASSERT.owner)).text();
    expect(html).toContain("You are on the latest version");
    expect(html).not.toContain("What's new");
  });

  it("says when the running version cannot be compared", async () => {
    const unknown: ReleaseCheck = { ok: true, repo: "a/b", latest: "1.0.0", newer: null, notes: [] };
    const html = await (await world({ check: async () => unknown, running: "unknown" }).http.get("/setup/updates", ASSERT.owner)).text();
    expect(html).toContain("could not be compared");
  });

  it("fails quietly when the check fails or throws", async () => {
    for (const check of [async (): Promise<ReleaseCheck> => ({ ok: false }), async (): Promise<ReleaseCheck> => Promise.reject(new Error("boom"))]) {
      const res = await world({ check }).http.get("/setup/updates", ASSERT.owner);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Could not check for updates just now.");
      expect(html).toContain("Actions → Force Rebuild and Deploy");
    }
  });

  it("says how many database updates are pending", async () => {
    const html = await (await world({}, ["0000_prelude.sql"]).http.get("/setup/updates", ASSERT.owner)).text();
    expect(html).toContain("Database update needed: 2");
  });

  it("works without updates deps (says it could not check)", async () => {
    const screens = createScreens({ database: database([]) });
    const app = new Hono();
    app.route("/setup", makeUpdatesRoutes(() => screens.deps));
    const html = await (await client(app).get("/setup/updates", ASSERT.owner)).text();
    expect(html).toContain("Could not check for updates just now.");
  });

  it("is in the setup menu and the nav, with a one-line helper", () => {
    expect(SETUP_NAV.some((i) => i.href === "/setup/updates" && i.label === "Updates")).toBe(true);
    expect(setupMenu()).toContain('href="/setup/updates"');
    expect(helperFor("/setup/updates")).not.toBe("");
  });
});
