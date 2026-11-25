import { shown } from "../shown.js";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { advancedHtml, makeIndexingRoutes } from "../../src/app/indexing-routes.js";
import { makePipelineRoutes } from "../../src/app/pipeline-routes.js";
import { makeSettingsRoutes } from "../../src/app/settings-routes.js";
import { editedProperties, lastChangeHtml } from "../../src/app/page-view.js";
import { listColumns } from "../../src/app/knowledge-routes.js";
import { fillChrome, roleLabel } from "../../src/app/chrome.js";
import { appLayout } from "../../src/app/html.js";
import { entitySchema } from "../../src/entities/templates.js";
import { ASSERT, H64, OWNER, PAGE_ID, READER, client, createScreens, csrfIn } from "./fakes.js";

function world() {
  const screens = createScreens();
  screens.fake.state.templates = ["consulting"];
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  app.route("/setup", makeSettingsRoutes(() => screens.deps));
  app.route("/setup", makeIndexingRoutes(() => screens.deps));
  app.route("/setup", makePipelineRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

const clean = (html: string) => {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
  expect(html).not.toContain("<!--kbe:");
};
const drawers = entitySchema(["consulting"]).drawers;
const orgs = drawers.find((d) => d.id === "organisations");

describe("the menu: signed-in person and the Knowledge tree", () => {
  it("shows the email and role bottom left, and the drawer tree with counts, recent and pinned", async () => {
    const w = world();
    w.fake.state.pinned = true;
    const html = await (await w.http.get("/app", ASSERT.reader)).text();
    expect(shown(html)).toMatch(/class="sidebar-user".*reader@example\.com.*role-reader">reader</s);
    expect(html).toMatch(/<details class="tree-root" open><summary>/);
    expect(html).toMatch(/href="\/app\/knowledge\/people">.*People<\/span><span class="count">1234</s);
    expect(html).toContain('href="/app/knowledge/deals"');
    expect(html).toMatch(/<summary>Pinned<\/summary>/);
    expect(html).toMatch(/<summary>Recent<\/summary>.*Acme &lt;Corp&gt;/s);
    expect(html).not.toContain("/setup/pipeline");
    clean(html);
  });

  it("an administrator also gets Pipeline and Ledger", async () => {
    const w = world();
    const html = await (await w.http.get("/app", ASSERT.owner)).text();
    expect(html).toContain('href="/setup/pipeline"');
    expect(html).toContain('href="/setup/ledger"');
    expect(html).toMatch(/role-administrator/);
  });

  it("roles read owner / administrator / reviewer / reader", () => {
    expect(roleLabel({ role: "administrator", is_owner: true })).toBe("owner");
    expect(roleLabel({ role: "administrator" })).toBe("administrator");
    expect(roleLabel({ role: "reviewer" })).toBe("reviewer");
    expect(roleLabel(null)).toBe("reader");
  });

  it("without a chrome the markers vanish and the plain Knowledge link stays", () => {
    const html = fillChrome(appLayout("app", "/app", "x", ""), undefined);
    expect(html).toContain('href="/app/knowledge"');
    expect(html).not.toContain("<!--kbe:");
  });

  it("an email in the menu cannot inject a replacement pattern", () => {
    const html = fillChrome(appLayout("app", "/app", "x", ""), { email: "a$&b@example.com", role: "reader", isAdmin: false });
    expect(shown(html)).toContain("a$&amp;b@example.com");
  });
});

describe("the Knowledge screens", () => {
  it("home: folders with counts from the tree, and the ask-Claude line", async () => {
    const w = world();
    const html = await (await w.http.get("/app/knowledge", ASSERT.reader)).text();
    expect(html).toContain("Ask your Claude to add or change knowledge; use this to check and correct it.");
    expect(html).toContain("1235 pages in");
    expect(w.fake.calls.some((c) => c.fn === "pages")).toBe(false);
    clean(html);
  });

  it("a drawer: paged, sorted list with drawer columns, stale flag, search and topic chips", async () => {
    const w = world();
    const html = await (await w.http.get("/app/knowledge/organisations?p=2&size=25&sort=title&dir=asc&topic=clients&q=acme", ASSERT.reader)).text();
    const call = w.fake.calls.find((c) => c.fn === "drawerPages");
    expect(call?.args[1]).toMatchObject({ drawer: "organisations", query: "acme", topic: "clients", sort: "title", desc: false, limit: 25, offset: 25 });
    expect(html).toContain("120 pages");
    expect(html).toMatch(/<th>role<\/th>/);
    expect(html).toContain("stale");
    expect(html).toMatch(/rel="prev"/);
    expect(html).toMatch(/rel="next"/);
    expect(html).toMatch(/<strong aria-current="page">2<\/strong>/);
    expect(html).toContain('class="chip link on"');
    expect(html).toContain("Pick a page on the left");
    expect(html).not.toMatch(/New page|Create/);
    clean(html);
  });

  it("stale is only a tag (not updated in 90 days): the page is still listed and linked, and nothing is called", async () => {
    const w = world();
    const html = await (await w.http.get("/app/knowledge/organisations", ASSERT.reader)).text();
    expect(html).toContain('<span class="badge warn" title="Not updated in 90 days">stale</span>');
    expect(html).toContain("Acme &lt;Corp&gt;");
    // Reading a drawer with a stale page makes no write, flag, review or re-index.
    const writes = w.fake.calls.filter((c) => !["whoami", "drawerPages", "knowledgeTree"].includes(c.fn));
    expect(writes).toEqual([]);
  });

  it("bad paging and sort values fall back to safe defaults", async () => {
    const w = world();
    await w.http.get("/app/knowledge/organisations?p=-4&size=9999&sort=evil&topic=Bad%20Topic", ASSERT.reader);
    expect(w.fake.calls.find((c) => c.fn === "drawerPages")?.args[1]).toMatchObject({ sort: "updated", desc: true, limit: 50, offset: 0, topic: null });
  });

  it("opens a page in the right pane (preview) and in edit mode", async () => {
    const w = world();
    const view = await (await w.http.get(`/app/knowledge/organisations?page=${PAGE_ID}`, ASSERT.reader)).text();
    expect(view).toContain('class="card properties"');
    expect(view).toMatch(/Backlinks \(1\)/);
    expect(view).toContain("Project &lt;X&gt;");
    expect(view).toContain("no page yet");
    expect(view).not.toContain("<textarea");
    const edit = await (await w.http.get(`/app/knowledge/organisations?page=${PAGE_ID}&mode=edit`, ASSERT.reader)).text();
    expect(edit).toContain("<textarea");
    expect(edit).toMatch(/<select id="f_role" name="f_role">/);
    clean(edit);
  });

  it("panes collapse by a link, no script", async () => {
    const w = world();
    const html = await (await w.http.get("/app/knowledge/organisations?list=closed", ASSERT.reader)).text();
    expect(html).toContain("list-closed");
    expect(html).toMatch(/class="pane-toggle" href="\/app\/knowledge\/organisations">Expand/);
  });

  it("an unknown drawer with no pages is 404, a bad id is 404", async () => {
    const w = world();
    expect((await w.http.get("/app/knowledge/nonsense", ASSERT.reader)).status).toBe(404);
    expect((await w.http.get("/app/knowledge/Bad!", ASSERT.reader)).status).toBe(404);
  });
});

describe("last change", () => {
  it("the page says when it last changed, by whom, from which item, with a link to the history", async () => {
    const w = world();
    w.fake.state.page = { ...w.fake.state.page, generated: { by: "curator", model: "m", at: "2026-11-18T10:00:00Z" }, sources: [{ item: "i1", source: "gmail", source_id: "t-9", version: 2 }] };
    const html = await (await w.http.get(`/app/pages/${PAGE_ID}`, ASSERT.reader)).text();
    expect(shown(html)).toMatch(/Last change/);
    expect(shown(html)).toMatch(/by Reader/);
    expect(shown(html)).toMatch(/gmail t-9 \(version 2\)/);
    expect(html).toContain(`href="/app/pages/${PAGE_ID}/history"`);
  });

  it("links straight to the diff of the version before the current one", () => {
    const out = lastChangeHtml(
      { id: PAGE_ID, updated_at: "2026-11-20T10:00:00Z", sources: [] },
      [
        { id: "h-now", saved_by: "Curator", saved_at: "2026-11-20T10:00:00Z" },
        { id: "h-before", saved_by: "Ann", saved_at: "2026-11-19T10:00:00Z" },
      ],
    );
    expect(out).toContain('href="/app/history/h-before"');
    expect(out).toContain("by Curator");
  });
});

describe("one page", () => {
  it("shows properties typed, the body rendered, and links", async () => {
    const w = world();
    w.fake.state.page = { ...w.fake.state.page, body: "## Notes\n- see [[pat@acme.com]]\n<script>x</script>", fields: { role: "client", last_contact: "2026-11-01" } };
    const html = await (await w.http.get(`/app/pages/${PAGE_ID}`, ASSERT.reader)).text();
    expect(html).toContain('<a class="wikilink" href="/app/open?key=pat%40acme.com">');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/<time datetime="2026-11-01">/);
    expect(html).toContain("summary pending");
    expect(html).toContain('action="/app/pages/' + PAGE_ID + '/pin"');
    expect(html).not.toContain("/setup/indexing/reindex");
    clean(html);
  });

  it("an administrator gets Re-index on their page", async () => {
    const w = world();
    // The owner reads the reader's page in this fake only through its own; use the reader's role switch.
    w.deps.store.whoami = async () => ({ role: "administrator", is_owner: true });
    const html = await (await w.http.get(`/app/pages/${PAGE_ID}`, ASSERT.reader)).text();
    expect(html).toContain('action="/setup/indexing/reindex"');
    expect(html).toMatch(/role-owner">owner/);
  });

  it("follows a [[link]] by key to the page", async () => {
    const w = world();
    const res = await w.http.get("/app/open?key=ACME.com", ASSERT.reader);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/app/pages/${PAGE_ID}`);
    expect((await w.http.get("/app/open?key=nobody.com", ASSERT.reader)).status).toBe(404);
  });

  it("pins and marks reviewed with the form token, and only returns into the app", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get(`/app/pages/${PAGE_ID}`, ASSERT.reader)).text());
    const res = await w.http.post(`/app/pages/${PAGE_ID}/pin`, { csrf, pin: "yes", back: "https://evil.example/" }, ASSERT.reader);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/pages/${PAGE_ID}`);
    expect(w.fake.state.pinned).toBe(true);
    const r2 = await w.http.post(`/app/pages/${PAGE_ID}/reviewed`, { csrf, back: "/app/knowledge/organisations" }, ASSERT.reader);
    expect(r2.headers.get("location")).toBe("/app/knowledge/organisations");
    expect((await w.http.post(`/app/pages/${PAGE_ID}/pin`, { pin: "yes" }, ASSERT.reader)).status).toBe(403);
  });

  it("saves properties checked against the drawer schema, through the hash-checked write", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get(`/app/pages/${PAGE_ID}/edit`, ASSERT.reader)).text());
    const form = { csrf, expected_hash: H64("a"), props: "1", title: "Acme", description: "d", status: "current", aliases: "Acme Inc", tags: "vip, north", related: "Pat@acme.com", f_role: "client", f_last_contact: "2026-11-20", body: "x" };
    const res = await w.http.post(`/app/pages/${PAGE_ID}`, form, ASSERT.reader);
    expect(res.status).toBe(200);
    const saved = w.fake.calls.find((c) => c.fn === "savePage")?.args[1] as Record<string, unknown>;
    expect(saved).toMatchObject({ key: "acme.com", status: "current", tags: ["vip", "north"], related: ["pat@acme.com"], aliases: ["Acme Inc"], fields: { role: "client", last_contact: "2026-11-20" } });
    expect(saved).not.toHaveProperty("stage");
    // The fields the person changed are marked as hand-set, so the curator asks before overwriting them.
    const marks = (saved["verified"] as Array<Record<string, unknown>>).filter((v) => v["by"] === "person").map((v) => [v["field"], v["value"]]);
    expect(marks).toEqual(expect.arrayContaining([["role", "client"], ["last_contact", "2026-11-20"]]));
    const bad = await w.http.post(`/app/pages/${PAGE_ID}`, { ...form, f_role: "emperor" }, ASSERT.reader);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/must be one of/);
  });

  it("property checks", () => {
    const cur = { key: "acme.com", status: "unreviewed", fields: { custom: 1 } };
    expect(editedProperties(cur, { status: "gone" }, orgs)).toMatch(/Status/);
    expect(editedProperties(cur, { related: "acme.com" }, orgs)).toMatch(/itself/);
    expect(editedProperties(cur, { tags: "has space" }, orgs)).toMatch(/not a valid/);
    expect(editedProperties(cur, { f_next_date: "2026-02-30" }, orgs)).toMatch(/date/);
    expect(editedProperties(cur, {}, orgs)).toMatchObject({ fields: { custom: 1 } });
    expect(editedProperties(cur, {}, undefined)).toMatchObject({ fields: { custom: 1 } });
  });

  it("list columns come from the drawer's list views", () => {
    expect(listColumns(drawers.find((d) => d.id === "deals"))).toEqual(["stage", "next_date", "value"]);
  });
});

