import type { Context } from "hono";
import type { DrawerDef } from "../entities/templates.js";
import { logger } from "../log/logger.js";
import { markHere } from "./chrome.js";
import { UUID, readForm, type Allowed, type ScreenDeps } from "./guard.js";
import { appLayout, esc, hidden, sendMessage, sendPage, when } from "./html.js";
import { drawerIcon, icon } from "./icons.js";
import { chosenDrawers, DRAWER_ID } from "./knowledge.js";
import { renderMarkdown } from "./markdown.js";
import { editFormHtml, lastChangeHtml, linksPanelHtml, pageViewHtml, propertiesHtml } from "./page-view.js";
import type { DrawerQuery, Row } from "./store.js";

/**
 * The Knowledge screens, built for thousands of pages:
 *
 *   /app/knowledge                     drawer folders with counts (no page rows)
 *   /app/knowledge/:drawer             two panes: the drawer's pages (paged,
 *                                      sorted, searched, filtered by topic) on
 *                                      the left, the open page on the right
 *       ?page=<id>                     open a page in the right pane
 *       &mode=edit                     edit it (properties form + Markdown)
 *       &list=closed / &view=closed    collapse a pane (no script)
 *   /app/open?key=...                  follow a [[link]] to your page on that key
 *   POST /app/pages/:id/pin            pin or unpin
 *   POST /app/pages/:id/reviewed       mark reviewed
 *
 * Not a wiki app on purpose: no page creation, no rich editor, no comments.
 * New knowledge comes in through Claude; these screens check and correct it.
 */

export type Handler = (c: Context, me: Allowed, deps: ScreenDeps) => Promise<Response>;

const PAGE_SIZES = [25, 50, 100] as const;
const SORTS = ["updated", "title", "key"] as const;
const ASK_CLAUDE = "Ask your Claude to add or change knowledge; use this to check and correct it.";

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

const show = (c: Context, here: string, title: string, body: string, status: 200 | 400 | 404 = 200) => {
  markHere(c, here);
  return sendPage(c, status, appLayout("app", here.split("?")[0] ?? here, title, body));
};

export async function drawerFor(deps: ScreenDeps, id: string): Promise<{ all: readonly DrawerDef[]; def: DrawerDef | undefined }> {
  const all = chosenDrawers(await deps.store.templates());
  return { all, def: all.find((d) => d.id === id) };
}

// ── the folders ─────────────────────────────────────────────────────────────

export const knowledgeHome: Handler = async (c, me, deps) => {
  const [chosen, tree] = await Promise.all([deps.store.templates(), deps.store.knowledgeTree(me.email)]);
  const counts = object(tree["counts"]);
  const drawers = chosenDrawers(chosen);
  const list = [
    ...drawers.map((d) => ({ id: d.id, label: d.label, count: Number(counts[d.id] ?? 0) })),
    ...Object.keys(counts).filter((k) => DRAWER_ID.test(k) && !drawers.some((d) => d.id === k)).map((k) => ({ id: k, label: k, count: Number(counts[k]) })),
  ];
  const total = list.reduce((n, f) => n + f.count, 0);
  const tiles = list
    .map((f) => `<li><a class="folder" href="/app/knowledge/${esc(f.id)}"><span class="folder-icon">${icon(drawerIcon(f.id), 24)}</span><span class="folder-name">${esc(f.label)}</span><span class="count">${esc(f.count)} ${f.count === 1 ? "page" : "pages"}</span></a></li>`)
    .join("");
  const body = `<div class="card callout"><p>${icon("bulb", 18)} ${esc(ASK_CLAUDE)}</p></div><p class="hint">${esc(total)} ${total === 1 ? "page" : "pages"} in ${esc(list.length)} drawers.</p><ul class="folders">${tiles}</ul>`;
  return show(c, "/app/knowledge", "Knowledge", body);
};

// ── one drawer: list pane + viewer pane ─────────────────────────────────────

export function parseQuery(c: Context, drawer: string): DrawerQuery & { pageNo: number } {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const topic = (c.req.query("topic") ?? "").trim();
  const sortRaw = c.req.query("sort") ?? "updated";
  const sort = (SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as DrawerQuery["sort"]) : "updated";
  const dir = c.req.query("dir");
  const desc = dir === undefined ? sort === "updated" : dir !== "asc";
  const sizeRaw = Number(c.req.query("size") ?? 50);
  const limit = (PAGE_SIZES as readonly number[]).includes(sizeRaw) ? sizeRaw : 50;
  const pageNo = Math.max(1, Math.min(10_000, Math.floor(Number(c.req.query("p") ?? 1)) || 1));
  return {
    drawer, query: q || null, topic: /^[a-z0-9][a-z0-9_-]{0,62}$/.test(topic) ? topic : null,
    sort, desc, limit, offset: (pageNo - 1) * limit, pageNo,
  };
}

