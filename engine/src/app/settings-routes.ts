import { doDomainCard } from "../setup/page-plan.js";
import type { HostReach } from "./host-check.js";
import { Hono, type Context } from "hono";
import { loadTemplates, TEMPLATE_NAMES } from "../entities/templates.js";
import { logger } from "../log/logger.js";
import { isMcpAppError } from "../mcp/errors.js";
import { isEmail } from "../setup/inputs.js";
import { readForm, requireAdmin, storeFailure, type Allowed, type ScreenDeps } from "./guard.js";
import { appLayout, card, esc, hidden, notice, postForm, sendMessage, sendPage, when } from "./html.js";
import { AppMissingFunctionError, type Row } from "./store.js";
import { roleLabel, setChrome } from "./chrome.js";
import { adminMigrationState, updateBanner, type DatabaseDeps } from "./db-update.js";
import type { UpdatesDeps } from "./updates-routes.js";
import { sessionSentence } from "../setup/inputs.js";
import { curatorHealthCard, timerBrokenBanner } from "./curator-health.js";
import { cleanDisplayName, cleanPageName, defaultPageName, DISPLAY_NAME_MAX, PAGE_NAME_MAX } from "./page-name.js";

/**
 * The setup screens that come after sign-in, for administrators only (the
 * admin application with its second factor guards /setup/*):
 *
 *   /setup/people    topics and people (adds, grants and removals go through
 *                    the admin functions' preview-then-confirm, 0033; topics
 *                    are made here by administrators only, 0063). Each
 *                    person's source rules are theirs (/app/sources): this
 *                    screen shows only how many each person has. It also
 *                    holds your OWN display name and the name pages use for
 *                    you (0077): what the curator writes, "Ann decided ...".
 *   /setup/template  which business templates this Engine uses
 *   /setup/model     the curator's model key, straight into Supabase Vault
 *   /setup/timer     the curator timer (Supabase cron), and a test poke
 *   /setup/health    one page of checks and the Claude connector address
 *   /setup/database  migrations applied vs shipped, and the update (database-routes.ts)
 *   /setup/updates   running vs latest release and how to update (updates-routes.ts)
 *
 * No secret is ever shown: the model key is written and only reported as
 * "set"; the timer secret never leaves the database.
 */

export type SettingsDeps = ScreenDeps & {
  /** True when the embed function answers with a vector. */
  readonly embedCheck: () => Promise<boolean>;
  /** The search embedding of a text (the Index clerk's try-a-search box). Absent: search is not ready. */
  readonly embed?: (text: string) => Promise<number[]>;
  /** Whether https://<host> reaches this app (host-check.ts). Absent: not checked. */
  readonly hostCheck?: (host: string) => Promise<HostReach>;
  /** Migrations shipped vs applied, and the update. Absent: this app cannot tell. */
  readonly database?: DatabaseDeps;
  /** The Updates screen: running vs latest release (updates-routes.ts). Absent: it cannot check. */
  readonly updates?: UpdatesDeps;
};

export type Handler = (c: Context, me: Allowed, deps: SettingsDeps) => Promise<Response>;

/** An administrators-only handler with the shared error handling. */
export function admin(use: () => SettingsDeps, handler: Handler) {
  return async (c: Context) => {
    const deps = use();
    const me = await requireAdmin(c, deps);
    if (!me.ok) return me.response;
    try {
      let who: Row | null = null;
      try {
        who = await deps.store.whoami(me.email);
      } catch {
        // The menu then just says administrator.
      }
      setChrome(c, { email: me.email, role: roleLabel(who, "administrator"), isAdmin: true });
      return await handler(c, me, deps);
    } catch (err) {
      if (err instanceof AppMissingFunctionError) return updateNeeded(c, me, deps);
      if (isMcpAppError(err) && err.code !== "internal_error") {
        return sendMessage(c, "setup", 400, "Not done", err.message);
      }
      return storeFailure(c, "setup", err);
    }
  };
}

export const page = (c: Context, here: string, title: string, body: string, status: 200 | 400 | 422 | 503 = 200) =>
  sendPage(c, status, appLayout("setup", here, title, body));

