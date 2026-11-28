import { describe, it, expect, vi, afterEach } from "vitest";
import { shown } from "../shown.js";
import { Hono } from "hono";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { createJobs } from "../../src/fireflies/fetch.js";
import { logger } from "../../src/log/logger.js";
import { ACCOUNT_ID, ASSERT, HOST, READER, client, createScreens, csrfIn } from "./fakes.js";
import { API_KEY, HOOK, SECRET, createFakeClient, createFakeFirefliesStore, transcript } from "../fireflies/fakes.js";

function world() {
  const ff = createFakeFirefliesStore();
  const fc = createFakeClient({ M1: transcript("M1") });
  const jobs = createJobs();
  const screens = createScreens({
    fireflies: { store: ff.store, client: fc.client, jobs, newHookId: () => HOOK, newSecret: () => SECRET, pause: async () => {} },
  });
  // The account page reads READER's account as a Fireflies one.
  const sourceRules = screens.fake.store.sourceRules;
  const fakeStore = { ...screens.fake.store, sourceRules: async (e: string, id: string) => ({ ...(await sourceRules(e, id)), source: "fireflies", account: "ann@meet.example" }) };
  const deps = { ...screens.deps, store: fakeStore };
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => deps));
  return { ff, fc, jobs, http: client(app) };
}

afterEach(() => vi.restoreAllMocks());

const csrfOf = async (w: ReturnType<typeof world>, path = "/app/sources") => csrfIn(await (await w.http.get(path, ASSERT.reader)).text());