type View = DrawerQuery & { pageNo: number; open: string | null; edit: boolean; listOpen: boolean; viewOpen: boolean };

/** The drawer address with some parameters changed (null removes one). */
export function drawerHref(v: View, change: Readonly<Record<string, string | number | null>> = {}): string {
  const base: Record<string, string | number | null> = {
    q: v.query, topic: v.topic, sort: v.sort === "updated" ? null : v.sort,
    dir: v.desc === (v.sort === "updated") ? null : v.desc ? "desc" : "asc",
    size: v.limit === 50 ? null : v.limit, p: v.pageNo === 1 ? null : v.pageNo,
    page: v.open, mode: v.edit ? "edit" : null,
    list: v.listOpen ? null : "closed", view: v.viewOpen ? null : "closed",
  };
  const merged = { ...base, ...change };
  const qs = Object.entries(merged)
    .filter(([, val]) => val !== null && val !== "")
    .map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(val))}`)
    .join("&");
  return `/app/knowledge/${v.drawer}${qs ? `?${qs}` : ""}`;
}

/** The few columns a drawer shows besides title: its list views' fields. */
export function listColumns(def: DrawerDef | undefined): string[] {
  if (!def) return [];
  const names = def.list_views.flatMap((lv) => [lv.filter, lv.sort].filter((x): x is string => typeof x === "string"));
  return [...new Set(names)].filter((n) => def.fields.some((f) => f.name === n)).slice(0, 3);
}

function pager(v: View, total: number): string {
  const pages = Math.max(1, Math.ceil(total / v.limit));
  const at = Math.min(v.pageNo, pages);
  const nums = [...new Set([1, at - 2, at - 1, at, at + 1, at + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const links: string[] = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) links.push('<span class="gap">…</span>');
    links.push(n === at ? `<strong aria-current="page">${n}</strong>` : `<a href="${esc(drawerHref(v, { p: n === 1 ? null : n }))}">${n}</a>`);
    prev = n;
  }
  const prevLink = at > 1 ? `<a href="${esc(drawerHref(v, { p: at - 1 === 1 ? null : at - 1 }))}" rel="prev">Previous</a>` : '<span class="disabled">Previous</span>';
  const nextLink = at < pages ? `<a href="${esc(drawerHref(v, { p: at + 1 }))}" rel="next">Next</a>` : '<span class="disabled">Next</span>';
  const sizes = PAGE_SIZES.map((s) => (s === v.limit ? `<strong>${s}</strong>` : `<a href="${esc(drawerHref(v, { size: s === 50 ? null : s, p: null }))}">${s}</a>`)).join(" ");
  return `<nav class="pager" aria-label="Pages">${prevLink} ${links.join(" ")} ${nextLink}<span class="sizes">Per page: ${sizes}</span></nav>`;
}

function sortLink(v: View, col: DrawerQuery["sort"], label: string): string {
  const active = v.sort === col;
  const nextDesc = active ? !v.desc : col === "updated";
  const arrow = active ? (v.desc ? " ↓" : " ↑") : "";
  return `<a href="${esc(drawerHref(v, { sort: col === "updated" ? null : col, dir: nextDesc === (col === "updated") ? null : nextDesc ? "desc" : "asc", p: null }))}">${esc(label)}${arrow}</a>`;
}

function listPane(v: View, def: DrawerDef | undefined, result: Row): string {
  const rows = Array.isArray(result["rows"]) ? (result["rows"] as Row[]) : [];
  const total = Number(result["total"] ?? 0);
  const cols = listColumns(def);
  const topics = strs(result["topics"]);
  const chipsHtml = topics.length === 0 ? "" : `<p class="chips">${[`<a class="chip link${v.topic === null ? " on" : ""}" href="${esc(drawerHref(v, { topic: null, p: null }))}">All topics</a>`, ...topics.map((t) => `<a class="chip link${v.topic === t ? " on" : ""}" href="${esc(drawerHref(v, { topic: t, p: null }))}">${esc(t)}</a>`)].join(" ")}</p>`;
  const keep = (["sort", "dir", "size", "topic"] as const)
    .map((k) => {
      const val = new URL(`http://x${drawerHref(v)}`).searchParams.get(k);
      return val ? hidden(k, val) : "";
    })
    .join("");
  const search = `<form method="get" action="/app/knowledge/${esc(v.drawer)}" class="search-row">${keep}<label class="sr-only" for="q">Search this drawer</label><input type="search" id="q" name="q" value="${esc(v.query ?? "")}" maxlength="100" placeholder="Search ${esc(def?.label ?? v.drawer)}"><button type="submit">${icon("search", 16)}<span class="sr-only">Search</span></button></form>`;
  const head = `<tr><th>${sortLink(v, "title", "Title")}</th><th>${sortLink(v, "key", "Key")}</th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}<th>${sortLink(v, "updated", "Updated")}</th></tr>`;
  const body = rows
    .map((r) => {
      const id = str(r["id"]);
      const fields = object(r["fields"]);
      const cur = v.open === id;
      const flags = `${r["stale"] === true ? ' <span class="badge warn" title="Not updated in 90 days">stale</span>' : ""}${r["summary_pending"] === true ? ' <span class="badge">summary pending</span>' : ""}`;
      return `<tr${cur ? ' class="current"' : ""}><td><a href="${esc(drawerHref(v, { page: id, mode: null }))}"${cur ? ' aria-current="page"' : ""}>${esc(r["title"])}</a>${flags}</td><td class="mono">${esc(r["key"])}</td>${cols.map((c) => `<td>${esc(fields[c] ?? "")}</td>`).join("")}<td class="nowrap">${esc(when(r["updated_at"]).slice(0, 10))}</td></tr>`;
    })
    .join("");
  const table = rows.length === 0
    ? `<p class="empty">${v.query || v.topic ? "Nothing matches." : `No pages in ${esc(def?.label ?? v.drawer)} yet.`}</p>`
    : `<div class="table-wrap"><table class="page-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  return `${search}${chipsHtml}<p class="hint">${esc(total)} ${total === 1 ? "page" : "pages"}</p>${table}${pager(v, total)}`;
}

function pane(cls: string, title: string, open: boolean, toggleHref: string, inner: string): string {
  return `<section class="pane ${cls}${open ? "" : " closed"}"><header class="pane-head"><h2>${esc(title)}</h2><a class="pane-toggle" href="${esc(toggleHref)}">${open ? "Collapse" : "Expand"}</a></header>${open ? `<div class="pane-body">${inner}</div>` : ""}</section>`;
}

export function pageActions(me: Allowed, deps: ScreenDeps, p: Row, back: string): { pinForm: string; reviewForm: string; reindexForm: string } {
  const id = str(p["id"]);
  const csrf = deps.csrf.token(me.email, `page:${id}`);
  const form = (action: string, inner: string, label: string, cls = "secondary") =>
    `<form method="post" action="${esc(action)}" class="inline">${hidden("csrf", csrf)}${hidden("back", back)}${inner}<button type="submit" class="${cls}">${label}</button></form>`;
  const pinned = p["pinned"] === true;
  const isAdmin = me.who?.["role"] === "administrator";
  const adminCsrf = deps.csrf.token(me.email, "indexing");
  return {
    pinForm: form(`/app/pages/${id}/pin`, hidden("pin", pinned ? "no" : "yes"), pinned ? "Unpin" : "Pin"),
    reviewForm: p["status"] === "current" && p["reviewed"] ? "" : form(`/app/pages/${id}/reviewed`, "", "Mark reviewed"),
    reindexForm: isAdmin
      ? `<form method="post" action="/setup/indexing/reindex" class="inline">${hidden("csrf", adminCsrf)}${hidden("page", id)}<button type="submit" class="secondary">Re-index</button></form>`
      : "",
  };
}

export const knowledgeDrawer: Handler = async (c, me, deps) => {
  const id = c.req.param("drawer") ?? "";
  if (!DRAWER_ID.test(id)) return sendMessage(c, "app", 404, "Not found", "There is no such drawer.");
  const { def } = await drawerFor(deps, id);
  const parsed = parseQuery(c, id);
  const openRaw = c.req.query("page") ?? "";
  const v: View = {
    ...parsed,
    open: UUID.test(openRaw) ? openRaw : null,
    edit: c.req.query("mode") === "edit",
    listOpen: c.req.query("list") !== "closed",
    viewOpen: c.req.query("view") !== "closed",
  };
  const [result, page, links, history] = await Promise.all([
    deps.store.drawerPages(me.email, parsed),
    v.open ? deps.store.pageView(me.email, v.open) : Promise.resolve(null),
    v.open ? deps.store.pageLinks(me.email, v.open) : Promise.resolve(null),
    v.open ? deps.store.history(me.email, v.open).catch(() => []) : Promise.resolve([]),
  ]);
  if (!def && Number(result["total"] ?? 0) === 0) return sendMessage(c, "app", 404, "Not found", "There is no such drawer.");
  const label = def?.label ?? id;

  let viewer = '<p class="empty">Pick a page on the left to see it here.</p>';
  let viewTitle = "Page";
  if (v.open && !page) viewer = '<p class="empty">You have no such page.</p>';
  if (page) {
    viewTitle = str(page["title"]);
    const tabs = `<nav class="tabs"><a href="${esc(drawerHref(v, { mode: null }))}"${v.edit ? "" : ' aria-current="page"'}>Preview</a><a href="${esc(drawerHref(v, { mode: "edit" }))}"${v.edit ? ' aria-current="page"' : ""}>Edit</a><a href="/app/pages/${esc(page["id"])}">Open alone</a></nav>`;
    viewer = v.edit
      ? tabs + editFormHtml(page, def, deps.csrf.token(me.email, `page:${str(page["id"])}`))
      : `${tabs}${lastChangeHtml(page, history)}${propertiesHtml(page, def)}<article class="markdown">${renderMarkdown(str(page["body"]))}</article>${linksPanelHtml(links)}`;
  }
  const back = drawerHref(v);
  const actions = page ? pageActions(me, deps, page, back) : null;
  const actionBar = actions ? `<div class="page-actions">${actions.pinForm}${actions.reviewForm}${actions.reindexForm}</div>` : "";
  const body = `<p class="hint crumbs"><a href="/app/knowledge">Knowledge</a> / ${esc(label)} · ${esc(ASK_CLAUDE)}</p>
