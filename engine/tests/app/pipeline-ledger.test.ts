import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { makeIndexingRoutes } from "../../src/app/indexing-routes.js";
import { makePipelineRoutes } from "../../src/app/pipeline-routes.js";
import { AppDeniedError, AppMissingFunctionError, type Row } from "../../src/app/store.js";
import { budgetState, chartSvg, monthProgress, parseDays, projected } from "../../src/app/ledger-view.js";
import { PIPELINE_SETTINGS, SETTING_IDS } from "../../src/app/pipeline-view.js";
import { ASSERT, OWNER, READER, client, createScreens } from "./fakes.js";

// Synthetic data only.
const PIPELINE: Row = {
  is_owner: true,
  settings: { author: "best", desk_editor: "normal", archivist_bar: "normal", publisher_ask: "never", stale_days: 90, summary_length: "standard", paused_until: null },
  curator_on: true, writer_model: "anthropic-claude-sonnet-5.5", triage_model: "openai-gpt-oss-120b",
  changes: { desk_editor: { at: "2026-11-20T09:00:00Z", by: "owner@example.com" } },
  last_run: { started_at: "2026-11-22T10:00:00Z", status: "ok" },
  items_waiting: 3, items_flagged: 1, items_in_month: 40, skipped_month: 12, reviews_pending: 2, duplicates_open: 1, pages: 120, pages_stale: 7,
};

const LEDGER: Row = {
  is_owner: true, since: "2026-11-01T00:00:00Z", now: "2026-11-11T00:00:00Z",
  spent_usd: 10, budget_usd: 25, budget_pct: 80, budget_action: "warn", switched_this_month: false,
  items_in: 40, items_done: 20, items_skipped: 12,
  days: [{ day: "2026-11-03", author_usd: 1.5, other_usd: 0.25 }, { day: "2026-11-09", author_usd: 0.5, other_usd: 0.1 }],
  changes: [{ at: "2026-11-05T12:00:00Z", by: "owner@example.com", setting: "author", old: "best", new: "budget" }],
};

const TICKETS: Row[] = [
  { ref: "QB-0012", step: "author", kind: "curator_failed", title: "The curator's last run failed", status: "open", opened_at: "2026-11-22T10:00:00Z", cleared_at: null },
  { ref: "QB-0013", step: "mailroom", kind: "held_mail", title: "Mail is held for you", status: "open", opened_at: "2026-11-22T10:05:00Z", cleared_at: null },
  { ref: "QB-0014", step: "mailroom", kind: "stuck_run", title: "A curator run looks stuck", status: "open", opened_at: "2026-11-22T10:06:00Z", cleared_at: "2026-11-22T11:00:00Z" },
];

function world(over: { pipeline?: Row; ledger?: Row; tickets?: Row[]; set?: (e: string, s: string, v: string) => Promise<Row> } = {}) {
  const screens = createScreens();
  const set = vi.fn(over.set ?? (async (_e: string, setting: string, value: string) => ({ setting, value, changed: true })));
  const deps = screens.deps as { store: typeof screens.fake.store };
  deps.store = {
    ...screens.fake.store,
    pipeline: async (email: string) => {
      if (email !== OWNER) throw new AppDeniedError("not allowed");
      return over.pipeline ?? PIPELINE;
    },
    ledger: async () => over.ledger ?? LEDGER,
    setPipeline: set,
    tickets: async () => over.tickets ?? [],
  };
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  app.route("/setup", makeIndexingRoutes(() => screens.deps));
  app.route("/setup", makePipelineRoutes(() => screens.deps));
  return { ...screens, set, http: client(app) };
}

const clean = (html: string) => {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
};
const tokenFor = (html: string) => /action="\/setup\/pipeline\/set"><input type="hidden" name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

