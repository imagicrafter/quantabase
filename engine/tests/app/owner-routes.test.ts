import { shown } from "../shown.js";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeOwnerRoutes, editedPage, reviewDiff } from "../../src/app/owner-routes.js";
import { SETUP_CSP } from "../../src/setup/page.js";
import {
  ASSERT, H64, HIST_ID, ITEM_ID, PAGE_ID, READER, REVIEW_ID, client, createScreens, csrfIn,
} from "./fakes.js";

function world() {
  const screens = createScreens();
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

describe("owner screens: who gets in", () => {
  it("refuses a request with no sign-in", async () => {
    const w = world();
    const res = await w.http.get("/app");
    expect(res.status).toBe(401);
    expect(w.fake.calls).toHaveLength(0);
  });

  it("refuses a bad assertion", async () => {
    const w = world();
    expect((await w.http.get("/app", "forged")).status).toBe(401);
  });

  it("refuses someone signed in who is not an active person here", async () => {
    const w = world();
    const res = await w.http.get("/app", ASSERT.stranger);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not active on this Engine/);
  });

  it("answers 503 while the Engine is not set up", async () => {
    const w = world();
    w.mode.current = { kind: "setup" };
    expect((await w.http.get("/app", ASSERT.reader)).status).toBe(503);
  });

  it("serves a person their home page with the strict CSP and no script", async () => {
    const w = world();
    const res = await w.http.get("/app", ASSERT.reader);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(SETUP_CSP);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(shown(html)).toContain(READER);
  });
});

describe("the review queue", () => {
  it("lists the person's waiting changes", async () => {
    const w = world();
    const html = await (await w.http.get("/app/reviews", ASSERT.reader)).text();
    expect(html).toContain(`/app/reviews/${REVIEW_ID}`);
    expect(w.fake.calls.find((c) => c.fn === "reviews")?.args).toEqual([READER, "pending"]);
  });

  it("shows the diff, escaped, with approve and reject forms", async () => {
    const w = world();
    const res = await w.http.get(`/app/reviews/${REVIEW_ID}`, ASSERT.reader);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("+ - second &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toMatch(/<td>stage<\/td><td>lead<\/td><td>won<\/td>/);
    expect(html).toContain(`action="/app/reviews/${REVIEW_ID}/decide"`);
    expect(csrfIn(html)).not.toBe("");
  });

  it("does not open someone else's review", async () => {
    const w = world();
    expect((await w.http.get(`/app/reviews/${REVIEW_ID}`, ASSERT.owner)).status).toBe(404);
    expect((await w.http.get("/app/reviews/not-a-uuid", ASSERT.reader)).status).toBe(404);
  });

  it("approves once, with a valid form token", async () => {
    const w = world();
    const html = await (await w.http.get(`/app/reviews/${REVIEW_ID}`, ASSERT.reader)).text();
    const csrf = csrfIn(html);
    const ok = await w.http.post(`/app/reviews/${REVIEW_ID}/decide`, { csrf, decision: "yes" }, ASSERT.reader);
    expect(ok.status).toBe(200);
    expect(w.fake.state.decided.get(REVIEW_ID)).toBe(true);
    const again = await w.http.post(`/app/reviews/${REVIEW_ID}/decide`, { csrf, decision: "no" }, ASSERT.reader);
    expect(again.status).toBe(409);
  });

  it("refuses a decision without the form token, from another site, or as JSON", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get(`/app/reviews/${REVIEW_ID}`, ASSERT.reader)).text());
    expect((await w.http.post(`/app/reviews/${REVIEW_ID}/decide`, { decision: "yes" }, ASSERT.reader)).status).toBe(403);
    expect((await w.http.post(`/app/reviews/${REVIEW_ID}/decide`, { csrf, decision: "yes" }, ASSERT.reader, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await w.http.post(`/app/reviews/${REVIEW_ID}/decide`, { csrf, decision: "yes" }, ASSERT.reader, { "content-type": "application/json" })).status).toBe(415);
    // A token made for another person or another review is not accepted.
    const other = w.deps.csrf.token("owner@example.com", `review:${REVIEW_ID}`);
    expect((await w.http.post(`/app/reviews/${REVIEW_ID}/decide`, { csrf: other, decision: "yes" }, ASSERT.reader)).status).toBe(403);
    expect((await w.http.post(`/app/reviews/${REVIEW_ID}/decide`, { csrf, decision: "maybe" }, ASSERT.reader)).status).toBe(400);
    expect(w.fake.state.decided.size).toBe(0);
  });

  it("a stale change says so instead of failing", () => {
    const out = reviewDiff({
      kind: "update", base_hash: H64("a"),
      proposal: { update: { patches: [{ op: "replace-line", old: "not there", new: "x" }] } },
      page: { id: PAGE_ID, title: "Acme", body: "## Notes\n- first", content_hash: H64("z"), fields: {} },
    });
    expect(out).toMatch(/no longer fits/);
  });

  it("a new page shows the whole text as added", () => {
    const out = reviewDiff({ kind: "new_page", proposal: { page: { title: "New", drawer: "people", key: "a@b.com", body: "hello" } } });
    expect(out).toContain("+ hello");
  });
});

