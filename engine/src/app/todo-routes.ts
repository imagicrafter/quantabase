import type { Context, Hono } from "hono";
import type { Allowed, ScreenDeps } from "./guard.js";
import { appLayout, card, esc, sendPage, when } from "./html.js";
import { icon } from "./icons.js";
import type { Row } from "./store.js";
import { ticketLine } from "./tickets-routes.js";

/**
 * /app/todo: one list of everything waiting for the signed-in person, from
 * the places that keep their own screens (and addresses):
 *
 *   tickets              /app/tickets/:ref (administrators; 0072)
 *   changes to approve   /app/reviews     (curator_reviews, pending)
 *   held mail            /app/flagged     (looked like it gave orders)
 *   look-alike pages     /app/duplicates  (the Librarian's nightly check)
 *
 * Read only: each row links to the screen where it is decided. A list that
 * cannot be read is shown as such; it never fails the page.
 */

type Handler = (c: Context, me: Allowed, deps: ScreenDeps) => Promise<Response>;

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
/** Rows shown per kind; the full list is one click away. */
export const TODO_LIMIT = 20;

type Kind = {
  readonly title: string;
  readonly what: string;
  readonly href: string;
  readonly rows: Row[] | null;
  readonly line: (r: Row) => string;
};

function section(k: Kind): string {
  if (k.rows === null) return card(`<h2>${esc(k.title)}</h2><p class="hint">This list could not be read just now. <a href="${esc(k.href)}">Open it</a>.</p>`);
  const items = k.rows.slice(0, TODO_LIMIT).map((r) => `<li>${k.line(r)}</li>`).join("");
  const more = k.rows.length > TODO_LIMIT ? `<p><a href="${esc(k.href)}">See all ${esc(k.rows.length)}</a></p>` : "";
  return card(`<h2>${esc(k.title)} <span class="count">${esc(k.rows.length)}</span></h2><p class="hint">${esc(k.what)}</p>${
    k.rows.length ? `<ul class="todo">${items}</ul>${more}` : "<p>Nothing here.</p>"}`);
}

const safe = (p: Promise<Row[]>): Promise<Row[] | null> => p.catch(() => null);

const todo: Handler = async (c, me, deps) => {
  const admin = me.who?.["role"] === "administrator" && deps.store.tickets !== undefined;
  const [tickets, reviews, flagged, dups] = await Promise.all([
    admin && deps.store.tickets ? safe(deps.store.tickets(me.email, "open")) : Promise.resolve(null),
    safe(deps.store.reviews(me.email, "pending")),
    safe(deps.store.flagged(me.email)),
    safe(deps.store.duplicates(me.email)),
  ]);
  const total = [tickets, reviews, flagged, dups].reduce((n, l) => n + (l?.length ?? 0), 0);
  const ticketKind: Kind[] = admin
    ? [{
        title: "Tickets", what: "Problems on the Pipeline, and steps that need a person. Each stays open until someone closes it.",
        href: "/setup/pipeline", rows: tickets, line: ticketLine,
      }]
    : [];
  const kinds: Kind[] = [
    ...ticketKind,
    {
      title: "Changes to approve", what: "The curator will not make these without your yes.", href: "/app/reviews", rows: reviews,
      line: (r) => `${icon("check", 16)} <a href="/app/reviews/${esc(r["id"])}">${esc(r["kind"] === "new_page" ? "New page" : "Change to")} ${esc(r["page_key"])}</a> <span class="hint">${esc(when(r["created_at"]))}</span>`,
    },
    {
      title: "Held mail", what: "These looked like they were giving orders, so nothing in them was acted on.", href: "/app/flagged", rows: flagged,
      line: (r) => `${icon("flag", 16)} <a href="/app/flagged">${esc(r["title"] ?? "(no title)")}</a> <span class="hint">${esc(r["source"])} · ${esc(when(r["received_at"]))}</span>`,
    },
    {
      title: "Look-alike pages", what: "Two pages that may be the same thing. Merge them or keep them apart.", href: "/app/duplicates", rows: dups,
      line: (r) => `${icon("collection", 16)} <a href="/app/duplicates">${esc(object(r["a"])["title"])} and ${esc(object(r["b"])["title"])}</a> <span class="hint">${esc(r["reason"])}</span>`,
    },
  ];
  const head = card(`<p><strong>${esc(total)}</strong> ${total === 1 ? "thing is" : "things are"} waiting for you.</p>`);
  return sendPage(c, 200, appLayout("app", "/app/todo", "To do", head + kinds.map(section).join("")));
};

export function addTodoRoutes(app: Hono, h: (handler: Handler) => (c: Context) => Promise<Response>): void {
  app.get("/todo", h(todo));
}
