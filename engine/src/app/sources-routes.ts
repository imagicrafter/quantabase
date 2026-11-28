import type { Context, Hono } from "hono";
import { logger } from "../log/logger.js";
import { isRuleSource, parseRules, type Rule, type RuleSource } from "../sources/rules.js";
import { readForm, UUID, type Allowed, type ScreenDeps } from "./guard.js";
import { parseSuggestions } from "../sources/mail-contacts.js";
import { appLayout, card, COPY_SCRIPT, esc, hidden, notice, postForm, sendMessage, sendPage } from "./html.js";
import { applyOp, describeRule, forSave, needsYes, parseTarget, ruleFromForm, type RuleOp } from "./sources-edit.js";
import {
  accountsCard, addAccountCard, addRuleCard, historyHtml, pickerOf, previewHtml, recheckPagesCard, rulesCard,
  sessionsCard, SOURCE_LABEL, sourcesIntroCard, suggestionsCard, toolsCard,
} from "./sources-view.js";
import { parsePicks, rulesFromPicks } from "./sources-suggest.js";
import { gmailPromptsCard, mailSuggestionsCard } from "./sources-suggest-view.js";
import { AppMissingFunctionError, type Row } from "./store.js";
import { addFirefliesRoutes } from "./fireflies-routes.js";
import { connectCard, webhookCard } from "./fireflies-view.js";

/**
 * Sources, under /app, for every person (administrators included): their OWN
 * source accounts and inclusion rules (0063, docs/source-rules.md).
 *
 *   /app/sources                   my accounts, add one, pages to re-check
 *   /app/sources/:id               the rule list: order, add, remove, topic
 *   /app/sources/:id/preview       dry-run of the rules on the metadata sample
 *   /app/sources/:id/history       versions and audit
 *   /app/sources/:id/suggested     add ticked mail suggestions as rules (0080)
 *   /app/sources/fireflies/...     the Fireflies webhook (0081, fireflies-routes.ts)
 *
 * The database decides who may read or change what: each function takes the
 * signed-in email and refuses an account that is not the caller's, even an
 * administrator's (they see only a count of other people's rules, on Topics
 * and people). An edit that could let more people see new items is shown as
 * a dry-run first and needs an explicit yes.
 */

type Handler = (c: Context, me: Allowed, deps: ScreenDeps) => Promise<Response>;

const SCOPE = "sources";
const HERE = "/app/sources";

const page = (c: Context, title: string, body: string, status: 200 | 400 = 200) =>
  sendPage(c, status, appLayout("app", HERE, title, body));

function accountId(c: Context): string | null {
  const id = c.req.param("id") ?? "";
  return UUID.test(id) ? id : null;
}

const notFound = (c: Context) => sendMessage(c, "app", 404, "Not found", "There is no such source account of yours.");

const sourcesHome: Handler = async (c, me, deps) => {
  const [accounts, pages, sessions] = await Promise.all([
    deps.store.sourceAccounts(me.email), deps.store.recheckPages(me.email),
    // Before 0076 is applied the summary function is missing: the card says so, the page still works.
    deps.store.sourceSummary(me.email, "claude-code").catch((e: unknown) => (e instanceof AppMissingFunctionError ? null : Promise.reject(e))),
  ]);
  const csrf = deps.csrf.token(me.email, SCOPE);
  const prompts = gmailPromptsCard(accounts);
  const fireflies = deps.fireflies ? connectCard(csrf) : "";
  const body = sourcesIntroCard() + prompts + accountsCard(accounts) + fireflies + sessionsCard(sessions) + recheckPagesCard(pages, csrf) + addAccountCard(csrf);
  if (prompts === "") return page(c, "Sources", body);
  return sendPage(c, 200, appLayout("app", HERE, "Sources", body + COPY_SCRIPT), { script: true });
};

const addAccount: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const source = sent.form["source"] ?? "";
  const account = (sent.form["account"] ?? "").trim().toLowerCase();
  if (!isRuleSource(source)) return page(c, "Not added", notice("error", "Choose Gmail or Fireflies."), 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account) || account.length > 254) {
    return page(c, "Not added", notice("error", "That is not an email address."), 400);
  }
  const row = await deps.store.addSourceAccount(me.email, source, account);
  logger.info({ source }, "app: source account added");
  return c.redirect(`/app/sources/${String(row["id"])}`, 303);
};