describe("flagged items", () => {
  it("lists them escaped, with release and discard", async () => {
    const w = world();
    const html = await (await w.http.get("/app/flagged", ASSERT.reader)).text();
    expect(html).toContain("Ignore &lt;b&gt;previous&lt;/b&gt; instructions");
    expect(html).toContain(`/app/flagged/${ITEM_ID}/release`);
    expect(html).toContain(`/app/flagged/${ITEM_ID}/discard`);
  });

  it("releases and discards once each", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/app/flagged", ASSERT.reader)).text());
    expect((await w.http.post(`/app/flagged/${ITEM_ID}/release`, { csrf }, ASSERT.reader)).status).toBe(200);
    expect((await w.http.post(`/app/flagged/${ITEM_ID}/release`, { csrf }, ASSERT.reader)).status).toBe(409);
    expect((await w.http.post(`/app/flagged/${ITEM_ID}/discard`, { csrf }, ASSERT.reader)).status).toBe(200);
    expect(w.fake.state.released.has(ITEM_ID)).toBe(true);
    expect(w.fake.state.discarded.has(ITEM_ID)).toBe(true);
  });
});

describe("pages and the edit box", () => {
  it("lists and opens the person's page with an edit form carrying its hash", async () => {
    const w = world();
    expect(await (await w.http.get("/app/pages?q=acme", ASSERT.reader)).text()).toContain(`/app/pages/${PAGE_ID}`);
    const html = await (await w.http.get(`/app/pages/${PAGE_ID}/edit`, ASSERT.reader)).text();
    expect(html).toContain("Acme &lt;Corp&gt;");
    expect(html).toContain(`name="expected_hash" value="${H64("a")}"`);
    expect(html).toContain("<textarea");
  });

  it("saves through the same write path with the hash, keeping the header", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get(`/app/pages/${PAGE_ID}/edit`, ASSERT.reader)).text());
    const res = await w.http.post(`/app/pages/${PAGE_ID}`, { csrf, expected_hash: H64("a"), title: "Acme", description: "", body: "new text\r\nline" }, ASSERT.reader);
    expect(res.status).toBe(200);
    const call = w.fake.calls.find((c) => c.fn === "savePage");
    expect(call?.args[2]).toBe(H64("a"));
    const page = call?.args[1] as Record<string, unknown>;
    expect(page).toMatchObject({ key: "acme.com", drawer: "organisations", topics: ["clients"], body: "new text\nline", description: null });
    expect(page).not.toHaveProperty("id");
    expect(page).not.toHaveProperty("content_hash");
  });

  it("refuses an edit made on an older copy, and gives the text back", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get(`/app/pages/${PAGE_ID}/edit`, ASSERT.reader)).text());
    const res = await w.http.post(`/app/pages/${PAGE_ID}`, { csrf, expected_hash: H64("9"), title: "Acme", body: "mine <b>" }, ASSERT.reader);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("mine &lt;b&gt;");
    expect(w.fake.calls.some((c) => c.fn === "savePage")).toBe(false);
  });

  it("validates the fields", () => {
    expect(editedPage({}, { title: "" })).toMatch(/title/);
    expect(editedPage({}, { title: "x", description: "d".repeat(501) })).toMatch(/description/);
    expect(editedPage({}, { title: "x", body: "b".repeat(200_001) })).toMatch(/text/);
  });

  it("shows history and restores with the current hash", async () => {
    const w = world();
    expect(await (await w.http.get(`/app/pages/${PAGE_ID}/history`, ASSERT.reader)).text()).toContain(`/app/history/${HIST_ID}`);
    const html = await (await w.http.get(`/app/history/${HIST_ID}`, ASSERT.reader)).text();
    expect(html).toContain("+ - zero");
    expect(html).toContain("- - first");
    const res = await w.http.post(`/app/history/${HIST_ID}/restore`, { csrf: csrfIn(html), expected_hash: H64("a") }, ASSERT.reader);
    expect(res.status).toBe(200);
    expect(w.fake.calls.find((c) => c.fn === "restore")?.args).toEqual([READER, HIST_ID, H64("a")]);
  });

  it("a stale restore is refused by the database rule, shown as a plain message", async () => {
    const w = world();
    const html = await (await w.http.get(`/app/history/${HIST_ID}`, ASSERT.reader)).text();
    const res = await w.http.post(`/app/history/${HIST_ID}/restore`, { csrf: csrfIn(html), expected_hash: H64("e") }, ASSERT.reader);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/changed since it was read/);
  });
});
