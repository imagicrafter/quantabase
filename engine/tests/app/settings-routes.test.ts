import { shown } from "../shown.js";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeSettingsRoutes } from "../../src/app/settings-routes.js";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { ASSERT, OWNER, READER, client, createScreens, csrfIn } from "./fakes.js";

function world() {
  const screens = createScreens();
  const app = new Hono();
  app.route("/setup", makeSettingsRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

const SCREENS = ["/setup/people", "/setup/template", "/setup/model", "/setup/timer", "/setup/health"];

describe("settings screens: administrators only", () => {
  it.each(SCREENS)("%s refuses no sign-in, a reader, and a stranger", async (path) => {
    const w = world();
    expect((await w.http.get(path)).status).toBe(401);
    expect((await w.http.get(path, ASSERT.reader)).status).toBe(403);
    expect((await w.http.get(path, ASSERT.stranger)).status).toBe(403);
  });

  it.each(SCREENS)("%s opens for the owner", async (path) => {
    const w = world();
    const res = await w.http.get(path, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/<script/i);
  });

  it("refuses a post from a reader even with a token made for them", async () => {
    const w = world();
    const csrf = w.deps.csrf.token("reader@example.com", "model");
    const res = await w.http.post("/setup/model", { csrf, model_key: "k".repeat(40) }, ASSERT.reader);
    expect(res.status).toBe(403);
    expect(w.fake.state.modelKey).toBeNull();
  });
});

describe("the model key", () => {
  it("goes to the vault and is never shown or logged", async () => {
    const w = world();
    const key = "do-model-key-SECRET-0123456789abcdef";
    const csrf = csrfIn(await (await w.http.get("/setup/model", ASSERT.owner)).text());
    const logs = _captureLogsForTests();
    try {
      const res = await w.http.post("/setup/model", { csrf, model_key: key }, ASSERT.owner);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(key);
      expect(w.fake.state.modelKey).toBe(key);
      expect(logs.lines().join("\n")).not.toContain(key);
    } finally {
      logs.stop();
    }
    const after = await (await w.http.get("/setup/model", ASSERT.owner)).text();
    expect(after).toMatch(/Key stored: <strong>yes/);
    expect(after).not.toContain(key);
    expect(after).not.toMatch(/value="do-model/);
  });

  it("refuses a key with spaces or too short, without echoing it", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/model", ASSERT.owner)).text());
    const res = await w.http.post("/setup/model", { csrf, model_key: "two words here" }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("two words here");
    expect(w.fake.state.modelKey).toBeNull();
  });
});

describe("the template", () => {
  it("shows every choosable template and saves the chosen ones", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/template", ASSERT.owner)).text();
    expect(html).toContain('value="consulting"');
    expect(html).toContain('value="property"');
    expect(html).not.toContain('value="base"');
    const res = await w.http.post("/setup/template", { csrf: csrfIn(html), template: ["consulting", "property"] }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(w.fake.state.templates).toEqual(["consulting", "property"]);
  });

  it("a template that adds no drawers says it uses the base drawers, with no empty 'Adds:'", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/template", ASSERT.owner)).text();
    const solo = /value="solo"[^]*?<\/label>/.exec(html)?.[0] ?? "";
    expect(solo).toMatch(/Uses the 8 base drawers/);
    expect(solo).not.toMatch(/Adds:/);
    expect(solo).not.toMatch(/Adds no drawers/);
    const consulting = /value="consulting"[^]*?<\/label>/.exec(html)?.[0] ?? "";
    expect(consulting).toMatch(/Adds: \S/);
  });

  it("refuses a name that is not a template", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/template", ASSERT.owner)).text());
    const res = await w.http.post("/setup/template", { csrf, template: ["../etc"] }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(w.fake.state.templates).toEqual([]);
  });
});

describe("topics and people", () => {
  it("administrators make a topic: preview first, then only with a yes", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/people", ASSERT.owner)).text();
    expect(html).toContain('action="/setup/people/topic"');
    expect(html).not.toContain("Found in your sources");
    const preview = await w.http.post("/setup/people/topic", { csrf: csrfIn(html), topic: "deals", label: "Deals" }, ASSERT.owner);
    expect(preview.status).toBe(200);
    const confirm = await preview.text();
    expect(confirm).toContain('name="confirm" value="yes"');
    expect(w.fake.calls.filter((c) => c.fn === "addTopic")).toHaveLength(0);
    const done = await w.http.post("/setup/people/topic", { csrf: csrfIn(confirm), topic: "deals", label: "Deals", confirm: "yes" }, ASSERT.owner);
    expect(done.status).toBe(200);
    expect(w.fake.state.topicsMade).toEqual(["deals"]);
  });

  it("refuses a topic id that is not one", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    for (const topic of ["Bad Topic", "unclassified", "1x"]) {
      const res = await w.http.post("/setup/people/topic", { csrf, topic, label: "X", confirm: "yes" }, ASSERT.owner);
      expect(res.status).toBe(400);
    }
    expect(w.fake.state.topicsMade).toEqual([]);
  });

  it("a non-administrator cannot reach the topic form", async () => {
    const w = world();
    const res = await w.http.post("/setup/people/topic", { csrf: "x", topic: "deals", label: "Deals", confirm: "yes" }, ASSERT.reader);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(w.fake.state.topicsMade).toEqual([]);
  });

  it("shows a count of each person's source rules, never the rules", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/people", ASSERT.owner)).text();
    expect(html).toContain("Source rules");
    expect(w.fake.calls.some((c) => c.fn === "peopleRuleCounts")).toBe(true);
    expect(w.fake.calls.some((c) => c.fn === "sourceRules")).toBe(false);
    expect(html).not.toContain("@acme.com");
    expect(READER).toBeTruthy();
  });

  it("removing a person goes through the same preview and code", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    const res = await w.http.post("/setup/people/change", { csrf, action: "deactivate", email: "old@example.com" }, ASSERT.owner);
    expect(res.status).toBe(200);
    const call = w.fake.calls.find((c) => c.fn === "twoStep");
    expect(call?.args[1]).toEqual({ fn: "admin_person_deactivate", args: { p_person_email: "old@example.com" } });
  });

  it("previews a person add, then applies only with the returned code", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    const fields = { csrf, action: "add", email: "new@example.com", display_name: "New", role: "reader" };
    const preview = await w.http.post("/setup/people/change", fields, ASSERT.owner);
    const html = await preview.text();
    expect(shown(html)).toContain("Add reader@example.com as a reader.");
    expect(html).toContain(`name="confirm_code" value="${"f".repeat(32)}"`);
    const first = w.fake.calls.find((c) => c.fn === "twoStep")?.args[1] as { confirmCode?: string };
    expect(first.confirmCode).toBeUndefined();

    const apply = await w.http.post("/setup/people/change", { ...fields, csrf: csrfIn(html), confirm_code: "f".repeat(32) }, ASSERT.owner);
    expect(apply.status).toBe(200);
    const second = w.fake.calls.filter((c) => c.fn === "twoStep")[1]?.args[1] as { fn: string; confirmCode?: string };
    expect(second).toMatchObject({ fn: "admin_person_add", confirmCode: "f".repeat(32) });
  });

  it("validates grant fields", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    expect((await w.http.post("/setup/people/change", { csrf, action: "grant", email: "not an email", topic: "x" }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/people/change", { csrf, action: "grant", email: "a@example.com", topic: "x", confirm_code: "zz" }, ASSERT.owner)).status).toBe(400);
  });
});