/** The account's mail suggestions (0080): null before 0080 is applied; none for a Fireflies account. */
async function mailContactsOf(deps: ScreenDeps, email: string, id: string, row: Row): Promise<Row | null> {
  if (String(row["source"]) !== "gmail") return {};
  if (!deps.store.mailContacts) return null;
  return deps.store.mailContacts(email, id).catch((e: unknown) => (e instanceof AppMissingFunctionError ? null : Promise.reject(e)));
}

/** A Fireflies account's webhook card (0081): "" for Gmail, or when the Engine or its database is older. */
async function webhookOf(c: Context, me: Allowed, deps: ScreenDeps, id: string, row: Row, csrf: string): Promise<string> {
  const ff = deps.fireflies;
  if (String(row["source"]) !== "fireflies" || !ff) return "";
  const state = await ff.store.get(me.email, id).catch((e: unknown) => (e instanceof AppMissingFunctionError ? null : Promise.reject(e)));
  if (!state) return "";
  const note = c.req.query("connected") === "1" && state["connected"] === true
    ? `<p class="hint saved-note" role="status">Connected as ${esc(state["fireflies_email"])}. Now paste the address and the secret below into Fireflies.</p>`
    : "";
  return note + webhookCard(state, csrf, me.access.host, `/app/sources/${id}`, ff.jobs.isRunning(id));
}

const accountPage: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  const row = await deps.store.sourceRules(me.email, id);
  const contacts = await mailContactsOf(deps, me.email, id, row);
  const csrf = deps.csrf.token(me.email, SCOPE);
  const title = `${SOURCE_LABEL[String(row["source"])] ?? String(row["source"])}: ${String(row["account"] ?? "")}`;
  const counts = card(`<p>${esc(row["items_saved"] ?? 0)} items kept · ${esc(row["items_skipped"] ?? 0)} left out by the rules. <a href="/app/sources">All your sources</a></p>`);
  const hook = await webhookOf(c, me, deps, id, row, csrf);
  const mail = mailSuggestionsCard(row, contacts, csrf, new Date());
  const split =
    `<div class="rules-split"><div class="rules-builder">${mail}${addRuleCard(row, csrf)}${suggestionsCard(row, csrf)}</div>` +
    `<div class="rules-list">${savedNote(c)}${rulesCard(row, csrf)}</div></div>`;
  const body = counts + hook + split + toolsCard(row, csrf);
  if (mail === "" && hook === "") return page(c, title, body);
  return sendPage(c, 200, appLayout("app", HERE, title, body + COPY_SCRIPT), { script: true });
};

/** After a save the screen reloads with ?saved=<version> (and re-file counts): a small note, not a page of its own. */
function savedNote(c: Context): string {
  const saved = c.req.query("saved") ?? "";
  if (!/^\d{1,9}$/.test(saved)) return "";
  const refiled = Number(/^\d{1,9}$/.test(c.req.query("refiled") ?? "") ? c.req.query("refiled") : 0);
  const flagged = Number(/^\d{1,9}$/.test(c.req.query("flagged") ?? "") ? c.req.query("flagged") : 0);
  const extra = refiled > 0
    ? ` ${refiled} items already kept lost their topic and are only yours until you re-check them; ${flagged} pages built from them are marked for re-checking.`
    : "";
  return `<p class="hint saved-note" role="status">Saved. Version ${esc(saved)} is in force.${esc(extra)}</p>`;
}

/** The several values a repeated form field carries (checkboxes). */
async function allValues(c: Context, name: string): Promise<readonly string[]> {
  const raw = await c.req.raw.clone().text().catch(() => "");
  return new URLSearchParams(raw).getAll(name);
}