/**
 * A screen whose database function is missing (PGRST202): the app was updated
 * and its migrations were not applied. The banner, never a raw failure.
 */
async function updateNeeded(c: Context, me: Allowed, deps: SettingsDeps): Promise<Response> {
  const state = await adminMigrationState(deps.database, () => deps.store.health(me.email)).catch(() => null);
  const banner = state ? updateBanner(state) : "";
  const body = banner ||
    '<div class="card errors" role="alert"><p><strong>Database update needed.</strong> This app was updated and its database was not. <a href="/setup/database">Update the database</a></p></div>';
  return page(c, "", "Database update needed", body, 503);
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const yes = (v: unknown) => (v === true ? "yes" : "no");

// ── topics and people ───────────────────────────────────────────────────────

const ROLES = ["reader", "reviewer", "administrator"] as const;

/** Your own names, or null when the database is older than 0077. */
async function myNames(deps: SettingsDeps, email: string): Promise<Row | null> {
  try {
    return await deps.store.myNames(email);
  } catch (err) {
    if (err instanceof AppMissingFunctionError) return null;
    throw err;
  }
}

/** The "Your name" card: display name and the name pages use for you. */
function namesCard(names: Row | null, csrf: string): string {
  if (!names) {
    return card('<h2>Your name</h2><p>Setting the name pages use for you needs a database update. <a href="/setup/database">Update the database</a></p>');
  }
  const display = String(names["display_name"] ?? "");
  const stored = typeof names["page_name"] === "string" ? names["page_name"] : "";
  const used = typeof names["page_name_used"] === "string" ? names["page_name_used"] : defaultPageName(display);
  const now = used
    ? `Pages call you <strong>${esc(used)}</strong>${stored ? "" : " (your name, as nothing else is set)"}.`
    : "Not set: pages call you <strong>the owner</strong>.";
  return card(`<h2>Your name</h2><p>${now}</p>${postForm("/setup/people/names", csrf, `<label for="display_name_self">Your name on this Engine</label>
<input type="text" id="display_name_self" name="display_name_self" value="${esc(display)}" required maxlength="${DISPLAY_NAME_MAX}">
<label for="page_name">Name used on pages</label>
<input type="text" id="page_name" name="page_name" value="${esc(stored)}" maxlength="${PAGE_NAME_MAX}" placeholder="e.g. your first name">`, "Save")}
<p class="hint">The curator writes pages with this name: "Ann decided ...", "Ann sent Pat the SOW". Leave it empty to use your name above. Pages already written keep their words.</p>`);
}

const people: Handler = async (c, me, deps) => {
  const [topics, persons, counts, names] = await Promise.all([
    deps.store.topics(me.email),
    deps.store.people(me.email),
    deps.store.peopleRuleCounts(me.email).catch(() => [] as Row[]),
    myNames(deps, me.email),
  ]);
  const csrf = deps.csrf.token(me.email, "people");
  const rulesOf = new Map(counts.map((r) => [String(r["email"] ?? "").toLowerCase(), Number(r["rules"] ?? 0)]));
  const topicRows = topics
    .map((t) => `<tr><td>${esc(t["topic"])}</td><td>${esc(t["label"])}</td><td>${t["sensitive"] ? "sensitive" : ""}</td><td>${esc(t["people"])}</td></tr>`)
    .join("");
  const personRows = persons
    .map((p) => `<tr><td>${esc(p["display_name"])}</td><td>${esc(p["email"] ?? "")}</td><td>${esc(p["role"])}</td><td>${p["active"] ? "" : "inactive"}</td><td>${esc(list(p["topics"]).join(", "))}</td><td>${esc(rulesOf.get(String(p["email"] ?? "").toLowerCase()) ?? 0)}</td></tr>`)
    .join("");
  const body =
    card(`<h2>Topics</h2><table><thead><tr><th>Topic</th><th>Label</th><th></th><th>People</th></tr></thead><tbody>${topicRows}</tbody></table>
<p class="hint">Only administrators make topics. People file their own sources under the topics they hold, with their own rules on <a href="/app/sources">Sources</a>.</p>`) +
    card(`<h2>Make a topic</h2>${postForm("/setup/people/topic", csrf, `<label for="ntopic">Topic id</label><input type="text" id="ntopic" name="topic" required maxlength="40" pattern="[a-z][a-z0-9-]{0,39}">
<label for="nlabel">Label</label><input type="text" id="nlabel" name="label" required maxlength="80">
<label><input type="checkbox" name="sensitive" value="yes"> Sensitive (giving it needs an extra yes)</label>`, "Preview")}<p class="hint">A new topic is held by nobody until you give it to someone below.</p>`) +
    card(`<h2>People</h2><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th><th>Topics</th><th>Source rules</th></tr></thead><tbody>${personRows}</tbody></table>
<p class="hint">Source rules: how many rules each person has written for their own sources. Their contents are theirs alone.</p>`) +
    card(`<h2>Add a person</h2>${postForm("/setup/people/change", csrf, `${hidden("action", "add")}
<label for="email">Email</label><input type="email" id="email" name="email" required maxlength="254">
<label for="display_name">Name</label><input type="text" id="display_name" name="display_name" required maxlength="120">
<label for="role">Role</label><select id="role" name="role">${ROLES.map((r) => `<option value="${r}">${r}</option>`).join("")}</select>
<label><input type="checkbox" name="admin_ack" value="yes"> I mean to add an administrator</label>`, "Preview")}`) +
    card(`<h2>Remove a person</h2>${postForm("/setup/people/change", csrf, `${hidden("action", "deactivate")}
<label for="remove_email">Person's email</label><input type="email" id="remove_email" name="email" required maxlength="254">`, "Preview")}<p class="hint">They lose access at once; their own pages, items and rules are kept and come back if they are added again.</p>`) +
    card(`<h2>Give or take a topic</h2>${postForm("/setup/people/change", csrf, `<label for="action">Change</label><select id="action" name="action"><option value="grant">Give the topic</option><option value="revoke">Take the topic away</option></select>
<label for="person_email">Person's email</label><input type="email" id="person_email" name="email" required maxlength="254">
<label for="gtopic">Topic</label><input type="text" id="gtopic" name="topic" required maxlength="40">
<label><input type="checkbox" name="sensitive_ack" value="yes"> I mean to give a sensitive topic</label>`, "Preview")}<p class="hint">Every change is previewed first. Nothing changes until you confirm.</p>`) +
    namesCard(names, csrf);
  return page(c, "/setup/people", "Topics and people", body);
};

/** Save your OWN names (never anyone else's; the database checks the same). */
const saveNames: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "people");
  if (!sent.ok) return sent.response;
  const display = cleanDisplayName(sent.form["display_name_self"]);
  const pageName = cleanPageName(sent.form["page_name"]);
  const problems = [...(display.ok ? [] : [display.error]), ...(pageName.ok ? [] : [pageName.error])];
  if (!display.ok || !pageName.ok) {
    return page(c, "/setup/people", "Not saved", problems.map((p) => notice("error", p)).join(""), 400);
  }
  const saved = await deps.store.setMyNames(me.email, display.value, pageName.value);
  logger.info({ page_name_set: pageName.value !== null }, "app: own names saved");
  const used = typeof saved["page_name_used"] === "string" ? saved["page_name_used"] : pageName.value ?? defaultPageName(display.value);
  return sendMessage(c, "setup", 200, "Saved", used ? `Pages now call you ${used}. Pages already written keep their words.` : "Saved. Pages call you the owner until you set a name.");
};

