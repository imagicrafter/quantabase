import { Hono, type Context } from "hono";
import { applyPatches, type Patch } from "../entities/sections.js";
import { markHandSet } from "../entities/hand-set.js";
import { logger } from "../log/logger.js";
import { diffHtml, lineDiff } from "./diff.js";
import { readForm, requirePerson, storeFailure, UUID, type Allowed, type ScreenDeps } from "./guard.js";
import { appLayout, card, esc, hidden, notice, postForm, sendMessage, sendPage, when } from "./html.js";
import { buildTree, roleLabel, setChrome } from "./chrome.js";
import { chosenDrawers } from "./knowledge.js";
import {
  drawerFor, knowledgeDrawer, knowledgeHome, markReviewed, openByKey, pageAlone, pageEdit, pinPage,
} from "./knowledge-routes.js";
import { editedProperties, MAX_BODY } from "./page-view.js";
import type { Row } from "./store.js";
import { addSourceRoutes } from "./sources-routes.js";
import { addDuplicateRoutes } from "./duplicates-routes.js";
import { addTodoRoutes } from "./todo-routes.js";
import { addTicketRoutes } from "./tickets-routes.js";

/**
 * The owner screens, under /app, for any active person on this Engine:
 *
 *   /app                       counts and links
 *   /app/reviews               curator changes waiting for your yes
 *   /app/reviews/:id           one change with its diff; approve or reject
 *   /app/flagged               items held by the steering screen; release or discard
 *   /app/knowledge...          the Knowledge screens (knowledge-routes.ts)
 *   /app/pages                 find one of your pages
 *   /app/pages/:id             one page (properties, text, links)
 *   /app/pages/:id/edit        its properties form and Markdown text
 *   /app/pages/:id/history     its versions
 *   /app/history/:id           one version, its diff to now; restore
 *   /app/sources...            your own source accounts and inclusion rules (sources-routes.ts)
 *   /app/duplicates...         possible duplicate pages; merge or keep apart (duplicates-routes.ts)
 *   /app/todo                  one list: tickets, changes to approve, held mail, look-alikes (todo-routes.ts)
 *   /app/tickets/:ref          one ticket; add a note, close it (administrators, tickets-routes.ts)
 *
 * Everything acts on the signed-in person's OWN rows; the database enforces
 * that (migration 0054). Approvals and releases exist only here: no MCP tool
 * reaches these functions.
 */

type Handler = (c: Context, me: Allowed, deps: ScreenDeps) => Promise<Response>;

function signedIn(deps: ScreenDeps, handler: Handler) {
  return async (c: Context) => {
    const me = await requirePerson(c, deps);
    if (!me.ok) return me.response;
    try {
      await recordChrome(c, me, deps);
      return await handler(c, me, deps);
    } catch (err) {
      return storeFailure(c, "app", err);
    }
  };
}

/** The menu's signed-in person and Knowledge tree for this request. Never fails a page. */
async function recordChrome(c: Context, me: Allowed, deps: ScreenDeps): Promise<void> {
  const base = { email: me.email, role: roleLabel(me.who), isAdmin: me.who?.["role"] === "administrator" };
  try {
    const [chosen, row] = await Promise.all([deps.store.templates(), deps.store.knowledgeTree(me.email)]);
    setChrome(c, { ...base, tree: buildTree(row, chosenDrawers(chosen)) });
  } catch {
    setChrome(c, base);
  }
}

const page = (c: Context, here: string, title: string, body: string, status: 200 | 400 | 409 = 200) =>
  sendPage(c, status, appLayout("app", here, title, body));

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

function idParam(c: Context): string | null {
  const id = c.req.param("id") ?? "";
  return UUID.test(id) ? id : null;
}

// ── home ────────────────────────────────────────────────────────────────────

const home: Handler = async (c, me) => {
  const who = me.who ?? {};
  const body = card(`<p>Signed in as ${esc(me.email)}.</p>
<ul>
<li><a href="/app/reviews">Waiting for your yes</a>: ${esc(who["pending_reviews"] ?? 0)}</li>
<li><a href="/app/flagged">Flagged items</a>: ${esc(who["flagged"] ?? 0)}</li>
<li><a href="/app/knowledge">Knowledge</a>: ${esc(who["pages"] ?? 0)} pages in drawers</li>
<li><a href="/app/duplicates">Possible duplicates</a>: pages that look like the same thing</li>
<li><a href="/app/sources">Sources</a>: your accounts and the rules that decide what is kept</li>
</ul>`);
  return page(c, "/app", "Your Engine", body);
};

// ── reviews ─────────────────────────────────────────────────────────────────

