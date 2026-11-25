import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeSettingsRoutes } from "../../src/app/settings-routes.js";
import { ASSERT, OWNER, client, createScreens, csrfIn } from "./fakes.js";

/** Staff & settings: an administrator's own display name and name used on pages (0077). */

function world() {
  const screens = createScreens();
  const app = new Hono();
  app.route("/setup", makeSettingsRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

const sets = (w: ReturnType<typeof world>) => w.fake.calls.filter((c) => c.fn === "setMyNames");

describe("your names on Staff & settings", () => {
  it("the people screen shows your display name and the name used on pages", async () => {
    const w = world();
    w.fake.state.names = { display_name: "owner@example.com", page_name: null, page_name_used: null };
    const html = await (await w.http.get("/setup/people", ASSERT.owner)).text();
    expect(html).toContain('action="/setup/people/names"');
    expect(html).toContain("Name used on pages");
    expect(html).toMatch(/name="page_name"[^>]*maxlength="60"/);
    expect(html).toMatch(/name="display_name_self"[^>]*value="owner(?:@|&#64;)example.com"/);
    expect(html).toMatch(/Pages call you <strong>the owner<\/strong>|not set/i);
  });

  it("saves both for the signed-in administrator only", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    const res = await w.http.post("/setup/people/names", { csrf, display_name_self: " Ann Example ", page_name: " Ann " }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Ann");
    expect(sets(w)).toEqual([{ fn: "setMyNames", args: [OWNER, "Ann Example", "Ann"] }]);
  });

  it("an empty page name goes back to the default", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    const res = await w.http.post("/setup/people/names", { csrf, display_name_self: "Ann Example", page_name: "" }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(sets(w)).toEqual([{ fn: "setMyNames", args: [OWNER, "Ann Example", null] }]);
  });

  it.each([
    ["a page name over 60 characters", { display_name_self: "Ann", page_name: "a".repeat(61) }],
    ["a page name with a line break", { display_name_self: "Ann", page_name: "Ann\nB" }],
    ["an empty display name", { display_name_self: "  ", page_name: "Ann" }],
  ])("refuses %s and changes nothing", async (_label, form) => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    const res = await w.http.post("/setup/people/names", { csrf, ...form }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(sets(w)).toEqual([]);
  });

  it("refuses a post without the form token", async () => {
    const w = world();
    const res = await w.http.post("/setup/people/names", { display_name_self: "Ann", page_name: "Ann" }, ASSERT.owner);
    expect(res.status).toBe(403);
    expect(sets(w)).toEqual([]);
  });

  it("refuses a token made for another screen", async () => {
    const w = world();
    const csrf = w.deps.csrf.token(OWNER, "model");
    const res = await w.http.post("/setup/people/names", { csrf, display_name_self: "Ann", page_name: "Ann" }, ASSERT.owner);
    expect(res.status).toBe(403);
    expect(sets(w)).toEqual([]);
  });

  it("refuses a reader, a stranger and no sign-in, even with a token made for them", async () => {
    const w = world();
    const csrf = w.deps.csrf.token("reader@example.com", "people");
    expect((await w.http.post("/setup/people/names", { csrf, display_name_self: "R", page_name: "R" }, ASSERT.reader)).status).toBe(403);
    expect((await w.http.post("/setup/people/names", { csrf, display_name_self: "S", page_name: "S" }, ASSERT.stranger)).status).toBe(403);
    expect((await w.http.post("/setup/people/names", { csrf, display_name_self: "N", page_name: "N" })).status).toBe(401);
    expect(sets(w)).toEqual([]);
  });

  it("still opens the people screen when the database is older than 0077", async () => {
    const w = world();
    w.fake.state.names = null;
    const res = await w.http.get("/setup/people", ASSERT.owner);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Update the database/);
  });
});
