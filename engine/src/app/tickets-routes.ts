import type { Context, Hono } from "hono";
import { logger } from "../log/logger.js";
import { readForm, type Allowed, type ScreenDeps } from "./guard.js";
import { appLayout, card, esc, postForm, sendMessage, sendPage, when } from "./html.js";
import { icon } from "./icons.js";
import type { Row } from "./store.js";

/**
 * Tickets (migration 0072), for administrators:
 *
 *   /app/tickets/:ref          one ticket: what happened, what to do, notes
 *   POST /app/tickets/:ref/note   add a note
 *   POST /app/tickets/:ref/close  a person closes it (never automatic)
 *
 * The database opens tickets from the alert sources and refuses anyone who
 * is not an administrator. The To do list and the Pipeline cards link here.
 */

type Handler = (c: Context, me: Allowed, deps: ScreenDeps) => Promise<Response>;

/** QB-0012: letters, a dash, digits. */
export const TICKET_REF = /^[A-Za-z]{2}-[0-9]{1,9}$/;
const MAX_NOTE = 2000;

/** The Pipeline card each ticket step belongs to. */
export const STEP_LABEL: Readonly<Record<string, string>> = {
  subscriptions: "Subscriptions", mailroom: "Mailroom", new_mail_alert: "New mail alert",
  desk_editor: "Desk editor", archivist: "Archivist", author: "Author", fact_checker: "Fact-checker",
  publisher: "Publisher", cataloguer: "Cataloguer", index_clerk: "Index clerk",
  librarian: "Librarian", reading_room: "Reading room",
};

/** To-do tickets that close by themselves when their queue empties (0073). */
export const WORK_ITEM_KINDS: ReadonlySet<string> = new Set(["reviews_waiting", "held_mail"]);

export const ticketHref = (ref: unknown): string => `/app/tickets/${encodeURIComponent(String(ref ?? ""))}`;

/** "looks fixed since ..." for an open ticket whose cause went away, or "". */
export function looksFixed(t: Row): string {
  return t["status"] === "open" && t["cleared_at"] ? `<span class="fixed">looks fixed since ${esc(when(t["cleared_at"]))}</span>` : "";
}

/** One line in a list of tickets. */
export function ticketLine(t: Row): string {
  const step = STEP_LABEL[String(t["step"] ?? "")] ?? String(t["step"] ?? "");
  return `${icon("flag", 16)} <a href="${esc(ticketHref(t["ref"]))}"><span class="ticket-ref">${esc(t["ref"])}</span> ${esc(t["title"])}</a> <span class="hint">${esc(step)} · opened ${esc(when(t["opened_at"]))}</span> ${looksFixed(t)}`;
}

const refParam = (c: Context): string | null => {
  const ref = c.req.param("ref") ?? "";
  return TICKET_REF.test(ref) ? ref.toUpperCase() : null;
};

const notesHtml = (notes: unknown): string => {
  const list = Array.isArray(notes) ? (notes as Row[]) : [];
  if (!list.length) return "<p class=\"hint\">No notes yet.</p>";
  return `<ul class="todo">${list.map((n) => `<li><span><strong>${esc(n["by"])}</strong> <span class="hint">${esc(when(n["at"]))}</span><br>${esc(n["body"])}</span></li>`).join("")}</ul>`;
};

