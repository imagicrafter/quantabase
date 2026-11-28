import { shown } from "../shown.js";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { AppMissingFunctionError } from "../../src/app/store.js";
import { ACCOUNT_ID, ASSERT, OTHER_ACCOUNT, OWNER, PAGE_ID, READER, RULE_ID, client, createScreens, csrfIn } from "./fakes.js";

function world() {
  const screens = createScreens();
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

const base = `/app/sources/${ACCOUNT_ID}`;

async function csrfOf(w: ReturnType<typeof world>, path = base) {
  return csrfIn(await (await w.http.get(path, ASSERT.reader)).text());
}

describe("Sources: a person's own accounts", () => {
  it("lists only the signed-in person's accounts, with rule counts", async () => {
    const w = world();
    const html = await (await w.http.get("/app/sources", ASSERT.reader)).text();
    expect(shown(html)).toContain("reader@work.example");
    expect(html).toContain(`href="/app/sources/${ACCOUNT_ID}"`);
    expect(w.fake.calls.find((c) => c.fn === "sourceAccounts")?.args).toEqual([READER]);
  });

  it("an administrator sees only their own accounts here (none), never another person's", async () => {
    const w = world();
    const html = await (await w.http.get("/app/sources", ASSERT.owner)).text();
    expect(html).not.toContain(ACCOUNT_ID);
    expect(w.fake.calls.find((c) => c.fn === "sourceAccounts")?.args).toEqual([OWNER]);
  });

  it("an administrator cannot open another person's rules", async () => {
    const w = world();
    const res = await w.http.get(base, ASSERT.owner);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("@acme.com");
  });

  it("refuses a malformed account id before any database call", async () => {
    const w = world();
    expect((await w.http.get("/app/sources/../etc", ASSERT.reader)).status).toBe(404);
    expect(w.fake.calls.some((c) => c.fn === "sourceRules")).toBe(false);
  });

  it("adds an account and lists pages to re-check", async () => {
    const w = world();
    const html = await (await w.http.get("/app/sources", ASSERT.reader)).text();
    expect(html).toContain(`/app/sources/pages/${PAGE_ID}/done`);
    const res = await w.http.post("/app/sources/add", { csrf: csrfIn(html), source: "gmail", account: "Reader@Work.example" }, ASSERT.reader);
    expect(res.status).toBe(303);
    expect(w.fake.calls.find((c) => c.fn === "addSourceAccount")?.args).toEqual([READER, "gmail", "reader@work.example"]);
    const bad = await w.http.post("/app/sources/add", { csrf: csrfIn(html), source: "slack", account: "a@b.co" }, ASSERT.reader);
    expect(bad.status).toBe(400);
  });
});

describe("Sources: Claude Code sessions", () => {
  it("shows how many sessions the person sent and how to send one", async () => {
    const w = world();
    const html = await (await w.http.get("/app/sources", ASSERT.reader)).text();
    const text = shown(html);
    expect(text).toContain("Claude Code sessions");
    expect(text).toContain("3 sessions sent");
    expect(text).toContain("5 notes in all");
    expect(text).toContain("/qb-engine:send-session");
    expect(w.fake.calls.find((c) => c.fn === "sourceSummary")?.args).toEqual([READER, "claude-code"]);
  });

  it("before 0076 is applied the page still works and says an update is needed", async () => {
    const w = world();
    const deps = w.deps as { store: Record<string, unknown> };
    deps.store = { ...deps.store, sourceSummary: async () => Promise.reject(new AppMissingFunctionError("app_source_summary")) };
    const res = await w.http.get("/app/sources", ASSERT.reader);
    expect(res.status).toBe(200);
    const text = shown(await res.text());
    expect(text).toContain("needs an update before it can take Claude Code sessions");
    expect(text).toContain("reader@work.example");
  });

  it("says none sent yet for a person who has not sent one", async () => {
    const w = world();
    const text = shown(await (await w.http.get("/app/sources", ASSERT.owner)).text());
    expect(text).toContain("No sessions sent yet");
    expect(w.fake.calls.find((c) => c.fn === "sourceSummary")?.args).toEqual([OWNER, "claude-code"]);
  });
});

describe("Sources: the rule list", () => {
  it("shows the rules in order, the picker, held topics and suggested excludes; escapes values", async () => {
    const w = world();
    const html = await (await w.http.get(base, ASSERT.reader)).text();
    expect(shown(html)).toContain("@acme.com");
    expect(html).toContain('name="label" value="Label_1"');
    expect(html).toContain("Clients &lt;Acme&gt;");
    expect(html).not.toContain("Clients <Acme>");
    expect(html).toContain('value="topic:clients"');
    expect(html).toContain('value="private"');
    expect(shown(html)).toContain("Suggested excludes");
    // The one script is the same-origin copy-button helper; never an inline one.
    expect(html.replace('<script src="/app/assets/copy.js" defer></script>', "")).not.toMatch(/<script/i);
  });

  it("lays out the rule builder on the left and the ordered rules on the right", async () => {
    const w = world();
    const html = await (await w.http.get(base, ASSERT.reader)).text();
    const left = html.indexOf('class="rules-builder"');
    const right = html.indexOf('class="rules-list"');
    expect(html).toContain('class="rules-split"');
    expect(left).toBeGreaterThan(-1);
    expect(right).toBeGreaterThan(left);
    expect(html.indexOf("Add a rule")).toBeGreaterThan(left);
    expect(html.indexOf("Add a rule")).toBeLessThan(right);
  });

  it("saving stays on the same screen: the new rule shows on the right, the version as a small note", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    const res = await w.http.post(`${base}/rules`, { csrf, op: "add", version: "1", kind: "exclude", name: "Personal", label: ["Label_9"] }, ASSERT.reader);
    const html = await (await w.http.get(res.headers.get("location")!, ASSERT.reader)).text();
    expect(shown(html)).not.toContain("Rules saved");
    expect(html).toMatch(/class="hint saved-note"[^>]*>Saved\. Version 2 is in force\./);
    expect(html.slice(html.indexOf('class="rules-list"'))).toContain("Personal");
  });

  it("ignores a saved note that is not a version number", async () => {
    const w = world();
    const html = await (await w.http.get(`${base}?saved=%3Cb%3E`, ASSERT.reader)).text();
    expect(html).not.toContain("saved-note");
  });

  it("an exclude applies at once (it only narrows)", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    const res = await w.http.post(`${base}/rules`, { csrf, op: "add", version: "1", kind: "exclude", name: "Personal", label: ["Label_9"] }, ASSERT.reader);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${base}?saved=2`);
    const saved = w.fake.state.savedRules[0]!;
    expect(saved.expected).toBe(1);
    expect(saved.rules).toHaveLength(2);
    expect(saved.rules[1]).toEqual({ kind: "exclude", name: "Personal", match: { labels: [{ id: "Label_9" }] } });
    // The existing rule goes back without display-only keys.
    expect(saved.rules[0]).not.toHaveProperty("broken");
    expect((saved.rules[0] as { id: string }).id).toBe(RULE_ID);
  });

  it("a new include to a topic shows a dry-run and needs a yes", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    const res = await w.http.post(
      `${base}/rules`,
      { csrf, op: "add", version: "1", kind: "include", name: "Board", target: "topic:board", label: ["Label_1"], from: "chair@board.example" },
      ASSERT.reader,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(shown(html)).toContain("Dry-run on the last 7 days");
    expect(html).toContain('name="op" value="confirm"');
    expect(w.fake.state.savedRules).toHaveLength(0);
    const rules = /name="rules" value="([^"]*)"/.exec(html)?.[1] ?? "";
    const confirm = await w.http.post(`${base}/rules`, { csrf: csrfIn(html), op: "confirm", version: "1", rules: rules.replace(/&quot;/g, '"').replace(/&#64;/g, "@").replace(/&amp;/g, "&") }, ASSERT.reader);
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get("location")).toBe(`${base}?saved=2`);
    const saved = w.fake.state.savedRules[0]!.rules as Array<Record<string, unknown>>;
    expect(saved[1]).toMatchObject({ kind: "include", topic: "board", match: { from: ["chair@board.example"], labels: [{ id: "Label_1" }] } });
  });

  it("refuses a topic the person does not hold, an unknown label or a bad address", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    for (const extra of [
      { target: "topic:secret", from: "a@b.co" },
      { target: "private", label: ["Label_404"] },
      { target: "private", from: "not an address" },
      { target: "private" },
    ]) {
      const res = await w.http.post(`${base}/rules`, { csrf, op: "add", version: "1", kind: "include", ...extra }, ASSERT.reader);
      expect(res.status).toBe(400);
    }
    expect(w.fake.state.savedRules).toHaveLength(0);
  });

  it("moving a rule to private applies at once; moving it to a topic needs a yes", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    await w.http.post(`${base}/rules`, { csrf, op: "target", index: "0", version: "1", target: "private" }, ASSERT.reader);
    expect(w.fake.state.savedRules[0]!.rules[0]).toMatchObject({ private: true });
    expect(w.fake.state.savedRules[0]!.rules[0]).not.toHaveProperty("topic");
    const res = await w.http.post(`${base}/rules`, { csrf, op: "target", index: "0", version: "2", target: "topic:board" }, ASSERT.reader);
    expect(await res.text()).toContain('name="op" value="confirm"');
    expect(w.fake.state.savedRules).toHaveLength(1);
  });

  it("a stale version is refused with a plain message", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    const res = await w.http.post(`${base}/rules`, { csrf, op: "target", index: "0", version: "0", target: "private" }, ASSERT.reader);
    expect(res.status).toBe(400);
    expect(shown(await res.text())).toMatch(/open them again/);
  });

  it("refuses a form without its csrf token", async () => {
    const w = world();
    const res = await w.http.post(`${base}/rules`, { csrf: "forged", op: "delete", index: "0", version: "1" }, ASSERT.reader);
    expect(res.status).toBe(403);
    expect(w.fake.state.savedRules).toHaveLength(0);
  });
});

describe("Sources: dry-run, history, re-check, backfill", () => {
  it("dry-run shows counts and metadata only", async () => {
    const w = world();
    const html = await (await w.http.get(`${base}/preview`, ASSERT.reader)).text();
    expect(shown(html)).toMatch(/Of 2 items in the sample/);
    expect(shown(html)).toContain("bob@acme.com");
  });

  it("history shows versions and the audit", async () => {
    const w = world();
    const html = await (await w.http.get(`${base}/history`, ASSERT.reader)).text();
    expect(shown(html)).toContain("Version 1");
    expect(shown(html)).toContain("rules_saved");
  });

  it("another person's history, dry-run or re-check is refused", async () => {
    const w = world();
    expect((await w.http.get(`/app/sources/${OTHER_ACCOUNT}/history`, ASSERT.reader)).status).toBe(403);
    expect((await w.http.get(`/app/sources/${OTHER_ACCOUNT}/preview`, ASSERT.reader)).status).toBe(403);
  });

  it("re-check, backfill and sample go to the database for the caller", async () => {
    const w = world();
    const csrf = await csrfOf(w);
    expect((await w.http.post(`${base}/recheck`, { csrf }, ASSERT.reader)).status).toBe(200);
    expect((await w.http.post(`${base}/backfill`, { csrf, since: "2026-10-01" }, ASSERT.reader)).status).toBe(200);
    expect((await w.http.post(`${base}/backfill`, { csrf, since: "soon" }, ASSERT.reader)).status).toBe(400);
    expect((await w.http.post(`${base}/sample`, { csrf }, ASSERT.reader)).status).toBe(200);
    expect(w.fake.calls.find((c) => c.fn === "backfillSource")?.args).toEqual([READER, ACCOUNT_ID, "2026-10-01T00:00:00Z"]);
  });
});
