import { Hono } from "hono";
import { logger } from "../log/logger.js";
import { readForm } from "./guard.js";
import { card, esc, notice, postForm, when } from "./html.js";
import { AppInputError } from "./store.js";
import { admin, page, type Handler, type SettingsDeps } from "./settings-routes.js";

/**
 * /setup/backup: the nightly one-way GitHub backup (backup/run.ts), for the
 * Engine OWNER only. The admin sign-in lets administrators reach the page;
 * the database (0056 app_backup_*) then refuses anyone but the owner, because
 * the backup repository holds every page with no row protection.
 *
 * The GitHub token goes straight into Supabase Vault (kbe_backup_token) and
 * is only ever reported as "saved".
 */

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

const yes = (v: unknown) => (v === true ? "yes" : "no");

function lastRun(b: Record<string, unknown>): string {
  if (!b["last_status"]) return "never";
  const commit = typeof b["last_commit"] === "string" ? `, commit ${esc(String(b["last_commit"]).slice(0, 7))}` : "";
  const files = b["last_files"] !== null && b["last_files"] !== undefined ? `, ${esc(b["last_files"])} files` : "";
  const error = b["last_error"] ? ` <span class="hint">(${esc(b["last_error"])})</span>` : "";
  return `${esc(b["last_status"])}, ${esc(when(b["last_finished_at"] ?? b["last_started_at"]))}${files}${commit}${error}`;
}

/** The notices a save may return with (?done=...). Fixed text only: the query is never echoed. */
const DONE: Readonly<Record<string, string>> = {
  token: "Token saved. The GitHub token is in Supabase Vault and is not shown again.",
  settings: "Backup settings saved.",
  off: "Backup settings saved. The backup is off.",
  started: "Backup started. The curator was woken; Last run shows the result in a minute or two.",
  queued: "Backup asked for. It runs on the next timer run: the timer is not set up, so save it on the Timer screen to run it sooner.",
  running: "A backup is already running. Last run shows the result when it finishes.",
};

type Typed = { readonly repo?: string; readonly branch?: string; readonly enabled?: boolean };

/** What the owner should do next, from the saved state. */
function nextStep(b: Record<string, unknown>): string {
  if (!b["has_token"]) return "Next: save a GitHub token (the Token card below).";
  if (!b["repo"]) return "Next: enter the private repository and save (the Repository card below).";
  if (!b["enabled"]) return "Next: tick “Back up every night” and save (the Repository card below).";
  if (b["last_status"] === "running") return "Next: wait for the run to finish, then open this page again.";
  if (b["last_status"] === "failed") return "Next: fix what Last run says, then run a backup now.";
  if (!b["last_status"]) return "Next: run a backup now (the Back up now button below) to test it.";
  return "Next: nothing to do. It runs each night; run a backup now to test a change.";
}

const ready = (b: Record<string, unknown>) => Boolean(b["has_token"] && b["repo"] && b["enabled"]);

/** The whole screen: an optional notice on top, the state, and the three forms. */
async function screen(c: Parameters<Handler>[0], me: Parameters<Handler>[1], deps: SettingsDeps, top: string, typed: Typed = {}, status: 200 | 400 = 200) {
  const b = await deps.store.backup(me.email);
  const csrf = deps.csrf.token(me.email, "backup");
  const repo = typed.repo ?? (typeof b["repo"] === "string" ? b["repo"] : "");
  const branch = typed.branch ?? (typeof b["branch"] === "string" ? b["branch"] : "main");
  const enabled = typed.enabled ?? b["enabled"] === true;
  const body =
    top +
    card(`<p>Each night the Engine writes every page to one <strong>private</strong> GitHub repository as Markdown that opens as an Obsidian vault: a file per page named by its title, a folder per drawer, the header as frontmatter, <code>[[Title]]</code> links, and a generated <code>index.md</code> and <code>log.md</code>.</p>
<p>It is one way: the database always wins. Anything edited in the repository is overwritten on the next run, and nothing is ever read back. The repository holds every person's pages with no sharing rules, so it is for you, the Engine owner, alone.</p>
<table><tbody>
<tr><td>Repository</td><td>${b["repo"] ? esc(b["repo"]) : "not set"}</td></tr>
<tr><td>Branch</td><td>${esc(b["branch"] ?? "main")}</td></tr>
<tr><td>Token saved</td><td>${yes(b["has_token"])}</td></tr>
<tr><td>Backup on</td><td>${yes(b["enabled"])}</td></tr>
<tr><td>Last run</td><td>${lastRun(b)}</td></tr>
</tbody></table>
<p><strong>${esc(nextStep(b))}</strong></p>
<p class="hint">It runs on the curator timer (the Timer screen), at most once every 20 hours.</p>`) +
    card(`<h2>Token</h2><p>Make a fine-grained GitHub token for this one repository only, with <em>Contents: read and write</em>. It is kept in Supabase Vault and never shown again.</p>
${postForm("/setup/backup/token", csrf, `<label for="backup_token">${b["has_token"] ? "Replace the token" : "GitHub token"}</label>
<input type="password" id="backup_token" name="backup_token" autocomplete="off" spellcheck="false" required maxlength="4096">`, "Save the token")}`) +
    card(`<h2>Repository</h2>${postForm("/setup/backup", csrf, `<label for="repo">Private repository (owner/name)</label>
<input type="text" id="repo" name="repo" value="${esc(repo)}" maxlength="140" pattern="[A-Za-z0-9-]+/[A-Za-z0-9._-]+" placeholder="acme/knowledge-backup">
<label for="branch">Branch</label><input type="text" id="branch" name="branch" value="${esc(branch)}" maxlength="100">
<label><input type="checkbox" name="enabled" value="yes"${enabled ? " checked" : ""}> Back up every night</label>`, "Save")}`) +
    card(`<h2>Back up now</h2>${postForm("/setup/backup/now", csrf, "", "Back up now")}<p class="hint">Runs a backup in the next minute instead of waiting for tonight, unless one is already running. Use it after setting up, or after changing the repository or token.</p>`);
  return page(c, "/setup/backup", "Backup", body, status);
}