const reviews: Handler = async (c, me, deps) => {
  const all = c.req.query("status") === "all";
  const rows = await deps.store.reviews(me.email, all ? null : "pending");
  const items = rows
    .map(
      (r) =>
        `<li><a href="/app/reviews/${esc(r["id"])}">${esc(r["kind"] === "new_page" ? "New page" : "Change to")} ${esc(r["page_key"])}</a> from ${esc(r["item_title"] ?? "an item")} <span class="hint">${esc(when(r["created_at"]))}${all ? ` · ${esc(r["status"])}` : ""}</span><br><span class="hint">${esc(list(r["reasons"]).join("; "))}</span></li>`,
    )
    .join("");
  const body = card(
    rows.length === 0 ? "<p>Nothing is waiting for you.</p>" : `<ul>${items}</ul>`,
  ) + `<p class="hint">${all ? '<a href="/app/reviews">Show only waiting</a>' : '<a href="/app/reviews?status=all">Show decided ones too</a>'}</p>`;
  return page(c, "/app/reviews", "Waiting for your yes", body);
};

function fieldsTable(before: Row, after: Row): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  if (keys.length === 0) return "";
  const rows = keys
    .map((k) => `<tr><td>${esc(k)}</td><td>${esc(before[k] ?? "")}</td><td>${esc(after[k] ?? "")}</td></tr>`)
    .join("");
  return `<h2>Header fields</h2><table><thead><tr><th>Field</th><th>Now</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** What the page would look like after the change, and the diff to now. */
export function reviewDiff(review: Row): string {
  const proposal = object(review["proposal"]);
  if (review["kind"] === "new_page") {
    const p = object(proposal["page"]);
    return `<p>A new page <strong>${esc(p["title"])}</strong> in ${esc(p["drawer"])} (key ${esc(p["key"])}).</p>${fieldsTable({}, object(p["fields"]))}<h2>Text</h2>${diffHtml(lineDiff("", str(p["body"])))}`;
  }
  const current = review["page"] ? object(review["page"]) : null;
  if (!current) return "<p>The page this change was for is gone. Reject it.</p>";
  const update = object(proposal["update"]);
  const before = str(current["body"]);
  let after: string;
  try {
    after = applyPatches(before, (Array.isArray(update["patches"]) ? update["patches"] : []) as Patch[]);
  } catch {
    return `<p>This change no longer fits the page as it is now. Reject it; the curator will look again.</p>`;
  }
  const changed = review["base_hash"] && current["content_hash"] !== review["base_hash"]
    ? notice("ok", "The page has changed since this was proposed. The diff is against the page as it is now.")
    : "";
  const fieldsBefore = object(current["fields"]);
  const fieldsAfter = { ...fieldsBefore, ...object(update["fields"]) };
  return `${changed}<p>Page <a href="/app/pages/${esc(current["id"])}">${esc(current["title"])}</a>.</p>${fieldsTable(fieldsBefore, fieldsAfter)}<h2>Text</h2>${diffHtml(lineDiff(before, after))}`;
}

const reviewOne: Handler = async (c, me, deps) => {
  const id = idParam(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such change.");
  const review = await deps.store.review(me.email, id);
  if (!review) return sendMessage(c, "app", 404, "Not found", "There is no such change waiting for you.");
  const item = object(review["item"]);
  const csrf = deps.csrf.token(me.email, `review:${id}`);
  const decide = review["status"] === "pending"
    ? `<div class="card">${postForm(`/app/reviews/${id}/decide`, csrf, hidden("decision", "yes"), "Yes, make this change")}${postForm(`/app/reviews/${id}/decide`, csrf, hidden("decision", "no"), "No, drop it")}<p class="hint">A yes is carried out on the curator's next run.</p></div>`
    : card(`<p>Decided: ${esc(review["status"])}.</p>`);
  const body = card(`<p>From <strong>${esc(item["title"] ?? "an item")}</strong> (${esc(item["source"])}, ${esc(when(item["received_at"]))}).</p>
<p>Why it waits: ${esc(list(review["reasons"]).join("; ") || "a person's yes is needed")}.</p>
<p class="hint">Text from mail, meetings and files is quoted source data. Check it says what the source says.</p>`) +
    card(reviewDiff(review)) + decide;
  return page(c, "/app/reviews", "One change", body);
};

