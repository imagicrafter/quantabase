import { Hono } from "hono";
import { logger } from "../log/logger.js";
import { UUID, readForm } from "./guard.js";
import { card, esc, postForm, sendMessage, when } from "./html.js";
import { admin, type Handler, type SettingsDeps } from "./settings-routes.js";
import type { Row } from "./store.js";
import { adminMigrationState, updateBanner } from "./db-update.js";
import { curatorHealthCard, timerBrokenBanner } from "./curator-health.js";
import { cataloguerExpertsHtml } from "./cataloguer-view.js";

/**
 * The Indexing details (now on /setup/pipeline), administrators only (admin app, second factor): how far
 * the Engine is with its pages, and two actions.
 *
 * All under a collapsed "Details for experts": the numbers (pages, items
 *   waiting / held / failed, the last run, the models, the last backup), the
 *   items that failed, the timer's health, and re-run pending summaries.
 * Uncertain decisions only when consensus is on, under a collapsed "Advanced".
 * The old Settings card is gone: curator on/off is the timer's job (and the
 *   safe Pause on the Pipeline), the model key is under Staff & settings.
 */

export const EMBEDDING_MODEL = "gte-small (384 dimensions, Supabase embed function)";
export const WAKE_GAP = "2 minutes (new items wake the curator at most this often; an hourly tick always runs)";

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const num = (v: unknown): string => esc(Number(v ?? 0).toLocaleString("en-US"));

/** One cell per run (run 1, run 2, tiebreak): each run's target and value, side by side. */
function proposalCells(proposals: unknown): string {
  const list = Array.isArray(proposals) ? proposals.map(String) : [];
  return [0, 1, 2].map((i) => `<td><code>${esc(list[i] ?? "")}</code></td>`).join("");
}

function statRow(label: string, value: string, warn = false): string {
  return `<tr${warn ? ' class="warn"' : ""}><th scope="row">${esc(label)}</th><td>${value}</td></tr>`;
}

const usd = (v: unknown): string => `$${Number(v).toFixed(Number(v) < 1 ? 4 : 2)}`;

/**
 * Model cost this month (UTC) and per item, from the USD each run records
 * (engine prices.ts: DigitalOcean list prices; the invoice is the final word).
 */
export function costRows(cost: Row | null): string {
  if (!cost) return statRow("Model cost this month", '<span class="hint">not known yet (database update 0069)</span>');
  const perItem = cost["per_item_usd"];
  const older = Number(cost["runs_without_cost"] ?? 0);
  return [
    statRow("Model cost this month", `${esc(usd(cost["usd"] ?? 0))} for ${num(cost["items"])} items${older > 0 ? ` <span class="hint">(${num(older)} earlier runs recorded no cost)</span>` : ""}`),
    statRow("Model cost per item", perItem === null || perItem === undefined ? "no items yet" : esc(usd(perItem))),
  ].join("\n");
}

/** The writer (and triage) when consensus is off and 0069 is applied; else the primary model. */
export function modelLine(cur: Row, models: Row): string {
  if (models["consensus"] !== false || typeof models["writer_model"] !== "string") return String(cur["model"] ?? "");
  const triage = models["triage"] === false ? "no triage" : `triage ${String(models["triage_model"] ?? "")}`;
  return `${models["writer_model"]} (one writer; ${triage})`;
}

function lastRun(run: Row): string {
  if (!run["started_at"]) return "never";
  const stats = object(run["stats"]);
  const parts = Object.entries(stats)
    // Per-model token and cost keys ("tokens_in:<model>") are left to the run log.
    .filter(([k, v]) => typeof v === "number" && v !== 0 && !k.includes(":"))
    .map(([k, v]) => `${esc(k.replace(/_/g, " "))} ${esc(v)}`)
    .join(", ");
  return `${esc(when(run["started_at"]))}: <strong>${esc(run["status"])}</strong>${parts ? ` (${parts})` : ""}`;
}

/**
 * The detail cards the Indexing screen used to show (status, failed items,
 * timer health, settings, uncertain decisions, actions). They now sit under
 * the publishing line on the Pipeline screen (pipeline-routes.ts).
 */