describe("Indexing (administrators)", () => {
  it("lists uncertain decisions with the item and the three proposals", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toContain("Uncertain decisions");
    expect(html).toContain("Mail from &lt;Acme&gt;");
    // The three proposals side by side, one column per run.
    for (const h of ["Run 1", "Run 2", "Tiebreak"]) expect(html).toContain(`<th>${h}</th>`);
    expect(html).toContain("<td><code>&quot;lead&quot;</code></td><td><code>&quot;proposal&quot;</code></td><td><code>&quot;won&quot;</code></td>");
    expect(html).toContain("deepseek-v4.1-flash");
  });

  it("puts the numbers, failed items and the re-run under a collapsed Details for experts, with plain labels", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/pipeline", ASSERT.owner)).text();
    const experts = /<details class="experts"><summary>Details for experts<\/summary>(.*?)<\/details>/s.exec(html)?.[1] ?? "";
    for (const t of ["1,500", "Pages waiting for a short summary", "Items that failed", "openai-gpt-oss-120b", "gte-small", "Re-run pending summaries", "Is the timer firing?"]) {
      expect(experts).toContain(t);
    }
    expect(html).not.toMatch(/<details[^>]* open/);
    clean(html);
  });

  it("drops the old Settings card: no curator off switch, no duplicate model key link", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).not.toContain("Turn the curator off");
    expect(html).not.toContain("Turn the curator on");
    expect(html).not.toContain("Change the model key");
    expect(html).not.toContain('action="/setup/timer"');
  });

  it("shows Uncertain decisions only when consensus is on, under a collapsed Advanced section", async () => {
    // The fake Engine has consensus on: the card sits in Advanced, last on the page, collapsed.
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toMatch(/<details class="experts"><summary>Advanced<\/summary>.*Uncertain decisions/s);
    expect(html.indexOf("<summary>Advanced</summary>")).toBeGreaterThan(html.indexOf("<summary>Details for experts</summary>"));
    const cur = { model: "openai-gpt-oss-120b", tiebreak_model: "deepseek-v4.1-flash", consensus: true };
    expect(advancedHtml(cur, { uncertain: [] })).toContain("Uncertain decisions");
    // Off (the default since 0069), or not reported: no card at all.
    expect(advancedHtml({ ...cur, consensus: undefined }, {})).toBe("");
    expect(advancedHtml({ ...cur, consensus: false }, {})).toBe("");
  });

  it("refuses a reader", async () => {
    const w = world();
    expect((await w.http.get("/setup/pipeline", ASSERT.reader)).status).toBe(403);
  });

  it("re-runs summaries and re-indexes a page with the form token only", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    // the first form on the page is the curator switch (scope timer); find the indexing one
    const html = await (await w.http.get("/setup/pipeline", ASSERT.owner)).text();
    const tokens = [...html.matchAll(/name="csrf" value="([^"]+)"/g)].map((m) => m[1] ?? "");
    const idx = tokens[tokens.length - 1] ?? csrf;
    expect((await w.http.post("/setup/indexing/rerun", { csrf: idx }, ASSERT.owner)).status).toBe(200);
    expect(w.fake.calls.some((c) => c.fn === "rerunSummaries")).toBe(true);
    expect((await w.http.post("/setup/indexing/reindex", { csrf: idx, page: PAGE_ID }, ASSERT.owner)).status).toBe(200);
    expect((await w.http.post("/setup/indexing/reindex", { csrf: idx, page: "x" }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/indexing/rerun", {}, ASSERT.owner)).status).toBe(403);
    expect(OWNER).not.toBe(READER);
  });
});

