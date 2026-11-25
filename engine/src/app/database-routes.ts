import { Hono } from "hono";
import { logger } from "../log/logger.js";
import { projectLink, tokenLinkHint } from "./supabase-links.js";
import { readForm } from "./guard.js";
import { adminMigrationState, runDbUpdate, updateBanner, UPDATE_STEPS, type MigrationState } from "./db-update.js";
import type { StepReport } from "./db-setup.js";
import { card, esc, notice, postForm, sendMessage } from "./html.js";
import { createMgmt, MgmtError } from "./mgmt.js";
import { admin, page, type Handler, type SettingsDeps } from "./settings-routes.js";
import type { Allowed } from "./guard.js";

/**
 * /setup/database once the Engine is set up, administrators only (the admin
 * application with its second factor, the same form token as every setup
 * screen). The first-run Database screen (first-run-routes.ts) answers this
 * address only while the Engine is new and passes it on afterwards.
 *
 *   GET   migrations applied vs shipped, the pending files by name, the form
 *   POST  one Supabase access token -> apply only the pending files, then
 *         re-expose the schema (db-update.ts); each step's result and time
 *
 * THE ACCESS TOKEN is read from the form, handed to the Management API client
 * for this one request and goes nowhere else: not into a page, a log line or
 * the database.
 */

const HERE = "/setup/database";

function stepsTable(steps: readonly StepReport[]): string {
  const rows = steps
    .map((s) => `<tr><td>${esc(s.status.replace("_", " "))}</td><td>${esc(s.title)}</td><td>${s.ms === undefined ? "" : `${esc(s.ms)} ms`}</td><td>${esc(s.note ?? "")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Result</th><th>Step</th><th>Time</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function stateCard(state: MigrationState): string {
  if (!state.known) {
    return card("<p>Which migrations this database has applied could not be read just now. The update below is still safe: it applies only what is missing.</p>");
  }
  if (state.pending.length === 0) {
    return card(`<p><strong>The database is up to date</strong>: ${esc(state.applied)} of ${esc(state.shipped)} migrations shipped with this app are applied.</p>`);
  }
  const names = state.pending.map((n) => `<li><code>${esc(n)}</code></li>`).join("");
  const estimate = state.exact ? "" : '<p class="hint">An estimate: this database is older than the function that lists applied migrations. The update finds the exact files itself.</p>';
  return card(`<p>Applied: <strong>${esc(state.applied)} of ${esc(state.shipped)}</strong> migrations shipped with this app. Pending:</p><ol>${names}</ol>${estimate}`);
}

function form(deps: SettingsDeps, me: Allowed): string {
  const plan = UPDATE_STEPS.map((s) => `<li>${esc(s.title)}</li>`).join("");
  return card(`<h2>Update the database</h2>
<p>This applies only the pending migrations to your Supabase project ${projectLink(deps.database?.projectRef)}, in order, each in its own transaction, then makes the schema reachable again:</p><ol>${plan}</ol>
<ol>
<li>In Supabase open <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noopener noreferrer">Account, then Access Tokens</a>, then <strong>Generate new token</strong>. Limit it to this project if offered; let it expire tomorrow.</li>
<li>Paste it below. It is used for this one request and not saved, logged or shown. Delete it in Supabase afterwards.</li>
</ol>
${postForm(HERE, deps.csrf.token(me.email, "database"), `<label for="access_token">Supabase access token</label>
<input type="password" id="access_token" name="access_token" autocomplete="off" spellcheck="false" required maxlength="512">
${tokenLinkHint()}`, "Update the database")}`);
}

const cannot = card("<p>This app was built without the repository's SQL files, so it cannot update its own database. Run <code>kbe db migrate</code> from the Engine's tooling instead.</p>");

async function view(deps: SettingsDeps, me: Allowed, before = ""): Promise<string> {
  const state = await adminMigrationState(deps.database, () => deps.store.health(me.email));
  const usable = deps.database && deps.database.files() !== null;
  return before + updateBanner(state) + stateCard(state) + (usable ? form(deps, me) : cannot);
}

const show: Handler = async (c, me, deps) => page(c, HERE, "Database", await view(deps, me));

let running = false;

/** "migrations:done:41200ms", one per step, for the log. */
const timed = (steps: readonly StepReport[]) => steps.map((x) => `${x.id}:${x.status}${x.ms === undefined ? "" : `:${x.ms}ms`}`);

const update: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "database");
  if (!sent.ok) return sent.response;
  const db = deps.database;
  const files = db?.files() ?? null;
  if (!db || !files || !db.projectRef) return page(c, HERE, "Database", cannot, 400);
  let mgmt;
  try {
    mgmt = createMgmt((sent.form["access_token"] ?? "").trim(), db.projectRef, db.fetch);
  } catch (err) {
    const text = err instanceof MgmtError ? err.message : "That token was not accepted.";
    return page(c, HERE, "Database", await view(deps, me, notice("error", text)), 400);
  }
  if (running) return sendMessage(c, "setup", 409, "Already running", "The database is being updated right now. Wait a minute, then open this page again.");
  running = true;
  try {
    const result = await runDbUpdate({ mgmt, files, kbSchema: db.kbSchema });
    const totalMs = result.steps.reduce((sum, x) => sum + (x.ms ?? 0), 0);
    logger.info({ ok: result.ok, total_ms: totalMs, steps: timed(result.steps) }, "app: database update finished");
    const report = card(`<h2>${result.ok ? "Done" : "Stopped"}</h2>${stepsTable(result.steps)}<p class="hint">Total ${esc(totalMs)} ms.</p>`);
    if (!result.ok) {
      // 422, not 502: DigitalOcean's edge replaces an app's 502 with its own page.
      const head = notice("error", "The update stopped. Fix what the table says, then run it again: applied files are not repeated.");
      return page(c, HERE, "Database", await view(deps, me, head + report), 422);
    }
    return page(c, HERE, "Database", await view(deps, me, notice("ok", "Database updated.") + report));
  } finally {
    running = false;
  }
};

export function makeDatabaseRoutes(use: () => SettingsDeps): Hono {
  const app = new Hono();
  app.get("/database", admin(use, show));
  app.post("/database", admin(use, update));
  return app;
}