const show: Handler = async (c, me, deps) => {
  const ref = refParam(c);
  if (!ref || !deps.store.ticket) return sendMessage(c, "app", 404, "Not found", "There is no such ticket.");
  const t = await deps.store.ticket(me.email, ref);
  if (!t) return sendMessage(c, "app", 404, "Not found", "There is no such ticket.");
  const csrf = deps.csrf.token(me.email, `ticket:${ref}`);
  const open = t["status"] === "open";
  const step = STEP_LABEL[String(t["step"] ?? "")] ?? String(t["step"] ?? "");
  const emptied = WORK_ITEM_KINDS.has(String(t["kind"] ?? "")) && (!open || Boolean(t["cleared_at"]));
  const link = emptied
    ? " <strong>Nothing is waiting now.</strong>"
    : typeof t["link"] === "string" && t["link"].startsWith("/") ? ` <a href="${esc(t["link"])}">Go there</a>.` : "";
  const state = open
    ? `<p><span class="badge-needs">Open</span> ${looksFixed(t)}</p>`
    : `<p><strong>Closed</strong> ${esc(when(t["closed_at"]))} by ${esc(t["closed_by"])}.</p>`;
  const about = card(`${state}<table class="stats"><tbody>
<tr><th scope="row">Step</th><td>${esc(step)}</td></tr>
<tr><th scope="row">Opened</th><td>${esc(when(t["opened_at"]))}</td></tr>
<tr><th scope="row">Last seen</th><td>${esc(when(t["last_seen_at"]))}</td></tr>
</tbody></table>
<h2>What happened</h2><p>${esc(t["what_happened"])}</p>
<h2>What to do</h2><p>${esc(t["what_to_do"])}${link}</p>`);
  const noteForm = postForm(`${ticketHref(ref)}/note`, csrf,
    `<label for="body">Add a note</label><textarea id="body" name="body" rows="3" maxlength="${MAX_NOTE}" required></textarea>`, "Add note");
  const closeForm = open
    ? postForm(`${ticketHref(ref)}/close`, csrf,
      `<label for="note">Closing note (optional)</label><input id="note" name="note" maxlength="${MAX_NOTE}">`, "Close this ticket") +
      "<p class=\"hint\">Close it once you have checked the problem is gone. Tickets never close by themselves.</p>"
    : "";
  const body = about + card(`<h2>Notes</h2>${notesHtml(t["notes"])}${noteForm}`) + (closeForm ? card(closeForm) : "");
  return sendPage(c, 200, appLayout("app", "/app/todo", `Ticket ${String(t["ref"])}: ${String(t["title"] ?? "")}`, body));
};

const note: Handler = async (c, me, deps) => {
  const ref = refParam(c);
  if (!ref || !deps.store.ticketNote) return sendMessage(c, "app", 404, "Not found", "There is no such ticket.");
  const sent = await readForm(c, deps, "app", me.email, `ticket:${ref}`);
  if (!sent.ok) return sent.response;
  const text = (sent.form["body"] ?? "").trim();
  if (!text || text.length > MAX_NOTE) return sendMessage(c, "app", 400, "Not saved", `A note is 1 to ${MAX_NOTE} characters.`);
  const ok = await deps.store.ticketNote(me.email, ref, text);
  if (!ok) return sendMessage(c, "app", 404, "Not found", "There is no such ticket.");
  logger.info({ ticket: ref }, "app: ticket note");
  return c.redirect(ticketHref(ref), 303);
};

const close: Handler = async (c, me, deps) => {
  const ref = refParam(c);
  if (!ref || !deps.store.closeTicket) return sendMessage(c, "app", 404, "Not found", "There is no such ticket.");
  const sent = await readForm(c, deps, "app", me.email, `ticket:${ref}`);
  if (!sent.ok) return sent.response;
  const text = (sent.form["note"] ?? "").trim();
  if (text.length > MAX_NOTE) return sendMessage(c, "app", 400, "Not saved", `A note is at most ${MAX_NOTE} characters.`);
  const ok = await deps.store.closeTicket(me.email, ref, text || null);
  logger.info({ ticket: ref, closed: ok }, "app: ticket close");
  return ok ? c.redirect(ticketHref(ref), 303) : sendMessage(c, "app", 409, "Already closed", "This ticket is already closed.");
};

export function addTicketRoutes(app: Hono, h: (handler: Handler) => (c: Context) => Promise<Response>): void {
  app.get("/tickets/:ref", h(show));
  app.post("/tickets/:ref/note", h(note));
  app.post("/tickets/:ref/close", h(close));
}