describe("Indexing: failed items", () => {
  it("lists each failed item with its last error, escaped", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toContain("<h2>Items that failed</h2>");
    expect(html).toContain("Pilot &lt;SOW&gt;");
    expect(html).toContain("<td>the page has changed since it was read; read it again</td>");
    clean(html);
  });
});

describe("a broken timer (the last cron run failed)", () => {
  const brokenJobs = [
    { name: "kbe-curator-tick", schedule: "0 * * * *", active: true, last_start: "2026-11-21T07:00:00Z", last_status: "failed", last_message: "ERROR:  function public.curator_tick_poke() does not exist\nLINE 1: select ..." },
    { name: "kbe-curator-wake", schedule: "* * * * *", active: true, last_start: "2026-11-21T07:01:00Z", last_status: "succeeded" },
  ];
  const screensWithCard = ["/setup/timer", "/setup/pipeline", "/setup/health"];

  it.each(screensWithCard)("%s shows a red one-line banner with the reason", async (path) => {
    const w = world();
    w.fake.state.curatorHealth = { ...w.fake.state.curatorHealth, jobs: brokenJobs };
    const html = await (await w.http.get(path, ASSERT.owner)).text();
    expect(html).toContain('<div class="card errors" role="alert"><p>Timer is broken: Hourly safety tick failed: ERROR:  function public.curator_tick_poke() does not exist</p></div>');
    // Health carries the banner only; Timer and Indexing also turn the card red.
    if (path !== "/setup/health") expect(html).toContain("Is the timer firing? No: the last run failed");
    clean(html);
  });

  it.each(screensWithCard)("%s shows no banner while the jobs succeed", async (path) => {
    const html = await (await world().http.get(path, ASSERT.owner)).text();
    expect(html).not.toContain("Timer is broken");
  });
});