const decide: Handler = async (c, me, deps) => {
  const id = idParam(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such change.");
  const sent = await readForm(c, deps, "app", me.email, `review:${id}`);
  if (!sent.ok) return sent.response;
  const d = sent.form["decision"];
  if (d !== "yes" && d !== "no") return sendMessage(c, "app", 400, "Not accepted", "Choose yes or no.");
  const changed = await deps.store.decide(me.email, id, d === "yes");
  logger.info({ review: id, approve: d === "yes", changed }, "app: review decided");
  return changed
    ? sendMessage(c, "app", 200, d === "yes" ? "Approved" : "Dropped", d === "yes" ? "The curator makes this change on its next run." : "The change was dropped.")
    : sendMessage(c, "app", 409, "Already decided", "This change was already decided, or is not yours.");
};

// ── flagged items ───────────────────────────────────────────────────────────

const flagged: Handler = async (c, me, deps) => {
  const rows = await deps.store.flagged(me.email);
  const items = rows
    .map((r) => {
      const id = str(r["id"]);
      const csrf = deps.csrf.token(me.email, `flag:${id}`);
      return card(`<h2>${esc(r["title"] ?? "(no title)")}</h2>
<p class="hint">${esc(r["source"])} · ${esc(when(r["received_at"]))} · held because: ${esc(r["flag_reason"] ?? "flagged")}</p>
<pre>${esc(r["excerpt"])}</pre>
${postForm(`/app/flagged/${id}/release`, csrf, "", "Release it (still treated as data; every change it causes waits for your yes)")}
${postForm(`/app/flagged/${id}/discard`, csrf, "", "Discard it (no page is changed)")}`);
    })
    .join("");
  const intro = card("<p>These items looked like they were trying to give instructions, so the curator held them. Nothing in them was acted on.</p>");
  return page(c, "/app/flagged", "Flagged items", rows.length === 0 ? `${intro}${card("<p>Nothing is flagged.</p>")}` : `${intro}${items}`);
};

function flagAction(kind: "release" | "discard"): Handler {
  return async (c, me, deps) => {
    const id = idParam(c);
    if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such item.");
    const sent = await readForm(c, deps, "app", me.email, `flag:${id}`);
    if (!sent.ok) return sent.response;
    const done = kind === "release" ? await deps.store.release(me.email, id) : await deps.store.discard(me.email, id);
    logger.info({ item: id, action: kind, done }, "app: flagged item");
    return done
      ? sendMessage(c, "app", 200, kind === "release" ? "Released" : "Discarded", kind === "release" ? "The curator reads it on its next run; every change it proposes waits for your yes." : "The item was closed without changing any page.")
      : sendMessage(c, "app", 409, "Nothing changed", "This item was already handled, or is not yours.");
  };
}

// ── pages ───────────────────────────────────────────────────────────────────

const pages: Handler = async (c, me, deps) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const rows = await deps.store.pages(me.email, q || null);
  const items = rows
    .map((r) => `<li><a href="/app/pages/${esc(r["id"])}">${esc(r["title"])}</a> <span class="hint">${esc(r["drawer"])} · ${esc(r["key"])} · ${esc(when(r["updated_at"]))}</span></li>`)
    .join("");
  const search = `<form method="get" action="/app/pages"><label for="q">Find</label><input type="search" id="q" name="q" value="${esc(q)}" maxlength="100"><p><button type="submit">Find</button></p></form>`;
  return page(c, "/app/pages", "Your pages", card(search) + card(rows.length === 0 ? "<p>No pages.</p>" : `<ul>${items}</ul>`));
};

/** The stored page with the three edited fields replaced. */
export function editedPage(current: Row, form: Readonly<Record<string, string>>): Row | string {
  const title = (form["title"] ?? "").trim();
  const description = (form["description"] ?? "").trim();
  const body = (form["body"] ?? "").replace(/\r\n/g, "\n");
  if (title.length < 1 || title.length > 300) return "The title must be 1 to 300 characters.";
  if (description.length > 500) return "The description must be at most 500 characters.";
  if (body.length > MAX_BODY) return `The text must be at most ${MAX_BODY} characters.`;
  const keep = ["drawer", "key", "template", "aliases", "fields", "topics", "status", "tags", "related", "sources", "generated", "verified"];
  const base: Row = Object.fromEntries(keep.filter((k) => current[k] !== undefined && current[k] !== null).map((k) => [k, current[k]]));
  return { ...base, title, description: description || null, body };
}