const TOPIC = /^[a-z][a-z0-9-]{0,39}$/;

/** Make a topic: preview, then an explicit yes. Administrators only (also checked in the database). */
const addTopic: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "people");
  if (!sent.ok) return sent.response;
  const topic = (sent.form["topic"] ?? "").trim().toLowerCase();
  const label = (sent.form["label"] ?? "").trim();
  const sensitive = sent.form["sensitive"] === "yes";
  if (!TOPIC.test(topic) || topic === "unclassified") {
    return page(c, "/setup/people", "Not accepted", notice("error", "A topic id is 1 to 40 lower-case letters, digits or dashes, starting with a letter."), 400);
  }
  if (label.length < 1 || label.length > 80) return page(c, "/setup/people", "Not accepted", notice("error", "A label is 1 to 80 characters."), 400);
  if (sent.form["confirm"] !== "yes") {
    const body = card(`<h2>Make this topic?</h2><p><strong>${esc(topic)}</strong> (${esc(label)})${sensitive ? ", sensitive" : ""}. Nobody holds it until you give it to someone.</p>
${postForm("/setup/people/topic", deps.csrf.token(me.email, "people"), `${hidden("topic", topic)}${hidden("label", label)}${sensitive ? hidden("sensitive", "yes") : ""}${hidden("confirm", "yes")}`, "Yes, make it")}
<p><a href="/setup/people">No, go back</a></p>`);
    return page(c, "/setup/people", "Confirm", body);
  }
  const made = await deps.store.addTopic(me.email, topic, label, sensitive);
  logger.info({ topic, made }, "app: topic made");
  return sendMessage(c, "setup", 200, made ? "Topic made" : "Already there", made ? `The topic ${topic} exists now. Give it to people below.` : `There is already a topic ${topic}; it was not changed.`);
};