describe("the timer", () => {
  it("shows the whole tick address, one on/off switch and no interval choice", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/timer", ASSERT.owner)).text();
    // The full address as text (a narrow input box cut it off live, 2026-11-20).
    expect(html).toMatch(/<code class="address">https:\/\/engine\.example\.com\/internal\/curator\/tick<\/code>/);
    expect(html).not.toMatch(/name="every"/);
    expect(html).not.toMatch(/minutes<\/option>/);
    expect(html).toMatch(/name="enabled"/);
    expect(html).toMatch(/new items arrive/i);
    expect(html).toMatch(/every hour/i);
    expect(html).toMatch(/Test the timer/);
    expect(html).toMatch(/bypass/);
  });

  it("shows whether the timer is firing: cron jobs, failed pokes, last tick", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/timer", ASSERT.owner)).text();
    expect(html).toContain("Is the timer firing?");
    expect(html).toContain("Wake check (every minute)");
    expect(html).toContain("2 of 5 failed");
    expect(html).toContain("Last poke received by the service");
  });

  it("still renders the timer when the database has no health function yet", async () => {
    const w = world();
    w.deps.store = { ...w.deps.store, curatorHealth: async () => Promise.reject(new Error("missing")) };
    const res = await w.http.get("/setup/timer", ASSERT.owner);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("needs its latest update");
  });

  it("saves the switch for the Engine's own host", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/timer", ASSERT.owner)).text();
    const res = await w.http.post("/setup/timer", { csrf: csrfIn(html), enabled: "yes" }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(w.fake.calls.find((c) => c.fn === "setTimer")?.args).toEqual([OWNER, "engine.example.com", true]);
    expect(await res.text()).toMatch(/new items arrive/i);
  });

  it("refuses another address", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/timer", ASSERT.owner)).text());
    expect((await w.http.post("/setup/timer", { csrf, engine_url: "https://evil.example.com/steal" }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/timer", { csrf, engine_url: "https://evil.example.com/internal/curator/tick", enabled: "yes" }, ASSERT.owner)).status).toBe(400);
    expect(w.fake.calls.some((c) => c.fn === "setTimer")).toBe(false);
  });

  it("a test poke that Cloudflare stops says to add the bypass", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/timer", ASSERT.owner)).text());
    const res = await w.http.post("/setup/timer/test", { csrf }, ASSERT.owner);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/timer?test=42");
    const html = await (await w.http.get("/setup/timer?test=42", ASSERT.owner)).text();
    expect(html).toMatch(/Cloudflare sign-in stopped the poke \(302\)/);
  });
});