describe("Connect Fireflies", () => {
  it("the Sources screen offers it", async () => {
    const w = world();
    const html = await (await w.http.get("/app/sources", ASSERT.reader)).text();
    expect(html).toContain("Connect Fireflies");
    expect(html).toContain('action="/app/sources/fireflies/connect"');
    expect(html).toContain('type="password" id="api_key"');
  });

  it("checks the key with Fireflies at once, then connects the fireflies:<email> account", async () => {
    const info = vi.spyOn(logger, "info");
    const w = world();
    const res = await w.http.post("/app/sources/fireflies/connect", { csrf: await csrfOf(w), api_key: ` ${API_KEY} ` }, ASSERT.reader);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/sources/${ACCOUNT_ID}?connected=1`);
    expect(w.fc.calls.map((c) => c.fn)).toEqual(["whoami"]);
    expect(w.ff.calls.find((c) => c.fn === "connect")?.args).toEqual([READER, "ann@meet.example", API_KEY, HOOK, SECRET]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(API_KEY);
  });

  it("refuses a key Fireflies does not accept, and never echoes it", async () => {
    const w = world();
    const wrong = "ff-wrong-key-1234567890";
    const res = await w.http.post("/app/sources/fireflies/connect", { csrf: await csrfOf(w), api_key: wrong }, ASSERT.reader);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Fireflies did not accept that key");
    expect(html).not.toContain(wrong);
    expect(w.ff.calls.some((c) => c.fn === "connect")).toBe(false);
  });

  it("refuses an empty or spaced key before calling Fireflies, and needs the form token", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    expect((await w.http.post("/app/sources/fireflies/connect", { csrf, api_key: "has a space in it" }, ASSERT.reader)).status).toBe(400);
    expect((await w.http.post("/app/sources/fireflies/connect", { csrf: "nope", api_key: API_KEY }, ASSERT.reader)).status).toBe(403);
    expect(w.fc.calls).toHaveLength(0);
  });
});

describe("a connected account's page", () => {
  it("shows the address and secret with Copy buttons, the plain steps, and only the key's last 4", async () => {
    const w = world();
    const html = await (await w.http.get(`/app/sources/${ACCOUNT_ID}?connected=1`, ASSERT.reader)).text();
    const url = `https://${HOST}/hooks/fireflies/${HOOK}`;
    expect(html).toContain(`data-copy="${url}"`);
    expect(html).toContain(`data-copy="${SECRET}"`);
    expect(shown(html)).toContain("Connected as ann@meet.example");
    expect(html).toContain("<code>LAST</code>");
    expect(html).not.toContain(API_KEY);
    for (const step of ["Webhooks (V2)", "meeting.summarized", "meeting.transcribed", "Send test", "Waiting for the first delivery"]) {
      expect(shown(html)).toContain(step);
    }
    expect(html).toContain("/app/assets/copy.js");
  });

  it("says Webhook working after the first valid delivery", async () => {
    const w = world();
    await w.ff.store.seen("x", "meeting.summarized");
    const html = await (await w.http.get(`/app/sources/${ACCOUNT_ID}`, ASSERT.reader)).text();
    expect(html).toContain("Webhook working.");
  });

  it("shows missed meetings with a Fetch again button that retries them by id", async () => {
    const w = world();
    const base = w.ff.store.get;
    const missedStore = { ...w.ff.store, get: async (e: string, id: string) => ({ ...(await base(e, id)), missed: 1, last_reason: "rate_limited" }) };
    await w.ff.store.begin(ACCOUNT_ID, "M1", "meeting.summarized", null);
    await w.ff.store.end(ACCOUNT_ID, "M1", "meeting.summarized", "failed", "rate_limited", null);
    const screens = createScreens({ fireflies: { store: missedStore, client: w.fc.client, jobs: w.jobs, pause: async () => {} } });
    const sourceRules = screens.fake.store.sourceRules;
    const app = new Hono();
    app.route("/app", makeOwnerRoutes(() => ({ ...screens.deps, store: { ...screens.fake.store, sourceRules: async (e: string, id: string) => ({ ...(await sourceRules(e, id)), source: "fireflies" }) } })));
    const http = client(app);
    const html = await (await http.get(`/app/sources/${ACCOUNT_ID}`, ASSERT.reader)).text();
    expect(shown(html)).toContain("1 meeting missed");
    expect(html).toContain("too many calls");
    expect(html).toContain(`action="/app/sources/${ACCOUNT_ID}/fireflies/retry"`);
    const res = await http.post(`/app/sources/${ACCOUNT_ID}/fireflies/retry`, { csrf: csrfIn(html) }, ASSERT.reader);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Fetching 1 meeting again");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.fc.calls.filter((c) => c.fn === "meeting").map((c) => c.arg)).toEqual(["M1"]);
  });

  it("the backfill is the owner's to start, 30 or 90 days only", async () => {
    const w = world();
    const csrf = await csrfOf(w, `/app/sources/${ACCOUNT_ID}`);
    expect((await w.http.post(`/app/sources/${ACCOUNT_ID}/fireflies/backfill`, { csrf, days: "365" }, ASSERT.reader)).status).toBe(400);
    const res = await w.http.post(`/app/sources/${ACCOUNT_ID}/fireflies/backfill`, { csrf, days: "30" }, ASSERT.reader);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("last 30 days");
    await new Promise((r) => setTimeout(r, 10));
    expect(w.fc.calls.map((c) => c.fn)).toEqual(["listSince", "meeting"]);
    expect((w.fc.calls[0]?.arg as { from: string }).from).toBe(new Date(1_800_000_000_000 - 30 * 86_400_000).toISOString());
  });

  it("disconnects", async () => {
    const w = world();
    const csrf = await csrfOf(w, `/app/sources/${ACCOUNT_ID}`);
    const res = await w.http.post(`/app/sources/${ACCOUNT_ID}/fireflies/disconnect`, { csrf }, ASSERT.reader);
    expect(res.status).toBe(200);
    expect(w.ff.calls.find((c) => c.fn === "disconnect")?.args).toEqual([READER, ACCOUNT_ID]);
  });

  it("refuses a malformed account id before any database call", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    expect((await w.http.post("/app/sources/not-an-id/fireflies/retry", { csrf }, ASSERT.reader)).status).toBe(404);
    expect(w.ff.calls.some((c) => c.fn === "missed")).toBe(false);
  });
});
