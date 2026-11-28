import { shown } from "../shown.js";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { ACCOUNT_ID, ASSERT, OTHER_ACCOUNT, READER, client, createScreens, csrfIn } from "./fakes.js";

function world() {
  const screens = createScreens();
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

const base = `/app/sources/${ACCOUNT_ID}`;

async function open(w: ReturnType<typeof world>) {
  const res = await w.http.get(base, ASSERT.reader);
  return { res, html: await res.text() };
}

/** The suggestions card only, so other cards' boxes do not count. */
function cardOf(html: string): string {
  const start = html.indexOf("Suggested from your mail");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('<div class="card', start));
}

const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&#64;/g, "@").replace(/&amp;/g, "&");

describe("Sources: suggested from your mail", () => {
  it("shows domains and people with counts; strong ones ticked, weak ones not, ones with a rule marked", async () => {
    const w = world();
    const { html } = await open(w);
    const card = cardOf(html);
    expect(w.fake.calls.find((c) => c.fn === "mailContacts")?.args).toEqual([READER, ACCOUNT_ID]);
    expect(card).toMatch(/name="pick" value="domain:beta\.example" checked/);
    expect(card).toMatch(/name="pick" value="address:carol&#64;beta\.example" checked/);
    expect(card).toMatch(/name="pick" value="domain:gamma\.example">/);
    expect(card).toMatch(/name="pick" value="address:pat&#64;gmail\.com">/);
    // acme.com already has the rule "Acme": no box, a note instead.
    expect(card).not.toContain('value="domain:acme.com"');
    expect(shown(card)).toContain("has a rule: Acme");
    const text = shown(card);
    expect(text).toContain("sent 4");
    expect(text).toContain("2 people");
    expect(text).toContain("person only");
    expect(text).toContain("120 messages");
  });

  it("places the card in the rule builder column and lets the copy button work with a same-origin script only", async () => {
    const w = world();
    const { res, html } = await open(w);
    const left = html.indexOf('class="rules-builder"');
    expect(html.indexOf("Suggested from your mail")).toBeGreaterThan(left);
    expect(html.indexOf("Suggested from your mail")).toBeLessThan(html.indexOf('class="rules-list"'));
    expect(html).toContain('<script src="/app/assets/copy.js" defer></script>');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  });

  it("with no suggestions yet, gives the prompt to paste into Claude, with a copy button", async () => {
    const w = world();
    w.fake.state.mailContacts = { reported_at: null, days: null, messages: null, contacts: [] };
    const card = cardOf((await open(w)).html);
    expect(shown(card)).toContain("/qb-engine:suggest-rules reader@work.example");
    expect(card).toMatch(/data-copy="\/qb-engine:suggest-rules reader&#64;work\.example[^"]*"/);
    expect(card).not.toContain('name="pick"');
  });

  it("ticks exactly what the person picked in Claude, when they picked", async () => {
    const w = world();
    const contacts = (w.fake.state.mailContacts!["contacts"] as Array<Record<string, unknown>>).map((c) => ({
      ...c, chosen: c["value"] === "gamma.example" || c["value"] === "pat@gmail.com",
    }));
    w.fake.state.mailContacts = { ...w.fake.state.mailContacts!, contacts };
    const card = cardOf((await open(w)).html);
    expect(card).toMatch(/name="pick" value="domain:gamma\.example" checked/);
    expect(card).toMatch(/name="pick" value="address:pat&#64;gmail\.com" checked/);
    // Sent to 3+ times, but not picked: not ticked.
    expect(card).toMatch(/name="pick" value="domain:beta\.example">/);
    expect(shown(card)).toContain("Ticked: what you picked in Claude");
  });

  it("shows the age of suggestions older than 30 days", async () => {
    const w = world();
    w.fake.state.mailContacts = { ...w.fake.state.mailContacts!, reported_at: new Date(Date.now() - 45 * 86_400_000).toISOString() };
    expect(shown(cardOf((await open(w)).html))).toMatch(/45 days old/);
    const fresh = world();
    expect(shown(cardOf((await open(fresh)).html))).not.toMatch(/days old/);
  });

  it("before 0080 is applied the page still works and says an update is needed", async () => {
    const w = world();
    w.fake.state.mailContacts = null;
    const { res, html } = await open(w);
    expect(res.status).toBe(200);
    expect(shown(cardOf(html))).toContain("needs an update");
  });
});