<div class="panes${v.listOpen ? "" : " list-closed"}${v.viewOpen ? "" : " view-closed"}">
${pane("list-pane", label, v.listOpen, drawerHref(v, { list: v.listOpen ? "closed" : null }), listPane(v, def, result))}
${pane("view-pane", viewTitle, v.viewOpen, drawerHref(v, { view: v.viewOpen ? "closed" : null }), actionBar + viewer)}
</div>`;
  return show(c, `/app/knowledge/${id}`, label, body);
};

// ── one page alone, and following a [[link]] ────────────────────────────────

export const pageAlone: Handler = async (c, me, deps) => {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) return sendMessage(c, "app", 404, "Not found", "There is no such page.");
  const [p, links, history] = await Promise.all([
    deps.store.pageView(me.email, id),
    deps.store.pageLinks(me.email, id),
    deps.store.history(me.email, id).catch(() => []),
  ]);
  if (!p) return sendMessage(c, "app", 404, "Not found", "You have no such page.");
  const { def } = await drawerFor(deps, str(p["drawer"]));
  return show(c, `/app/pages/${id}`, str(p["title"]), pageViewHtml(p, def, links, pageActions(me, deps, p, `/app/pages/${id}`), history));
};

export const pageEdit: Handler = async (c, me, deps) => {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) return sendMessage(c, "app", 404, "Not found", "There is no such page.");
  const p = await deps.store.pageView(me.email, id);
  if (!p) return sendMessage(c, "app", 404, "Not found", "You have no such page.");
  const { def } = await drawerFor(deps, str(p["drawer"]));
  const crumb = `<p class="hint crumbs"><a href="/app/pages/${esc(id)}">Back to the page</a></p>`;
  return show(c, `/app/pages/${id}`, `Edit: ${str(p["title"])}`, crumb + editFormHtml(p, def, deps.csrf.token(me.email, `page:${id}`)));
};

export const openByKey: Handler = async (c, me, deps) => {
  const key = (c.req.query("key") ?? "").trim().toLowerCase().slice(0, 200);
  if (!key) return sendMessage(c, "app", 404, "Not found", "No page key was given.");
  const hit = (await deps.store.pages(me.email, key)).find((r) => r["key"] === key);
  if (!hit) return sendMessage(c, "app", 404, "No page yet", `You have no page with the key ${key}. Ask your Claude to add it if it should exist.`);
  return c.redirect(`/app/pages/${str(hit["id"])}`, 302);
};

/** Only a same-site path back into the app. */
function safeBack(raw: string | undefined, fallback: string): string {
  return raw && /^\/app\/[A-Za-z0-9/_?=&%.:@-]*$/.test(raw) && !raw.startsWith("//") ? raw : fallback;
}

export const pinPage: Handler = async (c, me, deps) => {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) return sendMessage(c, "app", 404, "Not found", "There is no such page.");
  const sent = await readForm(c, deps, "app", me.email, `page:${id}`);
  if (!sent.ok) return sent.response;
  const ok = await deps.store.pin(me.email, id, sent.form["pin"] === "yes");
  if (!ok) return sendMessage(c, "app", 404, "Not found", "You have no such page.");
  return c.redirect(safeBack(sent.form["back"], `/app/pages/${id}`), 303);
};

export const markReviewed: Handler = async (c, me, deps) => {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) return sendMessage(c, "app", 404, "Not found", "There is no such page.");
  const sent = await readForm(c, deps, "app", me.email, `page:${id}`);
  if (!sent.ok) return sent.response;
  const ok = await deps.store.markReviewed(me.email, id);
  logger.info({ page: id, ok }, "app: page marked reviewed");
  if (!ok) return sendMessage(c, "app", 404, "Not found", "You have no such page.");
  return c.redirect(safeBack(sent.form["back"], `/app/pages/${id}`), 303);
};
