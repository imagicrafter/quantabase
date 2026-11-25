import { Hono, type Context } from "hono";
import { logger } from "../log/logger.js";
import { readForm, type Allowed } from "./guard.js";
import { card, esc, sendMessage, when } from "./html.js";
import { admin, page, type Handler, type SettingsDeps } from "./settings-routes.js";
import { parseSearchQuery, redoConfirmHtml, searchResultsHtml, TRY_SEARCH_COUNT } from "./cataloguer-view.js";
import { AppMissingFunctionError, type Row } from "./store.js";
import { indexingBody } from "./indexing-routes.js";
import { SETTING_IDS, changedMarker, introHtml, lineHtml } from "./pipeline-view.js";
import { budgetForm, budgetState, chartSvg, monthProgress, parseChanges, parseDays, projected, settingName, usd } from "./ledger-view.js";
import { LEDGER_HREF, PIPELINE_HREF } from "./shell.js";

/**
 * /setup/pipeline and /setup/ledger, administrators only (the admin app with
 * its second factor). Every administrator reads them; only the Engine owner
 * changes a setting, and the database checks that again (app_pipeline_set,
 * 0071) along with the value, which must be one of a fixed list. Each change
 * is logged with its time and who made it.
 *
 *   GET  /pipeline       the publishing line (each safe choice on its step), the details
 *   POST /pipeline/set   one setting (setting, value); back to its screen
 *   POST /pipeline/search the Index clerk's try-a-search box (any administrator, read only)
 *   GET  /pipeline/redo  redo summaries and index: pages and estimated cost (the owner)
 *   POST /pipeline/redo  the same, after the confirm click: re-queue every page (the owner)
 *   GET  /ledger         spend, projection, budget, daily chart, items
 */

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const SCOPE = "pipeline";
const SEARCH_SCOPE = "pipeline-search";
const LEDGER_SETTINGS: ReadonlySet<string> = new Set(["budget_usd", "budget_pct", "budget_action"]);

const UPDATE_NEEDED = card("<p>This screen needs a database update (0071). Open <a href=\"/setup/database\">Database</a> to apply it.</p>");

async function read(fn: ((email: string) => Promise<Row>) | undefined, email: string): Promise<Row | null> {
  if (!fn) return null;
  try {
    return await fn(email);
  } catch (err) {
    if (err instanceof AppMissingFunctionError) return null;
    throw err;
  }
}

/** The screen, with the try-a-search results under the line when there are some. */
async function screen(c: Context, me: Allowed, deps: SettingsDeps, found?: { readonly query: string; readonly rows: readonly Row[] }) {
  const p = await read(deps.store.pipeline, me.email);
  const details = await indexingBody(me, deps, p);
  if (!p) return page(c, PIPELINE_HREF, "Pipeline", UPDATE_NEEDED + details);
  const owner = p["is_owner"] === true;
  const csrf = owner ? deps.csrf.token(me.email, SCOPE) : null;
  const who = owner
    ? "<p class=\"hint\">You are the owner: change a step with the choice at the bottom of its card. Every change is logged with the time and your name. None of these choices can switch a check off.</p>"
    : "<p class=\"hint\">Only the Engine owner can change the choices on these cards. You can see them. None of them can switch a check off.</p>";
  const tickets = deps.store.tickets ? await deps.store.tickets(me.email, "open").catch(() => []) : [];
  const search = { csrf: deps.csrf.token(me.email, SEARCH_SCOPE), ...(found ? { query: found.query } : {}) };
  const results = found ? searchResultsHtml(found.query, found.rows) : "";
  return page(c, PIPELINE_HREF, "Pipeline", `${introHtml()}${who}${lineHtml(p, csrf, tickets, search)}${results}<h2 class="section">Engine room details</h2>${details}`);
}

const pipeline: Handler = (c, me, deps) => screen(c, me, deps);

/**
 * The Index clerk's try-a-search box: any administrator, read only. The
 * question goes in a POST body (never the address, so it stays out of logs)
 * with the form token; the database returns only the pages this person may
 * see, ranked as their MCP search would rank them.
 */
const trySearch: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, SEARCH_SCOPE);
  if (!sent.ok) return sent.response;
  const query = parseSearchQuery(sent.form["q"]);
  if (query === null) return sendMessage(c, "setup", 400, "Not accepted", "Type a question of 1 to 200 characters.");
  if (!deps.embed || !deps.store.indexSearch) return sendMessage(c, "setup", 503, "Not ready", "Search is not set up on this Engine yet.");
  const rows = await deps.store.indexSearch(me.email, query, await deps.embed(query), TRY_SEARCH_COUNT);
  logger.info({ query_length: query.length, results: rows.length }, "app: try a search");
  return screen(c, me, deps, { query, rows });
};

/** The owner's redo preview, or null (with the reason as a response) for anyone else. */
async function ownerPreview(c: Context, me: Allowed, deps: SettingsDeps): Promise<Row | Response> {
  if (!deps.store.redoPreview || !deps.store.redoSummaries) {
    return sendMessage(c, "setup", 503, "Not ready", "This needs a database update (0075).");
  }
  const preview = await deps.store.redoPreview(me.email);
  if (preview["is_owner"] !== true) return sendMessage(c, "setup", 403, "No access", "Only the Engine owner can redo summaries and index.");
  return preview;
}

/** Redo summaries and index, step one: how many pages and what it may cost. Changes nothing. */
const redoPreview: Handler = async (c, me, deps) => {
  const preview = await ownerPreview(c, me, deps);
  if (preview instanceof Response) return preview;
  return page(c, PIPELINE_HREF, "Redo summaries and index", redoConfirmHtml(preview, deps.csrf.token(me.email, SCOPE)));
};