describe("Sources: saving suggested rules goes through the ordinary rule save", () => {
  it("private: one rule per domain and one for the people, saved at once", async () => {
    const w = world();
    const csrf = csrfIn((await open(w)).html);
    const res = await w.http.post(
      `${base}/suggested`,
      { csrf, version: "1", target: "private", pick: ["domain:beta.example", "address:carol@beta.example", "address:pat@gmail.com"] },
      ASSERT.reader,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${base}?saved=2`);
    const saved = w.fake.state.savedRules[0]!;
    expect(saved.expected).toBe(1);
    expect(saved.rules).toHaveLength(3);
    expect(saved.rules[1]).toEqual({ kind: "include", name: "beta.example", match: { any_address: ["@beta.example"] }, private: true });
    expect(saved.rules[2]).toEqual({
      kind: "include", name: "People from your mail", match: { any_address: ["carol@beta.example", "pat@gmail.com"] }, private: true,
    });
  });

  it("to a topic: the dry-run and an explicit yes come first", async () => {
    const w = world();
    const csrf = csrfIn((await open(w)).html);
    const res = await w.http.post(`${base}/suggested`, { csrf, version: "1", target: "topic:clients", pick: ["domain:beta.example"] }, ASSERT.reader);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(shown(html)).toContain("Dry-run on the last 7 days");
    expect(shown(html)).toContain("beta.example");
    expect(w.fake.state.savedRules).toHaveLength(0);
    const rules = /name="rules" value="([^"]*)"/.exec(html)?.[1] ?? "";
    const confirm = await w.http.post(`${base}/rules`, { csrf: csrfIn(html), op: "confirm", version: "1", rules: unescape(rules) }, ASSERT.reader);
    expect(confirm.status).toBe(303);
    expect(w.fake.state.savedRules[0]!.rules[1]).toMatchObject({ kind: "include", topic: "clients", match: { any_address: ["@beta.example"] } });
  });

  it("refuses nothing ticked, a value that is not a suggestion, one that already has a rule, and a topic not held", async () => {
    const w = world();
    const csrf = csrfIn((await open(w)).html);
    for (const extra of [
      { target: "private" },
      { target: "private", pick: ["domain:evil.example"] },
      { target: "private", pick: ["domain:acme.com"] },
      { target: "private", pick: ["nonsense"] },
      { target: "topic:secret", pick: ["domain:beta.example"] },
    ]) {
      const res = await w.http.post(`${base}/suggested`, { csrf, version: "1", ...extra }, ASSERT.reader);
      expect(res.status).toBe(400);
    }
    expect(w.fake.state.savedRules).toHaveLength(0);
  });

  it("refuses another person's account and a form without its csrf token", async () => {
    const w = world();
    const csrf = csrfIn((await open(w)).html);
    const other = await w.http.post(`/app/sources/${OTHER_ACCOUNT}/suggested`, { csrf, version: "1", target: "private", pick: ["domain:beta.example"] }, ASSERT.reader);
    expect(other.status).toBe(403);
    const forged = await w.http.post(`${base}/suggested`, { csrf: "forged", version: "1", target: "private", pick: ["domain:beta.example"] }, ASSERT.reader);
    expect(forged.status).toBe(403);
    expect(w.fake.state.savedRules).toHaveLength(0);
  });
});

describe("Sources home: plain words first, and a prompt per Gmail account", () => {
  it("opens with what rules do, that they replaced source tags, and how to start for Gmail", async () => {
    const w = world();
    const res = await w.http.get("/app/sources", ASSERT.reader);
    const html = await res.text();
    const text = shown(html);
    expect(text).toContain("Rules decide what your library keeps");
    expect(text).toContain("Nothing is kept unless an include rule lets it in");
    expect(text).toContain("source tags");
    expect(text.indexOf("Rules decide")).toBeLessThan(text.indexOf("Your source accounts"));
  });

  it("gives each Gmail account a prompt to paste into Claude, with a copy button and a same-origin script", async () => {
    const w = world();
    const res = await w.http.get("/app/sources", ASSERT.reader);
    const html = await res.text();
    expect(shown(html)).toContain("/qb-engine:suggest-rules reader@work.example");
    expect(html).toMatch(/<button type="button" class="copy" data-copy="\/qb-engine:suggest-rules reader&#64;work\.example[^"]*">Copy<\/button>/);
    expect(html).toContain('<script src="/app/assets/copy.js" defer></script>');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("with no Gmail account, shows no prompt and loads no script", async () => {
    const w = world();
    const res = await w.http.get("/app/sources", ASSERT.stranger);
    const html = await res.text();
    expect(html).not.toContain("data-copy");
    expect(html).not.toMatch(/<script/i);
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
  });
});