type Change = { readonly fn: string; readonly args: Readonly<Record<string, string | boolean>> };

function changeFrom(form: Readonly<Record<string, string>>): Change | string {
  const email = (form["email"] ?? "").trim().toLowerCase();
  if (!isEmail(email)) return "That is not a plain email address.";
  const action = form["action"];
  if (action === "add") {
    const name = (form["display_name"] ?? "").trim();
    const role = form["role"] ?? "";
    if (name.length < 1 || name.length > 120) return "A name is 1 to 120 characters.";
    if (!(ROLES as readonly string[]).includes(role)) return "Choose a role.";
    return { fn: "admin_person_add", args: { p_new_email: email, p_display_name: name, p_role: role, p_admin_ack: form["admin_ack"] === "yes" } };
  }
  if (action === "deactivate") return { fn: "admin_person_deactivate", args: { p_person_email: email } };
  const topic = (form["topic"] ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(topic)) return "That is not a topic name.";
  if (action === "grant") return { fn: "admin_grant", args: { p_person_email: email, p_topic: topic, p_sensitive_ack: form["sensitive_ack"] === "yes" } };
  if (action === "revoke") return { fn: "admin_revoke", args: { p_person_email: email, p_topic: topic } };
  return "Choose a change.";
}

const change: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "people");
  if (!sent.ok) return sent.response;
  const wanted = changeFrom(sent.form);
  if (typeof wanted === "string") return page(c, "/setup/people", "Not accepted", notice("error", wanted), 400);
  const code = sent.form["confirm_code"];
  if (code !== undefined && !/^[0-9a-f]{32}$/.test(code)) return sendMessage(c, "setup", 400, "Not accepted", "Start the change again.");
  const result = await deps.store.twoStep(me.email, { fn: wanted.fn, args: wanted.args, ...(code ? { confirmCode: code } : {}) });
  if (result.status === "applied") {
    logger.info({ change: wanted.fn }, "app: people change applied");
    return sendMessage(c, "setup", 200, "Done", result.summary || "The change was made.");
  }
  // Preview: show it and ask for an explicit yes. The same fields go back with the code.
  const fields = Object.entries(sent.form)
    .filter(([k]) => ["action", "email", "display_name", "role", "admin_ack", "topic", "sensitive_ack"].includes(k))
    .map(([k, v]) => hidden(k, v))
    .join("");
  const body = card(`<h2>Check this change</h2><pre>${esc(result.preview)}</pre>`) +
    card(postForm("/setup/people/change", deps.csrf.token(me.email, "people"), `${fields}${hidden("confirm_code", result.confirm_code)}`, "Yes, make this change") +
      '<p><a href="/setup/people">No, go back</a></p><p class="hint">The confirmation works once, for this exact change, for 10 minutes.</p>');
  return page(c, "/setup/people", "Confirm", body);
};