/** Step two, after the confirm click: re-queue every live page; the normal runs do the work. */
const redo: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  if (sent.form["confirm"] !== "yes") return sendMessage(c, "setup", 400, "Not accepted", "Confirm on the redo page first.");
  const preview = await ownerPreview(c, me, deps);
  if (preview instanceof Response) return preview;
  const run = deps.store.redoSummaries;
  if (!run) return sendMessage(c, "setup", 503, "Not ready", "This needs a database update (0075).");
  const n = await run(me.email);
  logger.info({ pages: n }, "app: summaries and index redone");
  return sendMessage(c, "setup", 200, "Queued", `${n} ${n === 1 ? "page is" : "pages are"} queued for a new summary and index entry; the curator was woken.`);
};

const ledger: Handler = async (c, me, deps) => {
  const l = await read(deps.store.ledger, me.email);
  if (!l) return page(c, LEDGER_HREF, "Ledger", UPDATE_NEEDED);
  const owner = l["is_owner"] === true;
  const csrf = owner ? deps.csrf.token(me.email, SCOPE) : null;
  const since = new Date(String(l["since"] ?? ""));
  const now = new Date(String(l["now"] ?? ""));
  const ok = !Number.isNaN(since.getTime()) && !Number.isNaN(now.getTime());
  const spent = num(l["spent_usd"]);
  const budget = num(l["budget_usd"]);
  const pct = num(l["budget_pct"]);
  const proj = ok ? projected(spent, since, now) : spent;
  const state = budgetState(spent, proj, budget, pct);
  const switched = l["switched_this_month"] === true
    ? "<p><strong>The budget rule switched the Author to Budget this month.</strong> Switch it back on the <a href=\"/setup/pipeline\">Pipeline</a> screen.</p>"
    : "";
  const summary = card(`<h2>This month</h2><table class="stats"><tbody>
<tr><th scope="row">Spent so far</th><td><strong>${esc(usd(spent))}</strong></td></tr>
<tr><th scope="row">Projected by month end</th><td>${esc(usd(proj))}</td></tr>
<tr><th scope="row">Budget</th><td>${esc(usd(budget))}</td></tr>
<tr><th scope="row">Cataloguer (page summaries)</th><td>${esc(usd(num(l["cataloguer_usd"])))}</td></tr>
</tbody></table><p><span class="light ${state.light}" role="img" aria-label="${esc(state.light)}"></span> ${esc(state.text)}</p>${switched}
<p class="hint">From the token counts each run records, at DigitalOcean's list prices. The invoice is the final word.</p>`, state.light === "ok" ? "" : "warnings");
  const days = parseDays(l["days"]);
  const changes = parseChanges(l["changes"]);
  const chart = ok
    ? card(`<h2>Cost each day</h2>${chartSvg(days, changes, monthProgress(since, now).days, since.toISOString())}`)
    : "";
  const itemsIn = num(l["items_in"]);
  const skipped = num(l["items_skipped"]);
  const done = num(l["items_done"]);
  const items = card(`<h2>Items</h2><table><thead><tr><th>Items in</th><th>Set aside by the Desk editor</th><th>Cost per item</th></tr></thead>
<tbody><tr><td>${esc(itemsIn)}</td><td>${esc(skipped)}</td><td>${done > 0 ? esc(usd(spent / done)) : "no items yet"}</td></tr></tbody></table>
<p class="hint">Items the Desk editor sets aside cost only its short first read.</p>`);
  const log = changes.length
    ? card(`<h2>Changes this month</h2><table><thead><tr><th>When</th><th>Setting</th><th>From</th><th>To</th><th>By</th></tr></thead><tbody>${changes
        .map((x) => `<tr><td>${esc(when(x.at))}</td><td>${esc(settingName(x.setting))}</td><td>${esc(x.old)}</td><td>${esc(x.new)}</td><td>${esc(x.by)}</td></tr>`)
        .join("")}</tbody></table>`)
    : "";
  const lastChanges = Object.fromEntries(changes.map((x) => [x.setting, { at: x.at, by: x.by }]));
  const rule = card(`<h2>Budget rule</h2>${budgetForm(l, csrf, lastChanges, changedMarker)}`);
  return page(c, LEDGER_HREF, "Ledger", summary + chart + items + rule + log);
};

const set: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const setting = sent.form["setting"] ?? "";
  const value = (sent.form["value"] ?? "").trim();
  if (!SETTING_IDS.has(setting) || value === "" || value.length > 20) {
    return sendMessage(c, "setup", 400, "Not accepted", "Pick one of the choices on the page.");
  }
  if (!deps.store.setPipeline) return sendMessage(c, "setup", 503, "Not ready", "This needs a database update (0071).");
  const r = await deps.store.setPipeline(me.email, setting, value);
  logger.info({ setting, changed: r["changed"] === true }, "app: pipeline setting");
  return c.redirect(LEDGER_SETTINGS.has(setting) ? LEDGER_HREF : PIPELINE_HREF, 303);
};

export function makePipelineRoutes(use: () => SettingsDeps): Hono {
  const app = new Hono();
  app.get("/pipeline", admin(use, pipeline));
  app.post("/pipeline/set", admin(use, set));
  app.post("/pipeline/search", admin(use, trySearch));
  app.get("/pipeline/redo", admin(use, redoPreview));
  app.post("/pipeline/redo", admin(use, redo));
  app.get("/ledger", admin(use, ledger));
  return app;
}