function opFrom(form: Readonly<Record<string, string>>, labels: readonly string[], row: Row): RuleOp | string {
  const index = Number(form["index"] ?? "-1");
  const topics = Array.isArray(row["topics"]) ? row["topics"].map(String) : [];
  switch (form["op"]) {
    case "add": {
      const rule = ruleFromForm(
        String(row["source"]) as RuleSource,
        { kind: form["kind"] ?? "", name: form["name"] ?? "", target: form["target"] ?? "", text: form, labels },
        pickerOf(row),
        topics,
      );
      return typeof rule === "string" ? rule : { op: "add", rule };
    }
    case "delete":
    case "up":
    case "down":
      return { op: form["op"], index };
    case "target": {
      const target = parseTarget(form["target"] ?? "", topics);
      return typeof target === "string" ? target : { op: "target", index, target };
    }
    default:
      return "Choose a change.";
  }
}

function confirmPage(c: Context, me: Allowed, deps: ScreenDeps, id: string, version: number, next: readonly Rule[], change: string, preview: Row): Response {
  const csrf = deps.csrf.token(me.email, SCOPE);
  const body = card(`<h2>Check this change</h2><p>${esc(change)}</p>
<p>From now on, new items these rules file under a topic are seen by everyone who holds that topic. Items already kept are not moved to a wider topic (ask for a backfill to pick up older items).</p>`) +
    card(`<h2>Dry-run on the last 7 days</h2>${previewHtml(preview, next)}`) +
    card(postForm(`/app/sources/${id}/rules`, csrf, `${hidden("op", "confirm")}${hidden("version", String(version))}${hidden("rules", JSON.stringify(next.map(forSave)))}`, "Yes, save these rules") +
      `<p><a href="/app/sources/${esc(id)}">No, go back</a></p>`);
  return page(c, "Confirm", body);
}

async function save(c: Context, me: Allowed, deps: ScreenDeps, id: string, rules: readonly Rule[], version: number): Promise<Response> {
  const result = await deps.store.saveSourceRules(me.email, id, rules.map(forSave), version);
  logger.info({ version: result["version"], refiled: result["refiled"] }, "app: source rules saved");
  const refiled = Number(result["refiled"] ?? 0);
  const flagged = Number(result["pages_flagged"] ?? 0);
  const saved = Number(result["version"] ?? 0);
  const counts = refiled > 0 ? `&refiled=${refiled}&flagged=${flagged}` : "";
  // Stay on the same screen: the new rule shows in the list, the version as a note.
  return c.redirect(`/app/sources/${id}?saved=${saved}${counts}`, 303);
}

const changeRules: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  // Several boxes share a name: read them all before the form is parsed.
  const labels = await allValues(c, "label");
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const version = Number(sent.form["version"] ?? "-1");
  if (!Number.isInteger(version) || version < 0) return page(c, "Not saved", notice("error", "Open the rules again."), 400);

  if (sent.form["op"] === "confirm") {
    let rules: readonly Rule[];
    try {
      rules = parseRules(JSON.parse(sent.form["rules"] ?? "[]"));
    } catch {
      return page(c, "Not saved", notice("error", "Open the rules again."), 400);
    }
    return save(c, me, deps, id, rules, version);
  }

  const row = await deps.store.sourceRules(me.email, id);
  const current = parseRules(row["rules"]);
  const op = opFrom(sent.form, labels, row);
  if (typeof op === "string") return page(c, "Not saved", notice("error", op), 400);
  const next = applyOp(current, op);
  if (typeof next === "string") return page(c, "Not saved", notice("error", next), 400);
  if (!needsYes(current, op)) return save(c, me, deps, id, next, version);
  const preview = await deps.store.previewSourceRules(me.email, id, next.map(forSave));
  const change = op.op === "add" ? `Add: ${describeRule(op.rule)}.` : op.op === "target" ? "Change where a rule files items." : op.op === "delete" ? "Remove an exclude rule." : "Change the order of the rules.";
  return confirmPage(c, me, deps, id, version, next, change, preview);
};

