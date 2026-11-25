import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { makeIndexingRoutes } from "../../src/app/indexing-routes.js";
import { makePipelineRoutes } from "../../src/app/pipeline-routes.js";
import { AppDeniedError, AppMissingFunctionError, type Row } from "../../src/app/store.js";
import { PIPELINE_SETTINGS } from "../../src/app/pipeline-view.js";
import { parseSearchQuery, redoEstimate, searchResultsHtml } from "../../src/app/cataloguer-view.js";
import { chartSvg, parseDays } from "../../src/app/ledger-view.js";
import { ASSERT, OWNER, client, createScreens } from "./fakes.js";

// The Cataloguer and Index clerk cards (0075). Synthetic data only.
const PIPELINE: Row = {
  is_owner: true,
  settings: { author: "best", desk_editor: "normal", archivist_bar: "normal", publisher_ask: "never", stale_days: 90, paused_until: null, summary_length: "standard" },
  curator_on: true, writer_model: "anthropic-claude-sonnet-5.5", triage_model: "openai-gpt-oss-120b", changes: {},
  last_run: { started_at: "2026-11-22T10:00:00Z", status: "ok" },
  items_waiting: 3, items_flagged: 0, items_in_month: 40, skipped_month: 12, reviews_pending: 0, duplicates_open: 0, pages: 120, pages_stale: 0,
  summaries_pending: 4, pages_indexed: 114, index_missing: 2,
  summary_run: { started_at: "2026-11-22T10:00:00Z", summaries: 6, summary_failed: 1, index_failed: 0 },
  summary_model: "openai-gpt-oss-120b", summary_usd_30d: 0.0412,
};

const PREVIEW: Row = { is_owner: true, pages: 120, avg_chars: 4000, summary_model: "openai-gpt-oss-120b", usd_30d: 0.5, summaries_30d: 100 };

const HITS: Row[] = [
  { id: "a1", key: "northwind.example", drawer: "organisations", title: "Northwind <Fixture>", is_own: false, owner_handle: "ann", description: null, fields: {}, updated_at: "2026-11-01T00:00:00Z", score: 0.0328 },
  { id: "a2", key: "northwind.example", drawer: "organisations", title: "Northwind (mine)", is_own: true, owner_handle: "me", description: null, fields: {}, updated_at: "2026-11-01T00:00:00Z", score: 0.03 },
  ...["b", "c", "d", "e", "f"].map((k, i) => ({ id: k, key: `${k}.example`, drawer: "projects", title: `Project ${k.toUpperCase()}`, is_own: true, owner_handle: "me", description: null, fields: {}, updated_at: "2026-11-01T00:00:00Z", score: 0.02 - i * 0.001 })),
];

type Over = { pipeline?: Row; preview?: Row; tickets?: Row[]; redo?: (e: string) => Promise<number>; hits?: Row[]; embed?: boolean };

function world(over: Over = {}) {
  const screens = createScreens(over.embed === false ? {} : { embed: vi.fn(async () => new Array(384).fill(0.01)) });
  const search = vi.fn(async () => over.hits ?? HITS);
  const redo = vi.fn(over.redo ?? (async () => 120));
  const deps = screens.deps as { store: typeof screens.fake.store };
  deps.store = {
    ...screens.fake.store,
    pipeline: async () => over.pipeline ?? PIPELINE,
    tickets: async () => over.tickets ?? [],
    indexSearch: search,
    redoPreview: async () => over.preview ?? PREVIEW,
    redoSummaries: redo,
  };
  const app = new Hono();
  app.route("/setup", makeIndexingRoutes(() => screens.deps));
  app.route("/setup", makePipelineRoutes(() => screens.deps));
  return { ...screens, search, redo, http: client(app) };
}

