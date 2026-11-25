import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { guardEmails } from "../../src/app/email-guard.js";
import { appLayout } from "../../src/app/html.js";
import { layout } from "../../src/setup/page.js";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { makeIndexingRoutes } from "../../src/app/indexing-routes.js";
import { makePipelineRoutes } from "../../src/app/pipeline-routes.js";
import { ASSERT, PAGE_ID, client, createScreens } from "./fakes.js";

/**
 * Cloudflare's email obfuscation (on at DigitalOcean's edge) rewrote every
 * address into "[email protected]" even inside email_off markers. The pages
 * now never contain a raw address the obfuscator could match, while the
 * visible text is still the address.
 */

const RAW_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** What a browser shows: tags dropped, entities decoded. */
function visible(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#64;/g, "@")
    .replace(/&amp;/g, "&");
}

function world() {
  const screens = createScreens();
  screens.fake.state.templates = ["consulting"];
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  app.route("/setup", makeIndexingRoutes(() => screens.deps));
  app.route("/setup", makePipelineRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

describe("guardEmails", () => {
  it("splits the @ out of text with a span, and entity-encodes it in attributes, titles and text areas", () => {
    const html = '<title>pat@x.com</title><p>Mail pat.rivera@northwind-test.com now</p><input value="pat@x.com"><textarea>to: a@b.co</textarea>';
    const out = guardEmails(html);
    expect(out).not.toMatch(RAW_EMAIL);
    expect(out).toContain("<p>Mail pat.rivera<span>&#64;</span>northwind-test.com now</p>");
    expect(out).toContain('value="pat&#64;x.com"');
    expect(out).toContain("<textarea>to: a&#64;b.co</textarea>");
    expect(out).toContain("<title>pat&#64;x.com</title>");
  });

  it("leaves scripts, comments and an @ that is not an address alone, and is idempotent", () => {
    const html = '<!--email_off--><script type="application/json">{"e":"a@b.co"}</script><p>@home and 3 @ 4</p>';
    expect(guardEmails(html)).toBe(html);
    const once = guardEmails("<p>a@b.co</p>");
    expect(guardEmails(once)).toBe(once);
  });
});

describe("no raw address reaches the edge from /app or /setup", () => {
  it("app shell and setup shell", () => {
    for (const html of [appLayout("app", "/app", "Home", "<p>pat@example.com</p>"), layout("t", "<p>pat@example.com</p>")]) {
      expect(html).not.toMatch(RAW_EMAIL);
      expect(visible(html)).toContain("pat@example.com");
    }
  });

  it("the signed-in person's own email bottom left reads as the real address", async () => {
    const w = world();
    const html = await (await w.http.get("/app", ASSERT.reader)).text();
    const user = /<div class="sidebar-user">[\s\S]*?<\/div>/.exec(html)![0];
    expect(user).not.toMatch(RAW_EMAIL);
    expect(user).not.toContain("email protected");
    expect(visible(user)).toContain("reader@example.com");
  });

  it("the page list Key column, the page's Properties block and the signed-in person", async () => {
    const w = world();
    w.fake.state.page = { ...w.fake.state.page, key: "pat.rivera@northwind-test.com", drawer: "people", fields: { organisation: "northwind-test.com", owner: "owner@example.com" } };
    for (const path of ["/app", "/app/pages", `/app/pages/${PAGE_ID}`, `/app/pages/${PAGE_ID}/edit`, "/app/knowledge/people", "/setup/pipeline"]) {
      const res = await w.http.get(path, ASSERT.owner);
      const html = await res.text();
      expect(html, path).not.toMatch(RAW_EMAIL);
      expect(visible(html), path).toMatch(/owner@example\.com|reader@example\.com|admin@example\.com/);
    }
  });
});