const savePage: Handler = async (c, me, deps) => {
  const id = idParam(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such page.");
  const sent = await readForm(c, deps, "app", me.email, `page:${id}`);
  if (!sent.ok) return sent.response;
  const expected = sent.form["expected_hash"] ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) return sendMessage(c, "app", 400, "Not accepted", "Open the page again and redo the edit.");
  const current = await deps.store.page(me.email, id);
  if (!current) return sendMessage(c, "app", 404, "Not found", "You have no such page.");
  let next = editedPage(current, sent.form);
  if (typeof next === "string") return page(c, "/app/pages", "Not saved", notice("error", next), 400);
  if (sent.form["props"] === "1") {
    const { def } = await drawerFor(deps, str(current["drawer"]));
    const props = editedProperties(current, sent.form, def);
    if (typeof props === "string") {
      return page(c, "/app/pages", "Not saved", notice("error", props) + card(`<pre>${esc(next["body"])}</pre>`), 400);
    }
    // Fields the person changed are marked hand-set: the curator asks before overwriting them.
    const verified = markHandSet(Array.isArray(current["verified"]) ? current["verified"] : [], object(current["fields"]), object(props["fields"]), new Date().toISOString());
    next = { ...next, ...props, verified };
  }
  if (current["content_hash"] !== expected) {
    return page(c, "/app/pages", "Not saved", notice("error", "The page changed since you opened it. Open it again; your text is below so you can copy it.") + card(`<pre>${esc(next["body"])}</pre>`), 409);
  }
  const result = await deps.store.savePage(me.email, next, expected);
  logger.info({ page: id, changed: result.changed }, "app: page saved");
  const back = card(`<p><a href="/app/pages/${esc(id)}">Back to the page</a></p>`);
  return page(c, "/app/pages", result.changed ? "Saved" : "No change", notice("ok", result.changed ? "A new version was saved; its summary is queued again." : "Nothing was different, so nothing was written.") + back);
};

const history: Handler = async (c, me, deps) => {
  const id = idParam(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such page.");
  const rows = await deps.store.history(me.email, id);
  if (rows.length === 0) return sendMessage(c, "app", 404, "Not found", "You have no such page, or it has no history.");
  const items = rows
    .map((r, i) => `<li><a href="/app/history/${esc(r["id"])}">${esc(when(r["saved_at"]))}</a> ${esc(r["title"])} <span class="hint">by ${esc(r["saved_by"])}${i === 0 ? " · current" : ""}</span></li>`)
    .join("");
  return page(c, "/app/pages", "History", card(`<p><a href="/app/pages/${esc(id)}">Back to the page</a></p><ul>${items}</ul>`));
};

const version: Handler = async (c, me, deps) => {
  const id = idParam(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such version.");
  const v = await deps.store.version(me.email, id);
  if (!v) return sendMessage(c, "app", 404, "Not found", "You have no such version.");
  const snap = object(v["snapshot"]);
  const isCurrent = v["content_hash"] === v["current_hash"];
  const restore = isCurrent
    ? card("<p>This is the current version.</p>")
    : card(postForm(`/app/history/${id}/restore`, deps.csrf.token(me.email, `restore:${id}`), hidden("expected_hash", str(v["current_hash"])), "Restore this version") + '<p class="hint">Restoring saves this version again as the newest one. Nothing is deleted.</p>');
  const body = card(`<p>Saved ${esc(when(v["saved_at"]))}: <strong>${esc(snap["title"])}</strong>. <a href="/app/pages/${esc(v["page_id"])}/history">All versions</a></p>
<h2>From now to this version</h2>${diffHtml(lineDiff(str(v["current_body"]), str(snap["body"])))}`) + restore;
  return page(c, "/app/pages", "One version", body);
};

const restore: Handler = async (c, me, deps) => {
  const id = idParam(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such version.");
  const sent = await readForm(c, deps, "app", me.email, `restore:${id}`);
  if (!sent.ok) return sent.response;
  const expected = sent.form["expected_hash"] ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) return sendMessage(c, "app", 400, "Not accepted", "Open the version again.");
  const result = await deps.store.restore(me.email, id, expected);
  logger.info({ version: id, changed: result.changed }, "app: version restored");
  return sendMessage(c, "app", 200, "Restored", "That version is now the current one; the version it replaced is kept in the history.");
};

export function makeOwnerRoutes(use: () => ScreenDeps): Hono {
  const app = new Hono();
  const h = (handler: Handler) => (c: Context) => signedIn(use(), handler)(c);
  app.get("/", h(home));
  app.get("/reviews", h(reviews));
  app.get("/reviews/:id", h(reviewOne));
  app.post("/reviews/:id/decide", h(decide));
  app.get("/flagged", h(flagged));
  app.post("/flagged/:id/release", h(flagAction("release")));
  app.post("/flagged/:id/discard", h(flagAction("discard")));
  app.get("/knowledge", h(knowledgeHome));
  app.get("/knowledge/:drawer", h(knowledgeDrawer));
  app.get("/open", h(openByKey));
  app.get("/pages", h(pages));
  app.get("/pages/:id", h(pageAlone));
  app.get("/pages/:id/edit", h(pageEdit));
  app.post("/pages/:id/pin", h(pinPage));
  app.post("/pages/:id/reviewed", h(markReviewed));
  app.post("/pages/:id", h(savePage));
  app.get("/pages/:id/history", h(history));
  app.get("/history/:id", h(version));
  app.post("/history/:id/restore", h(restore));
  addSourceRoutes(app, h);
  addDuplicateRoutes(app, h);
  addTodoRoutes(app, h);
  addTicketRoutes(app, h);
  return app;
}