const cardsOf = (html: string): Record<string, string> =>
  Object.fromEntries([...html.matchAll(/<li class="step[^"]*">.*?<strong>(?:<a [^>]+>)?([^<]+).*?<\/li>/gs)].map((m) => [m[1], m[0]]));
const searchToken = (html: string) => /action="\/setup\/pipeline\/search"><input type="hidden" name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const redoToken = (html: string) => /action="\/setup\/pipeline\/redo"><input type="hidden" name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const clean = (html: string) => {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
};

describe("the twelve cards", () => {
  it("adds the Cataloguer and the Index clerk after the Publisher, numbered 1 to 12", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    const names = [...html.matchAll(/<li class="step[^"]*">.*?<strong>(?:<a [^>]+>)?([^<]+)/gs)].map((m) => m[1]);
    expect(names).toEqual([
      "Subscriptions", "Mailroom", "New mail alert", "Desk editor",
      "Archivist", "Author", "Fact-checker", "Publisher",
      "Cataloguer", "Index clerk", "Librarian", "Reading room",
    ]);
    const numbers = [...html.matchAll(/<span class="step-no" aria-label="Step (\d+)">/g)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(html).toContain("these twelve steps");
    clean(html);
  });

  it("the Cataloguer shows what waits, what was done and what failed, and the summary length choice", async () => {
    const card = cardsOf(await (await world().http.get("/setup/pipeline", ASSERT.owner)).text())["Cataloguer"] ?? "";
    expect(card).toContain("4 pages waiting for a summary");
    expect(card).toContain("6 done and 1 failed in the last run");
    expect(card).toContain('name="setting" value="summary_length"');
    expect(card).toContain(">Short</button>");
    expect(card).toContain(">Standard</button>");
    expect(card).toMatch(/aria-pressed="true" title="[^"]*">Standard<\/button>/);
    expect(card).toContain('class="light warn"');
    // The model and the cost are for experts, not the card.
    expect(card).not.toMatch(/openai|gpt|\$/);
  });

  it("the summary length choice is short and plain, like every other choice", () => {
    const def = PIPELINE_SETTINGS.find((d) => d.id === "summary_length");
    expect(def?.choices.map((c) => c.value)).toEqual(["short", "standard"]);
    for (const c of def?.choices ?? []) {
      expect(c.effect.length).toBeLessThanOrEqual(60);
      expect(c.effect).not.toMatch(/[0-9$%]/);
    }
  });

  it("the Index clerk shows pages in the index, waiting and missing, and a try-a-search box (no settings)", async () => {
    const card = cardsOf(await (await world().http.get("/setup/pipeline", ASSERT.owner)).text())["Index clerk"] ?? "";
    expect(card).toContain("114 pages in the search index");
    expect(card).toContain("4 waiting");
    expect(card).toContain("2 missing");
    expect(card).toContain('action="/setup/pipeline/search"');
    expect(card).toContain('name="q"');
    expect(card).not.toContain('name="setting"');
    expect(card).not.toMatch(/gte-small|embedding model/i);
  });

  it("an administrator who is not the owner still gets the search box but no summary choice", async () => {
    const html = await (await world({ pipeline: { ...PIPELINE, is_owner: false } }).http.get("/setup/pipeline", ASSERT.owner)).text();
    const cards = cardsOf(html);
    expect(cards["Cataloguer"]).not.toContain('class="seg"');
    expect(cards["Cataloguer"]).toContain('<p class="tune-value"><strong>Standard</strong></p>');
    expect(cards["Index clerk"]).toContain('action="/setup/pipeline/search"');
    expect(html).not.toContain('href="/setup/pipeline/redo"');
  });

  it("puts a summary or index fault on its own card as Needs you", async () => {
    const tickets = [
      { ref: "QB-0021", step: "cataloguer", kind: "summary_failed", status: "open", cleared_at: null },
      { ref: "QB-0022", step: "index_clerk", kind: "index_failed", status: "open", cleared_at: null },
    ];
    const cards = cardsOf(await (await world({ tickets }).http.get("/setup/pipeline", ASSERT.owner)).text());
    expect(cards["Cataloguer"]).toContain('href="/app/tickets/QB-0021"');
    expect(cards["Index clerk"]).toContain('href="/app/tickets/QB-0022"');
    expect(cards["Publisher"]).not.toContain("needs-you");
  });

  it("Details for experts names the summary model, its cost over thirty days and the search model", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    const experts = /<summary>Details for experts<\/summary>(.*?)<\/details>/s.exec(html)?.[1] ?? "";
    expect(experts).toContain("Cataloguer and Index clerk");
    expect(experts).toContain("openai-gpt-oss-120b");
    expect(experts).toContain("$0.0412");
    expect(experts).toContain("gte-small");
    expect(experts).toContain('href="/setup/pipeline/redo"');
  });

  it("an older database without the new counts still draws twelve cards", async () => {
    const old = { ...PIPELINE };
    for (const k of ["summaries_pending", "pages_indexed", "index_missing", "summary_run", "summary_model", "summary_usd_30d"]) delete old[k];
    const html = await (await world({ pipeline: old }).http.get("/setup/pipeline", ASSERT.owner)).text();
    expect([...html.matchAll(/<li class="step/g)]).toHaveLength(12);
  });
});

describe("Try a search", () => {
  it("shows the top five pages, one per key with the person's own page first, title and score", async () => {
    const w = world();
    const csrf = searchToken(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    const res = await w.http.post("/setup/pipeline/search", { csrf, q: "  northwind widgets " }, ASSERT.owner);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(w.search).toHaveBeenCalledWith(OWNER, "northwind widgets", expect.any(Array), 5);
    const results = /<div class="card" id="try-search">(.*?)<\/div>/s.exec(html)?.[1] ?? "";
    const rows = [...results.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => m[1] ?? "");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("Northwind (mine)");
    expect(rows[0]).toContain("0.0300");
    expect(results).not.toContain("Northwind &lt;Fixture&gt;");
    expect(results).toContain("northwind widgets");
    expect(html).toContain('value="northwind widgets"');
    clean(html);
  });

  it("says so when nothing comes back", async () => {
    const w = world({ hits: [] });
    const csrf = searchToken(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    const html = await (await w.http.post("/setup/pipeline/search", { csrf, q: "nothing here" }, ASSERT.owner)).text();
    expect(html).toContain("No pages came back");
  });

  it("refuses without the token, from another site, an empty or too long question, and for a reader", async () => {
    const w = world();
    const csrf = searchToken(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    expect((await w.http.post("/setup/pipeline/search", { q: "x" }, ASSERT.owner)).status).toBe(403);
    expect((await w.http.post("/setup/pipeline/search", { csrf, q: "x" }, ASSERT.owner, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await w.http.post("/setup/pipeline/search", { csrf, q: "   " }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/pipeline/search", { csrf, q: "x".repeat(201) }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/pipeline/search", { csrf, q: "x" }, ASSERT.reader)).status).toBe(403);
    expect(w.search).not.toHaveBeenCalled();
  });

  it("without the embed function it says search is not ready", async () => {
    const w = world({ embed: false });
    const csrf = searchToken(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    expect((await w.http.post("/setup/pipeline/search", { csrf, q: "x" }, ASSERT.owner)).status).toBe(503);
  });

  it("before 0075 is applied it says a database update is needed", async () => {
    const w = world();
    const deps = w.deps as { store: Record<string, unknown> };
    deps.store = { ...deps.store, indexSearch: async () => Promise.reject(new AppMissingFunctionError("app_index_search")) };
    const csrf = searchToken(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    expect((await w.http.post("/setup/pipeline/search", { csrf, q: "x" }, ASSERT.owner)).status).toBe(503);
  });

  it("parses the question strictly", () => {
    expect(parseSearchQuery("  a b ")).toBe("a b");
    expect(parseSearchQuery("")).toBeNull();
    expect(parseSearchQuery(undefined)).toBeNull();
    expect(parseSearchQuery("x".repeat(201))).toBeNull();
  });

  it("escapes titles in the results", () => {
    const html = searchResultsHtml("<q>", [{ ...HITS[0], is_own: true } as Row]);
    expect(html).toContain("Northwind &lt;Fixture&gt;");
    expect(html).toContain("&lt;q&gt;");
    expect(html).not.toContain("<Fixture>");
  });
});

describe("Redo summaries and index", () => {
  it("the owner first sees how many pages and the estimated cost, and must confirm", async () => {
    const w = world();
    const res = await w.http.get("/setup/pipeline/redo", ASSERT.owner);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("120 pages");
    expect(html).toContain("$0.600"); // 120 pages at the observed $0.005 a summary
    expect(html).toContain('name="confirm" value="yes"');
    expect(w.redo).not.toHaveBeenCalled();
    clean(html);
  });

  it("queues the pages after the confirm click", async () => {
    const w = world();
    const csrf = redoToken(await (await w.http.get("/setup/pipeline/redo", ASSERT.owner)).text());
    const res = await w.http.post("/setup/pipeline/redo", { csrf, confirm: "yes" }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("120 pages are queued");
    expect(w.redo).toHaveBeenCalledWith(OWNER);
  });

  it("refuses without the token, without the confirm, from another site, and for a reader", async () => {
    const w = world();
    const csrf = redoToken(await (await w.http.get("/setup/pipeline/redo", ASSERT.owner)).text());
    expect((await w.http.post("/setup/pipeline/redo", { confirm: "yes" }, ASSERT.owner)).status).toBe(403);
    expect((await w.http.post("/setup/pipeline/redo", { csrf }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/pipeline/redo", { csrf, confirm: "yes" }, ASSERT.owner, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await w.http.post("/setup/pipeline/redo", { csrf, confirm: "yes" }, ASSERT.reader)).status).toBe(403);
    expect((await w.http.get("/setup/pipeline/redo", ASSERT.reader)).status).toBe(403);
    expect(w.redo).not.toHaveBeenCalled();
  });

  it("is the owner's alone: another administrator is refused, and so is anyone the database refuses", async () => {
    const other = world({ preview: { ...PREVIEW, is_owner: false } });
    expect((await other.http.get("/setup/pipeline/redo", ASSERT.owner)).status).toBe(403);
    const csrf = redoToken(await (await world().http.get("/setup/pipeline/redo", ASSERT.owner)).text());
    expect((await other.http.post("/setup/pipeline/redo", { csrf, confirm: "yes" }, ASSERT.owner)).status).toBe(403);
    expect(other.redo).not.toHaveBeenCalled();
    const denied = world({ redo: async () => Promise.reject(new AppDeniedError("not allowed")) });
    const t = redoToken(await (await denied.http.get("/setup/pipeline/redo", ASSERT.owner)).text());
    expect((await denied.http.post("/setup/pipeline/redo", { csrf: t, confirm: "yes" }, ASSERT.owner)).status).toBe(403);
  });

  it("estimates from the observed cost, else from the price table, else says not known", () => {
    expect(redoEstimate(PREVIEW)).toBeCloseTo(0.6, 6);
    const priced = redoEstimate({ ...PREVIEW, usd_30d: 0, summaries_30d: 0 });
    expect(priced).not.toBeNull();
    expect(priced ?? 0).toBeGreaterThan(0);
    expect(redoEstimate({ ...PREVIEW, usd_30d: 0, summaries_30d: 0, summary_model: "unknown-model" })).toBeNull();
    expect(redoEstimate({ ...PREVIEW, pages: 0 })).toBe(0);
  });
});

describe("the Ledger's Cataloguer line", () => {
  it("draws the Cataloguer as its own bar and names it in the legend", () => {
    const days = parseDays([{ day: "2026-11-03", author_usd: 1, cataloguer_usd: 0.2, other_usd: 0.1 }]);
    expect(days).toEqual([{ day: "2026-11-03", author: 1, cataloguer: 0.2, other: 0.1 }]);
    const svg = chartSvg(days, [], 30, "2026-11-01T00:00:00.000Z");
    expect(svg.match(/class="bar-cataloguer"/g)?.length).toBe(1);
    expect(svg).toContain("Cataloguer $0.200");
    expect(svg).toContain('<span class="key cataloguer"></span> Cataloguer');
  });

  it("shows this month's Cataloguer spend on the Ledger", async () => {
    const w = world();
    const deps = w.deps as { store: Record<string, unknown> };
    deps.store = {
      ...deps.store,
      ledger: async () => ({
        is_owner: true, since: "2026-11-01T00:00:00Z", now: "2026-11-11T00:00:00Z", spent_usd: 10, budget_usd: 25, budget_pct: 80,
        budget_action: "warn", items_in: 1, items_done: 1, items_skipped: 0, cataloguer_usd: 0.42, days: [], changes: [],
      }),
    };
    const html = await (await w.http.get("/setup/ledger", ASSERT.owner)).text();
    expect(html).toContain("Cataloguer (page summaries)");
    expect(html).toContain("$0.420");
  });
});