export async function indexingBody(me: { readonly email: string }, deps: SettingsDeps, pipeline: Row | null = null): Promise<string> {
  const s = await deps.store.indexing(me.email);
  const banner = updateBanner(await adminMigrationState(deps.database, () => deps.store.health(me.email)).catch(() => ({ known: false, exact: false, shipped: 0, applied: 0, pending: [] })));
  const cur = object(s["curator"]);
  const backup = object(s["backup"]);
  const curatorHealth = await deps.store.curatorHealth(me.email).catch(() => null);
  const timerHealth = curatorHealthCard(curatorHealth);
  const cost = deps.store.curatorCost ? await deps.store.curatorCost(me.email).catch(() => null) : null;
  const status = card(`<h2>Numbers</h2><table class="stats"><tbody>
${statRow("Pages", num(s["pages"]))}
${statRow("Pages waiting for a short summary", num(s["summaries_pending"]), Number(s["summaries_pending"] ?? 0) > 0)}
${statRow("New items waiting", num(s["items_waiting"]))}
${statRow("Items held for you", num(s["items_flagged"]), Number(s["items_flagged"] ?? 0) > 0)}
${statRow("Items that failed", num(s["items_failed"]), Number(s["items_failed"] ?? 0) > 0)}
${statRow("Last curator run", lastRun(object(s["last_run"])))}
${statRow("AI model", esc(modelLine(cur, object(cost?.["models"]))))}
${costRows(cost)}
${statRow("Search model", esc(EMBEDDING_MODEL))}
${statRow("Last backup", backup["last_finished_at"] ? `${esc(when(backup["last_finished_at"]))} (${esc(backup["last_status"])})` : backup["enabled"] ? "not yet" : "backup is off")}
</tbody></table>`);
  const failed = Array.isArray(s["failed_items"]) ? (s["failed_items"] as Array<Record<string, unknown>>) : [];
  const failedCard = failed.length
    ? card(`<h2>Items that failed</h2><p class="hint">The curator tried these several times and gave up. Each also opens a ticket.</p><table><thead><tr><th>Received</th><th>Item</th><th>Tries</th><th>Last error</th></tr></thead><tbody>${failed
        .map((f) => `<tr><td>${esc(when(f["received_at"]))}</td><td>${esc(f["title"] ?? "(no title)")} <span class="hint">${esc(f["source"])}</span></td><td>${esc(f["attempts"] ?? "")}</td><td>${esc(f["error"] ?? "(none recorded)")}</td></tr>`)
        .join("")}</tbody></table>`)
    : "";
  const csrf = deps.csrf.token(me.email, "indexing");
  const actions = card(`<h2>Write missing summaries again</h2>
${postForm("/setup/indexing/rerun", csrf, "", "Re-run pending summaries")}
<p class="hint">Queues every page still waiting for a summary again and wakes the curator. To re-index one page, use Re-index on that page.</p>`);
  const experts = `<details class="experts"><summary>Details for experts</summary>${status}${cataloguerExpertsHtml(pipeline)}${failedCard}${timerHealth}${actions}</details>`;
  return banner + timerBrokenBanner(curatorHealth) + experts + advancedHtml(cur, s);
}

/**
 * Uncertain decisions: only when consensus is on (off by default since 0069),
 * in a collapsed Advanced section at the very bottom.
 */
export function advancedHtml(cur: Row, s: Row): string {
  if (cur["consensus"] === false || cur["consensus"] === undefined) return "";
  const unsure = Array.isArray(s["uncertain"]) ? (s["uncertain"] as Array<Record<string, unknown>>) : [];
  const unsureRows = unsure
    .map((u) => `<tr><td>${esc(when(u["created_at"]))}</td><td>${esc(u["item_title"] ?? "(no title)")} <span class="hint">${esc(u["source"])}</span></td><td><code>${esc(u["decision"])}</code></td>${proposalCells(u["proposals"])}</tr>`)
    .join("");
  const inner = card(`<h2>Uncertain decisions</h2><p>Consensus: on · two runs of ${esc(cur["model"] ?? "")}, tiebreak ${esc(cur["tiebreak_model"] ?? "")}</p>
${unsure.length ? `<table><thead><tr><th>When</th><th>Item</th><th>Decision</th><th>Run 1</th><th>Run 2</th><th>Tiebreak</th></tr></thead><tbody>${unsureRows}</tbody></table>` : "<p>None. When the three runs all disagree on a decision, it is left out and listed here.</p>"}`);
  return `<details class="experts"><summary>Advanced</summary>${inner}</details>`;
}

const rerun: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "indexing");
  if (!sent.ok) return sent.response;
  const n = await deps.store.rerunSummaries(me.email);
  logger.info({ pages: n }, "app: summaries re-run");
  return sendMessage(c, "setup", 200, "Queued", `${n} ${n === 1 ? "page is" : "pages are"} queued for a new summary; the curator was woken.`);
};

const reindex: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "indexing");
  if (!sent.ok) return sent.response;
  const id = sent.form["page"] ?? "";
  if (!UUID.test(id)) return sendMessage(c, "setup", 400, "Not accepted", "No page was named.");
  const ok = await deps.store.reindexPage(me.email, id);
  logger.info({ page: id, ok }, "app: page re-index");
  return ok
    ? sendMessage(c, "setup", 200, "Queued", "The page's summary and embedding will be written again on the curator's next run.")
    : sendMessage(c, "setup", 404, "Not found", "There is no such page.");
};

export function makeIndexingRoutes(use: () => SettingsDeps): Hono {
  const app = new Hono();
  // The screen moved to /setup/pipeline; old links and bookmarks still work.
  app.get("/indexing", (c) => c.redirect("/setup/pipeline", 301));
  app.post("/indexing/rerun", admin(use, rerun));
  app.post("/indexing/reindex", admin(use, reindex));
  return app;
}