// ── template ────────────────────────────────────────────────────────────────

const CHOOSABLE = TEMPLATE_NAMES.filter((n) => n !== "base");

const template: Handler = async (c, me, deps) => {
  const chosen = new Set(await deps.store.templates());
  const all = loadTemplates();
  const boxes = CHOOSABLE.map((name) => {
    const t = all.get(name);
    const drawers = (t?.drawers ?? []).map((d) => d.label).join(", ");
    const adds = drawers
      ? `Adds: ${esc(drawers)}`
      : `Uses the ${all.get("base")?.drawers.length ?? 8} base drawers; adds no extra drawers.`;
    return `<label><input type="checkbox" name="template" value="${esc(name)}"${chosen.has(name) ? " checked" : ""}> <strong>${esc(t?.label ?? name)}</strong>: ${esc(t?.description ?? "")} <span class="hint">${adds}</span></label>`;
  }).join("");
  const base = (all.get("base")?.drawers ?? []).map((d) => d.label).join(", ");
  const body = card(`<p>Every Engine files pages in the basic drawers: ${esc(base)}. Pick the kinds of business this Engine is for; each adds its own drawers. The curator, get_entity_schema and save_page all use this choice.</p>
${postForm("/setup/template", deps.csrf.token(me.email, "template"), boxes, "Save")}`);
  return page(c, "/setup/template", "Template", body);
};

const saveTemplate: Handler = async (c, me, deps) => {
  if (!(c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
    return sendMessage(c, "setup", 415, "Not accepted", "Send this form from the page itself.");
  }
  // Several boxes share a name, so read all of them.
  const raw = await c.req.raw.clone().text().catch(() => "");
  const names = new URLSearchParams(raw).getAll("template");
  const sent = await readForm(c, deps, "setup", me.email, "template");
  if (!sent.ok) return sent.response;
  const bad = names.filter((n) => !CHOOSABLE.includes(n));
  if (bad.length > 0 || names.length > 10) return page(c, "/setup/template", "Not saved", notice("error", "Choose from the templates listed."), 400);
  const saved = await deps.store.setTemplates(me.email, names);
  logger.info({ templates: saved }, "app: templates chosen");
  return sendMessage(c, "setup", 200, "Saved", saved.length ? `This Engine uses: base, ${saved.join(", ")}.` : "This Engine uses the basic drawers only.");
};

// ── model key ───────────────────────────────────────────────────────────────

const model: Handler = async (c, me, deps) => {
  const timer = await deps.store.timer(me.email);
  const health = await deps.store.health(me.email);
  const body = card(`<p>The curator runs on <strong>${esc(timer["model"] ?? "openai-gpt-oss-120b")}</strong> through DigitalOcean's serverless inference. It needs a model access key from your DigitalOcean account.</p>
<p>Key stored: <strong>${health["has_model_key"] ? "yes" : "no"}</strong>. It is kept in Supabase Vault and is never shown again, here or anywhere.</p>
${postForm("/setup/model", deps.csrf.token(me.email, "model"), `<label for="model_key">${health["has_model_key"] ? "Replace the key" : "Model access key"}</label>
<input type="password" id="model_key" name="model_key" autocomplete="off" spellcheck="false" required maxlength="4096">`, "Save the key")}`);
  return page(c, "/setup/model", "Model key", body);
};

const saveModel: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "model");
  if (!sent.ok) return sent.response;
  const value = (sent.form["model_key"] ?? "").trim();
  if (value.length < 10 || value.length > 4096 || /\s/.test(value)) {
    return page(c, "/setup/model", "Not saved", notice("error", "Paste the whole key and nothing else (10 to 4096 characters, no spaces)."), 400);
  }
  await deps.store.setModelKey(me.email, value);
  logger.info({ secret: "kbe_model_key" }, "app: model key stored in vault");
  return sendMessage(c, "setup", 200, "Key saved", "The model key is in Supabase Vault. It is not shown again.");
};

// ── timer ───────────────────────────────────────────────────────────────────