const back = (c: Parameters<Handler>[0], done: keyof typeof DONE) => c.redirect(`/setup/backup?done=${done}`, 303);

const show: Handler = async (c, me, deps) => {
  const done = c.req.query("done");
  const top = done && Object.hasOwn(DONE, done) ? notice("ok", DONE[done] ?? "") : "";
  return screen(c, me, deps, top);
};

const save: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "backup");
  if (!sent.ok) return sent.response;
  const repo = (sent.form["repo"] ?? "").trim();
  const branch = (sent.form["branch"] ?? "").trim() || "main";
  const enabled = sent.form["enabled"] === "yes";
  const typed = { repo, branch, enabled };
  if ((repo !== "" && !REPO.test(repo)) || !BRANCH.test(branch) || branch.includes("..")) {
    return screen(c, me, deps, notice("error", "Not saved. The repository is owner/name and the branch a plain branch name."), typed, 400);
  }
  try {
    await deps.store.setBackup(me.email, repo === "" ? null : repo, branch, enabled);
  } catch (err) {
    if (err instanceof AppInputError) return screen(c, me, deps, notice("error", `Not saved: ${err.message}.`), typed, 400);
    throw err;
  }
  logger.info({ enabled }, "app: backup settings saved");
  return back(c, enabled ? "settings" : "off");
};

const saveToken: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "backup");
  if (!sent.ok) return sent.response;
  const value = (sent.form["backup_token"] ?? "").trim();
  if (value.length < 10 || value.length > 4096 || /\s/.test(value)) {
    return screen(c, me, deps, notice("error", "Not saved. Paste the whole token and nothing else (10 to 4096 characters, no spaces)."), {}, 400);
  }
  await deps.store.setBackupToken(me.email, value);
  logger.info({ secret: "kbe_backup_token" }, "app: backup token stored in vault");
  return back(c, "token");
};

/**
 * Back up now: make the run due (app_backup_request, which leaves a running
 * backup alone) and wake the curator through the timer's own poke
 * (app_timer_test), whose tick runs the backup through backup_claim, the same
 * "none running" lease as a nightly run.
 */
const now: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "backup");
  if (!sent.ok) return sent.response;
  const state = await deps.store.backup(me.email);
  if (!ready(state)) return screen(c, me, deps, notice("error", "Not started: the backup is not set up yet."), {}, 400);
  if (state["last_status"] === "running") return back(c, "running");
  const asked = await deps.store.requestBackup(me.email);
  if (asked["last_status"] === "running") return back(c, "running");
  const poke = await deps.store.testTimer(me.email).catch(() => null);
  logger.info({ woken: poke !== null }, "app: backup asked for now");
  return back(c, poke === null ? "queued" : "started");
};

export function makeBackupRoutes(use: () => SettingsDeps): Hono {
  const app = new Hono();
  const wrap = (h: Handler) => admin(use, h);
  app.get("/backup", wrap(show));
  app.post("/backup", wrap(save));
  app.post("/backup/token", wrap(saveToken));
  app.post("/backup/now", wrap(now));
  return app;
}