describe("health", () => {
  it("lists the checks and the connector address", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/health", ASSERT.owner)).text();
    expect(html).toContain("https://engine.example.com/mcp");
    expect(html).toContain("0054_app_screens.sql");
    expect(html).toMatch(/Model key<\/td><td>not set/);
  });

  it("checks that the hostname reaches this app, and says how to add it in DigitalOcean when not", async () => {
    const seen: string[] = [];
    const ok = createScreens({ hostCheck: async (h) => { seen.push(h); return { ok: true, detail: "answers" }; } });
    const okApp = new Hono();
    okApp.route("/setup", makeSettingsRoutes(() => ok.deps));
    const good = await (await client(okApp).get("/setup/health", ASSERT.owner)).text();
    expect(seen).toEqual(["engine.example.com"]);
    expect(good).toMatch(/OK<\/td><td>Hostname reaches the app/);
    expect(good).not.toMatch(/Add engine\.example\.com to the app in DigitalOcean/);

    const bad = createScreens({ hostCheck: async () => ({ ok: false, detail: "DigitalOcean answered 404" }) });
    const badApp = new Hono();
    badApp.route("/setup", makeSettingsRoutes(() => bad.deps));
    const html = await (await client(badApp).get("/setup/health", ASSERT.owner)).text();
    expect(html).toMatch(/Needs work<\/td><td>Hostname reaches the app<\/td><td>DigitalOcean answered 404/);
    expect(html).toMatch(/Add engine\.example\.com to the app in DigitalOcean/);
  });

  it("shows a failing embed check without breaking the page", async () => {
    const w = createScreens({ embedCheck: async () => { throw new Error("down"); } });
    const app = new Hono();
    app.route("/setup", makeSettingsRoutes(() => w.deps));
    const html = await (await client(app).get("/setup/health", ASSERT.owner)).text();
    expect(html).toMatch(/Needs work<\/td><td>Embedding/);
  });
});