function testVerdict(result: Row | null): string {
  if (!result) return "No answer recorded yet. Open this page again in a few seconds.";
  const code = Number(result["status_code"]);
  if (result["timed_out"] === true) return "The poke timed out: the service did not answer in 5 seconds.";
  if (code === 202 || code === 200) return `Works: the service answered ${code}.`;
  if (code === 401) return "The service refused the timer secret (401). Save the timer again.";
  if (code === 302 || code === 403) {
    return `Cloudflare sign-in stopped the poke (${code}). The path /internal/curator/tick needs its sign-in bypass: run the sign-in setup again (it adds it), then test again.`;
  }
  return `The poke got HTTP ${Number.isFinite(code) ? code : "error"}${result["error"] ? ` (${String(result["error"])})` : ""}.`;
}

const timer: Handler = async (c, me, deps) => {
  const t = await deps.store.timer(me.email);
  const job = object(t["job"]);
  const last = object(t["last_run"]);
  const url = `https://${me.access.host}/internal/curator/tick`;
  const csrf = deps.csrf.token(me.email, "timer");
  const testId = c.req.query("test");
  const test = testId && /^\d{1,18}$/.test(testId) ? notice("ok", testVerdict(await deps.store.timerResult(me.email, Number(testId)))) : "";
  const curatorHealth = await deps.store.curatorHealth(me.email).catch(() => null);
  const health = curatorHealthCard(curatorHealth);
  const body = timerBrokenBanner(curatorHealth) + test + card(`<p>The curator wakes when new items arrive (at most once every 2 minutes), and runs once every hour as a safety net for retries, summaries and the nightly backup. An hour with nothing waiting costs no model tokens.</p>
<p>Supabase pokes the service at this address; the poke carries a secret that is made inside the database and never leaves it:</p>
<p><code class="address">${esc(url)}</code></p>
<table><tbody>
<tr><td>pg_cron / pg_net / Vault</td><td>${yes(t["cron_available"])} / ${yes(t["net_available"])} / ${yes(t["vault_available"])}</td></tr>
<tr><td>Hourly safety tick</td><td>${job["schedule"] ? `on${job["active"] ? "" : " (paused)"}` : "off"}</td></tr>
<tr><td>Last woken by new items</td><td>${esc(when(t["last_wake_at"])) || "not yet"}</td></tr>
<tr><td>Curator on</td><td>${yes(t["enabled"])}</td></tr>
<tr><td>Timer secret made</td><td>${yes(t["tick_secret_set"])}</td></tr>
<tr><td>Last run</td><td>${last["status"] ? `${esc(last["status"])}, ${esc(when(last["started_at"]))}` : "never"}</td></tr>
</tbody></table>`) +
    health +
    card(postForm("/setup/timer", csrf, `<label><input type="checkbox" name="enabled" value="yes"${t["enabled"] ? " checked" : ""}> Curator on</label>`, "Save")) +
    card(`${postForm("/setup/timer/test", csrf, "", "Test the timer now")}<p class="hint">Cloudflare sign-in sits in front of every path of this app. The sign-in setup adds a bypass for <code>/internal/curator/tick</code> only, which is guarded by the timer secret instead. An Engine whose sign-in was set up before this screen existed needs the sign-in setup run once more.</p>`);
  return page(c, "/setup/timer", "Timer", body);
};

const saveTimer: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "timer");
  if (!sent.ok) return sent.response;
  // The timer only ever calls this Engine's own host (the signed-in Access
  // host); the database checks the same against its stored host.
  const own = `https://${me.access.host}/internal/curator/tick`;
  const url = (sent.form["engine_url"] ?? own).trim();
  if (url !== own) {
    return page(c, "/setup/timer", "Not saved", notice("error", `The timer only calls ${own}.`), 400);
  }
  const enabled = sent.form["enabled"] === "yes";
  await deps.store.setTimer(me.email, me.access.host, enabled);
  logger.info({ enabled }, "app: timer saved");
  return sendMessage(c, "setup", 200, "Timer saved", enabled ? "The curator is on: it runs when new items arrive (at most every 2 minutes) and every hour." : "The curator is off.");
};

