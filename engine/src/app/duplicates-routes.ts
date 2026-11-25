import type { Context, Hono } from "hono";
import { mergeBodies } from "../entities/merge.js";
import { logger } from "../log/logger.js";
import { readForm, UUID, type Allowed, type ScreenDeps } from "./guard.js";
import { appLayout, card, esc, hidden, postForm, sendMessage, sendPage, when } from "./html.js";
import type { Row } from "./store.js";

/**
 * /app/duplicates: the signed-in person's "Possible duplicates" list, filled
 * by the curator's nightly look-alike check (same drawer, a shared email or
 * domain, the same name, or very similar summaries; migration 0067). For
 * each pair the person may merge (keep one page; the other's sections, links,
 * sources, names and addresses move into it, its key now leads to the kept
 * page, and both histories stay) or say they are different. Nothing is ever
 * merged without this click.
 */

type Handler = (c: Context, me: Allowed, deps: ScreenDeps) => Promise<Response>;

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

function side(p: Row): string {
  return `<a href="/app/pages/${esc(p["id"])}">${esc(p["title"])}</a> <code>${esc(p["key"])}</code>` +
    `${p["description"] ? `<br><span class="hint">${esc(p["description"])}</span>` : ""}` +
    `<br><span class="hint">updated ${esc(when(p["updated_at"]))}</span>`;
}

const list: Handler = async (c, me, deps) => {
  const rows = await deps.store.duplicates(me.email);
  const cards = rows.map((r) => {
    const id = str(r["id"]);
    const a = object(r["a"]);
    const b = object(r["b"]);
    const csrf = deps.csrf.token(me.email, `dup:${id}`);
    const score = Number(r["score"] ?? 0);
    return card(`<h2>${esc(r["drawer"])}: ${esc(r["reason"])}${score < 1 ? ` (${esc(score.toFixed(2))})` : ""}</h2>
<table><tbody><tr><th scope="row">A</th><td>${side(a)}</td></tr><tr><th scope="row">B</th><td>${side(b)}</td></tr></tbody></table>
${postForm(`/app/duplicates/${id}/merge`, csrf, hidden("keep", str(a["id"])), "Merge, keeping A")}
${postForm(`/app/duplicates/${id}/merge`, csrf, hidden("keep", str(b["id"])), "Merge, keeping B")}
${postForm(`/app/duplicates/${id}/dismiss`, csrf, "", "They are different")}`);
  });
  const intro = card("<p>Pages that look like the same thing, found each night. Merging keeps one page and folds the other into it (its sections, links, sources, names and addresses); the other page's key then leads to the kept one, and both histories are kept. Nothing is merged unless you choose it here.</p>");
  return sendPage(c, 200, appLayout("app", "/app/duplicates", "Possible duplicates",
    intro + (cards.length > 0 ? cards.join("") : card("<p>No possible duplicates.</p>"))));
};

function pairId(c: Context): string | null {
  const id = c.req.param("id") ?? "";
  return UUID.test(id) ? id : null;
}

const merge: Handler = async (c, me, deps) => {
  const id = pairId(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such pair.");
  const sent = await readForm(c, deps, "app", me.email, `dup:${id}`);
  if (!sent.ok) return sent.response;
  const keepId = sent.form["keep"] ?? "";
  const pair = await deps.store.duplicate(me.email, id);
  if (!pair) return sendMessage(c, "app", 409, "Nothing changed", "This pair was already handled, or is not yours.");
  const a = object(pair["a"]);
  const b = object(pair["b"]);
  const [keep, drop] = str(a["id"]) === keepId ? [a, b] : str(b["id"]) === keepId ? [b, a] : [null, null];
  if (!keep || !drop) return sendMessage(c, "app", 400, "Not accepted", "Choose one of the two pages to keep.");
  const body = mergeBodies(str(keep["body"]), str(drop["body"]), str(drop["title"]));
  await deps.store.mergePages(me.email, id, keepId, body, str(keep["content_hash"]), str(drop["content_hash"]));
  logger.info({ pair: id, kept: keepId }, "app: pages merged");
  return sendMessage(c, "app", 200, "Merged", `Kept ${str(keep["title"])}; ${str(drop["key"])} now leads to it.`);
};

const dismiss: Handler = async (c, me, deps) => {
  const id = pairId(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such pair.");
  const sent = await readForm(c, deps, "app", me.email, `dup:${id}`);
  if (!sent.ok) return sent.response;
  const done = await deps.store.dismissDuplicate(me.email, id);
  logger.info({ pair: id, done }, "app: duplicate dismissed");
  return done
    ? sendMessage(c, "app", 200, "Kept apart", "These two pages will not be proposed again.")
    : sendMessage(c, "app", 409, "Nothing changed", "This pair was already handled, or is not yours.");
};

export function addDuplicateRoutes(app: Hono, h: (handler: Handler) => (c: Context) => Promise<Response>): void {
  app.get("/duplicates", h(list));
  app.post("/duplicates/:id/merge", h(merge));
  app.post("/duplicates/:id/dismiss", h(dismiss));
}