describe("Pipeline", () => {
  it("draws the publishing line, left to right, each step with a light and its last run", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    const names = [...html.matchAll(/<li class="step[^"]*">.*?<strong>(?:<a [^>]+>)?([^<]+)/gs)].map((m) => m[1]);
    expect(names).toEqual(["Subscriptions", "Mailroom", "New mail alert", "Desk editor", "Archivist", "Author", "Fact-checker", "Publisher", "Cataloguer", "Index clerk", "Librarian", "Reading room"]);
    expect(html.match(/class="light (ok|warn|bad|off)"/g)?.length).toBeGreaterThanOrEqual(12);
    expect(html).toContain("Last run: 2026-11-22 10:00 UTC (ok)");
    expect(html).toContain("2 changes waiting for your yes.");
    expect(html).toContain("7 pages not updated in 90 days.");
    expect(html).toContain("The mail, files, meetings and Claude Code sessions you chose to send in.");
    expect(html).toContain('<p class="helper">');
    // The old Indexing details stay, below the line.
    expect(html).toContain("Engine room details");
    expect(html).toContain("Re-run pending summaries");
    clean(html);
  });

  it("puts each setting on its own step card, as a segmented control with the current choice's effect", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    const cards = Object.fromEntries([...html.matchAll(/<li class="step[^"]*">.*?<strong>(?:<a [^>]+>)?([^<]+).*?<\/li>/gs)].map((m) => [m[1], m[0]]));
    const on: Record<string, string> = { desk_editor: "Desk editor", archivist_bar: "Archivist", author: "Author", publisher_ask: "Publisher", summary_length: "Cataloguer", stale_days: "Librarian" };
    for (const def of PIPELINE_SETTINGS) {
      const card = cards[on[def.id] ?? ""] ?? "";
      expect(card).toContain(`name="setting" value="${def.id}"`);
      expect(card).toContain('class="seg"');
      for (const c of def.choices) expect(card).toContain(`>${c.label}</button>`);
      const current = def.choices.find((c) => c.value === String((PIPELINE["settings"] as Row)[def.id]));
      expect(card).toContain(`aria-pressed="true" title="${current?.effect.replace(/'/g, "&#39;")}"`);
      expect(card).toContain(`<p class="effect">${current?.effect.replace(/'/g, "&#39;")}</p>`);
      for (const c of def.choices.filter((x) => x !== current)) expect(card).toContain(`name="value" value="${c.value}"`);
    }
    expect(cards["New mail alert"]).toContain('role="switch" aria-checked="true"');
    expect(cards["New mail alert"]).toContain("Pause for 24 hours");
    expect(cards["Desk editor"]).toContain("changed on 2026-11-20 09:00 UTC by owner");
    expect(html).toContain("None of these choices can switch a check off");
    // The separate settings block is gone.
    expect(html).not.toContain("These are safe choices");
    expect(html).not.toContain("<fieldset>");
  });

  it("an administrator who is not the owner sees each card's setting read only", async () => {
    const w = world({ pipeline: { ...PIPELINE, is_owner: false } });
    const html = await (await w.http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).not.toContain('action="/setup/pipeline/set"');
    expect(html).not.toContain('class="seg"');
    expect(html).toContain("Only the Engine owner can change");
    expect(html).toContain('<p class="tune-value"><strong>Best</strong></p>');
    expect(html).toContain('<p class="tune-value"><strong>Running.</strong></p>');
  });

  it("the Author card says just Best or Budget; the model id is only in Details for experts", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    const author = [...html.matchAll(/<li class="step[^"]*">.*?<\/li>/gs)].map((m) => m[0]).find((c) => c.includes("<strong>Author</strong>")) ?? "";
    expect(author).toContain('<p class="hint">Best</p>');
    expect(author).not.toMatch(/anthropic|claude-|haiku|sonnet/);
    const budget = await (await world({ pipeline: { ...PIPELINE, settings: { ...(PIPELINE["settings"] as Row), author: "budget" } } }).http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(budget).toContain('<p class="hint">Budget</p>');
    const experts = /<summary>Details for experts<\/summary>(.*?)<\/details>/s.exec(html)?.[1] ?? "";
    expect(experts).toContain("AI model");
  });

  it("keeps every effect note short and plain: no prices, ratios or exact numbers", () => {
    for (const def of PIPELINE_SETTINGS) {
      for (const c of def.choices) {
        expect(c.effect.length).toBeLessThanOrEqual(60);
        expect(c.effect).not.toMatch(/[0-9$%]|cent|twentieth|fifth/i);
      }
    }
    expect(PIPELINE_SETTINGS.find((d) => d.id === "author")?.choices.find((c) => c.value === "budget")?.effect)
      .toBe("Much cheaper. Plainer pages, may miss details.");
  });

  it("explains itself: a plain intro, steps numbered 1 to 12", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toContain('<p class="pipeline-intro">');
    expect(html).toContain("like a book going through a publishing house");
    const numbers = [...html.matchAll(/<span class="step-no" aria-label="Step (\d+)">/g)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(html.indexOf("pipeline-intro")).toBeLessThan(html.indexOf('class="line"'));
  });

  it("every card has the same three zones: top, a settings zone (or a quiet note), and a Last run footer", async () => {
    const html = await (await world().http.get("/setup/pipeline", ASSERT.owner)).text();
    const cards = [...html.matchAll(/<li class="step[^"]*">(.*?)<\/li>/gs)].map((m) => m[1] ?? "");
    expect(cards).toHaveLength(12);
    for (const card of cards) {
      expect(card).toMatch(/<div class="step-top">/);
      expect(card.match(/<div class="tune( quiet)?">/g)).toHaveLength(1);
      expect(card).toMatch(/<p class="step-foot">Last run: 2026-11-22 10:00 UTC \(ok\)<\/p>$/);
    }
    expect(cards.filter((c) => c.includes("Nothing to set here."))).toHaveLength(4);
  });

  it("a step with open tickets shows a red Needs you badge linking to its ticket (or To do for several)", async () => {
    const html = await (await world({ tickets: TICKETS }).http.get("/setup/pipeline", ASSERT.owner)).text();
    const cards = Object.fromEntries([...html.matchAll(/<li class="(step[^"]*)">.*?<strong>(?:<a [^>]+>)?([^<]+).*?<\/li>/gs)].map((m) => [m[2], m[0]]));
    expect(cards["Author"]).toContain('<li class="step has-needs">');
    expect(cards["Author"]).toContain('<a class="needs-you" href="/app/tickets/QB-0012" title="QB-0012">Needs you – 1</a>');
    // QB-0013's cause is still there: red. QB-0014 looks fixed: amber, never red.
    expect(cards["Mailroom"]).toContain('<a class="needs-you" href="/app/tickets/QB-0013" title="QB-0013">Needs you – 1</a>');
    expect(cards["Mailroom"]).toContain('<a class="check-close" href="/app/tickets/QB-0014" title="QB-0014">Check and close – 1</a>');
    expect(cards["Librarian"]).not.toContain("needs-you");
    clean(html);
  });

  it("a step whose only tickets look fixed shows the amber Check and close badge, not red Needs you", async () => {
    const fixed = [
      { ...TICKETS[1], ref: "QB-0001", step: "publisher", cleared_at: "2026-11-22T11:00:00Z" },
      { ...TICKETS[1], ref: "QB-0002", step: "publisher", cleared_at: "2026-11-22T11:05:00Z" },
    ];
    const html = await (await world({ tickets: fixed }).http.get("/setup/pipeline", ASSERT.owner)).text();
    const card = [...html.matchAll(/<li class="step[^"]*">.*?<\/li>/gs)].map((m) => m[0]).find((c) => c.includes("Publisher")) ?? "";
    expect(card).toContain('<li class="step has-check">');
    expect(card).toContain('<a class="check-close" href="/app/todo" title="QB-0001, QB-0002">Check and close – 2</a>');
    expect(card).not.toContain("needs-you");
  });

  it("the cards still draw when tickets cannot be read", async () => {
    const w = world();
    const deps = w.deps as { store: Record<string, unknown> };
    deps.store = { ...deps.store, tickets: async () => Promise.reject(new AppMissingFunctionError("app_tickets_list")) };
    const html = await (await w.http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toContain('class="line"');
    expect(html).not.toContain("needs-you");
  });

  it("refuses a reader, and the old Indexing address redirects here", async () => {
    const w = world();
    expect((await w.http.get("/setup/pipeline", ASSERT.reader)).status).toBe(403);
    const old = await w.http.get("/setup/indexing", ASSERT.owner);
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/setup/pipeline");
  });

  it("saves a choice with the form token and goes back to the screen", async () => {
    const w = world();
    const csrf = tokenFor(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    const res = await w.http.post("/setup/pipeline/set", { csrf, setting: "author", value: "budget" }, ASSERT.owner);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/pipeline");
    expect(w.set).toHaveBeenCalledWith(OWNER, "author", "budget");
    const budget = await w.http.post("/setup/pipeline/set", { csrf, setting: "budget_usd", value: "40" }, ASSERT.owner);
    expect(budget.headers.get("location")).toBe("/setup/ledger");
  });

  it("refuses without the token, from another site, an unknown setting, or an empty value", async () => {
    const w = world();
    const csrf = tokenFor(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    expect((await w.http.post("/setup/pipeline/set", { setting: "author", value: "best" }, ASSERT.owner)).status).toBe(403);
    expect((await w.http.post("/setup/pipeline/set", { csrf, setting: "author", value: "best" }, ASSERT.owner, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await w.http.post("/setup/pipeline/set", { csrf, setting: "fact_check", value: "off" }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/pipeline/set", { csrf, setting: "author", value: "" }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/pipeline/set", { csrf, setting: "author", value: "best" }, ASSERT.reader)).status).toBe(403);
    expect(w.set).not.toHaveBeenCalled();
    expect(SETTING_IDS.has("fact_check")).toBe(false);
  });

  it("the database's refusal (not the owner, not a choice) is shown, never applied", async () => {
    const w = world({ set: async () => Promise.reject(new AppDeniedError("not allowed")) });
    const csrf = tokenFor(await (await w.http.get("/setup/pipeline", ASSERT.owner)).text());
    const res = await w.http.post("/setup/pipeline/set", { csrf, setting: "author", value: "best" }, ASSERT.owner);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("before 0071 is applied the line says an update is needed and the details still show", async () => {
    const w = world();
    const deps = w.deps as { store: Record<string, unknown> };
    deps.store = { ...deps.store, pipeline: async () => Promise.reject(new AppMissingFunctionError("app_pipeline_get")) };
    const html = await (await w.http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toContain("database update (0071)");
    expect(html).toContain("Re-run pending summaries");
  });

  it("shows a pause and its end", async () => {
    const w = world({ pipeline: { ...PIPELINE, settings: { ...(PIPELINE["settings"] as Row), paused_until: "2026-11-23T10:00:00Z" } } });
    const html = await (await w.http.get("/setup/pipeline", ASSERT.owner)).text();
    expect(html).toContain("Paused</strong> until 2026-11-23 10:00 UTC");
    expect(html).toContain("Resume now");
    expect(html).toContain('class="light off"');
  });
});

describe("Ledger", () => {
  it("shows spend, the month-end projection, the budget, the chart with a marker, and items", async () => {
    const html = await (await world().http.get("/setup/ledger", ASSERT.owner)).text();
    expect(html).toContain("<strong>$10.00</strong>");
    expect(html).toContain("$30.00"); // 10 over 10 days, 30 days in November
    expect(html).toContain("$25.00");
    expect(html).toContain("On track to pass the budget");
    expect(html).toContain('class="chart"');
    expect(html.match(/class="bar-author"/g)?.length).toBe(2);
    expect(html.match(/class="mark"/g)?.length).toBe(1);
    expect(html).toContain("$0.500"); // 10 / 20 items
    expect(html).toContain("Changes this month");
    expect(html).toContain('name="setting" value="budget_action"');
    clean(html);
  });

  it("is read only for an administrator who is not the owner, and says when the rule switched", async () => {
    const w = world({ ledger: { ...LEDGER, is_owner: false, switched_this_month: true } });
    const html = await (await w.http.get("/setup/ledger", ASSERT.owner)).text();
    expect(html).not.toContain('action="/setup/pipeline/set"');
    expect(html).toContain("Only the Engine owner changes the budget");
    expect(html).toContain("The budget rule switched the Author to Budget");
  });

  it("projection, month length and budget state", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    expect(monthProgress(since, new Date("2026-11-01T06:00:00Z"))).toEqual({ days: 30, elapsed: 1 });
    expect(projected(10, since, new Date("2026-11-11T00:00:00Z"))).toBeCloseTo(30, 6);
    expect(monthProgress(new Date("2026-02-01T00:00:00Z"), new Date("2026-02-10T00:00:00Z")).days).toBe(28);
    expect(budgetState(5, 10, 25, 80).light).toBe("ok");
    expect(budgetState(21, 22, 25, 80).light).toBe("warn");
    expect(budgetState(26, 30, 25, 80).light).toBe("bad");
  });

  it("drops malformed days and escapes change text in the chart", () => {
    const days = parseDays([{ day: "x" }, { day: "2026-11-02", author_usd: "1", other_usd: -3 }]);
    expect(days).toEqual([{ day: "2026-11-02", author: 1, cataloguer: 0, other: 0 }]);
    const svg = chartSvg(days, [{ at: "2026-11-02T00:00:00Z", by: "<b>", setting: "author", old: "best", new: "budget" }], 30, "2026-11-01T00:00:00.000Z");
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).not.toContain("<b>");
  });
});

describe("To do", () => {
  it("lists changes to approve, held mail and look-alikes in one place, linking to each screen", async () => {
    const html = await (await world().http.get("/app/todo", ASSERT.reader)).text();
    expect(html).toContain("Changes to approve");
    expect(html).toContain("Held mail");
    expect(html).toContain("Look-alike pages");
    expect(html).toMatch(/href="\/app\/reviews\/[0-9a-f-]{36}"/);
    expect(html).toContain('href="/app/flagged"');
    expect(html).toContain("Odd &lt;mail&gt;");
    expect(html).toMatch(/<a class="nav-item active" href="\/app\/todo"/);
    clean(html);
  });

  it("a list that cannot be read does not fail the page", async () => {
    const w = world();
    const deps = w.deps as { store: Record<string, unknown> };
    deps.store = { ...deps.store, duplicates: async () => Promise.reject(new Error("down")) };
    const res = await w.http.get("/app/todo", ASSERT.reader);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("could not be read just now");
  });

  it("needs a signed-in person", async () => {
    expect((await world().http.get("/app/todo")).status).toBeGreaterThanOrEqual(400);
    expect(READER).not.toBe(OWNER);
  });
});