const testTimer: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "timer");
  if (!sent.ok) return sent.response;
  const id = await deps.store.testTimer(me.email);
  if (id === null) return sendMessage(c, "setup", 409, "Nothing to test", "Save the timer (with the curator on) first.");
  return c.redirect(`/setup/timer?test=${id}`, 303);
};

// ── health ──────────────────────────────────────────────────────────────────

const health: Handler = async (c, me, deps) => {
  const h = await deps.store.health(me.email);
  let embedOk = false;
  try {
    embedOk = await deps.embedCheck();
  } catch {
    embedOk = false;
  }
  const reach: HostReach = deps.hostCheck
    ? await deps.hostCheck(me.access.host).catch(() => ({ ok: false, detail: "The check failed." }))
    : { ok: true, detail: "not checked" };
  const timer = object(h["timer"]);
  const migrations = object(h["migrations"]);
  const state = await adminMigrationState(deps.database, async () => h);
  const behind = state.known && state.pending.length > 0;
  const checks: Array<[string, boolean, string]> = [
    ["Database tables", Number(migrations["count"] ?? 0) > 0 && !behind, `${esc(migrations["count"] ?? 0)} migrations, latest ${esc(migrations["latest"] ?? "none")}${behind ? ` · <a href="/setup/database">${esc(state.pending.length)} pending</a>` : ""}`],
    ["An owner", Number(h["administrators"] ?? 0) > 0, `${esc(h["administrators"] ?? 0)} administrator(s), ${esc(h["people"] ?? 0)} people`],
    ["Sign-in", true, `Cloudflare sign-in for ${esc(me.access.host)}. ${esc(sessionSentence(me.access.session))}`],
    ["Hostname reaches the app", reach.ok, esc(reach.detail)],
    ["Topics", Number(h["topics"] ?? 0) > 0, `${esc(h["topics"] ?? 0)} topics`],
    ["Template", true, `base${list(h["templates"]).map((t) => `, ${esc(t)}`).join("")}`],
    ["Embedding", embedOk, embedOk ? "the embed function answers" : "the embed function did not answer"],
    ["Model key", h["has_model_key"] === true, h["has_model_key"] ? "stored in Vault" : "not set: the curator cannot run"],
    ["Timer", !!object(timer["job"])["schedule"] && timer["enabled"] === true, object(timer["job"])["schedule"] ? "on: new items and every hour" : "off"],
  ];
  const rows = checks.map(([name, ok, text]) => `<tr><td>${ok ? "OK" : "Needs work"}</td><td>${esc(name)}</td><td>${text}</td></tr>`).join("");
  const curatorHealth = await deps.store.curatorHealth(me.email).catch(() => null);
  const body = updateBanner(state) + timerBrokenBanner(curatorHealth) + card(`<table><thead><tr><th></th><th>Check</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
<p>Waiting for a yes: ${esc(h["pending_reviews"] ?? 0)} · flagged: ${esc(h["flagged"] ?? 0)}</p>`) +
    (reach.ok ? "" : doDomainCard(me.access.host)) +
    card(`<h2>Connect Claude</h2><p>Add a custom connector in Claude with this address:</p><pre>${esc(me.access.resourceUrl)}</pre><p>People open their own pages, changes waiting for a yes and flagged items at <a href="/app">/app</a>.</p>`);
  return page(c, "/setup/health", "Health", body);
};

export function makeSettingsRoutes(use: () => SettingsDeps): Hono {
  const app = new Hono();
  app.get("/people", admin(use, people));
  app.post("/people/topic", admin(use, addTopic));
  app.post("/people/change", admin(use, change));
  app.post("/people/names", admin(use, saveNames));
  app.get("/template", admin(use, template));
  app.post("/template", admin(use, saveTemplate));
  app.get("/model", admin(use, model));
  app.post("/model", admin(use, saveModel));
  app.get("/timer", admin(use, timer));
  app.post("/timer", admin(use, saveTimer));
  app.post("/timer/test", admin(use, testTimer));
  app.get("/health", admin(use, health));
  return app;
}