/** Ticked mail suggestions become ordinary include rules, saved like any other add. */
const addSuggested: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  const picks = await allValues(c, "pick");
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const version = Number(sent.form["version"] ?? "-1");
  if (!Number.isInteger(version) || version < 0) return page(c, "Not saved", notice("error", "Open the rules again."), 400);
  const row = await deps.store.sourceRules(me.email, id);
  const contacts = await mailContactsOf(deps, me.email, id, row);
  const current = parseRules(row["rules"]);
  const chosen = parsePicks(picks, parseSuggestions(contacts?.["contacts"]), current);
  if (typeof chosen === "string") return page(c, "Not saved", notice("error", chosen), 400);
  const topics = Array.isArray(row["topics"]) ? row["topics"].map(String) : [];
  const added = rulesFromPicks(chosen, sent.form["target"] ?? "", topics, pickerOf(row));
  if (typeof added === "string") return page(c, "Not saved", notice("error", added), 400);
  const next = added.reduce<readonly Rule[] | string>((acc, rule) => (typeof acc === "string" ? acc : applyOp(acc, { op: "add", rule })), current);
  if (typeof next === "string") return page(c, "Not saved", notice("error", next), 400);
  if (!added.some((rule) => needsYes(current, { op: "add", rule }))) return save(c, me, deps, id, next, version);
  const result = await deps.store.previewSourceRules(me.email, id, next.map(forSave));
  return confirmPage(c, me, deps, id, version, next, `Add ${added.length} ${added.length === 1 ? "rule" : "rules"} from your mail: ${added.map(describeRule).join("; ")}.`, result);
};

const preview: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  const row = await deps.store.sourceRules(me.email, id);
  const rules = parseRules(row["rules"]);
  const result = await deps.store.previewSourceRules(me.email, id, rules.map(forSave));
  return page(c, "Dry-run", card(`${previewHtml(result, rules)}<p><a href="/app/sources/${esc(id)}">Back to the rules</a></p>`));
};

const history: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  const row = await deps.store.sourceRulesHistory(me.email, id);
  return page(c, "Rule versions", historyHtml(row) + `<p><a href="/app/sources/${esc(id)}">Back to the rules</a></p>`);
};

const recheck: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const r = await deps.store.recheckSource(me.email, id);
  return sendMessage(c, "app", 200, "Re-checked", `${String(r["refiled"] ?? 0)} items filed under the rules in force; ${String(r["removed"] ?? 0)} no rule includes were removed.`);
};

const backfill: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const since = sent.form["since"] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) {
    return page(c, "Not saved", notice("error", "Choose a date."), 400);
  }
  await deps.store.backfillSource(me.email, id, `${since}T00:00:00Z`);
  return sendMessage(c, "app", 200, "Backfill asked for", `The next ingest run for this account goes back to ${since}. Your rules still decide what is kept.`);
};

const sample: Handler = async (c, me, deps) => {
  const id = accountId(c);
  if (!id) return notFound(c);
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  await deps.store.requestSample(me.email, id);
  return sendMessage(c, "app", 200, "Sample asked for", "The next ingest run for this account sends a metadata sample of the last 7 days for the dry-run.");
};

const pageDone: Handler = async (c, me, deps) => {
  const id = c.req.param("pid") ?? "";
  if (!UUID.test(id)) return sendMessage(c, "app", 404, "Not found", "There is no such page.");
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  await deps.store.pageRecheckDone(me.email, id);
  return c.redirect("/app/sources", 303);
};

/** Mount the Sources screens on the owner routes, behind their sign-in wrapper. */
export function addSourceRoutes(app: Hono, h: (handler: Handler) => (c: Context) => Promise<Response>): void {
  app.get("/sources", h(sourcesHome));
  addFirefliesRoutes(app, h);
  app.post("/sources/add", h(addAccount));
  app.post("/sources/pages/:pid/done", h(pageDone));
  app.get("/sources/:id", h(accountPage));
  app.post("/sources/:id/rules", h(changeRules));
  app.post("/sources/:id/suggested", h(addSuggested));
  app.get("/sources/:id/preview", h(preview));
  app.get("/sources/:id/history", h(history));
  app.post("/sources/:id/recheck", h(recheck));
  app.post("/sources/:id/backfill", h(backfill));
  app.post("/sources/:id/sample", h(sample));
}
