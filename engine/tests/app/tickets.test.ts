import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { AppDeniedError, type Row } from "../../src/app/store.js";
import { ASSERT, OWNER, client, createScreens, csrfIn } from "./fakes.js";

// Synthetic data only.
const OPEN: Row = {
  ref: "QB-0012", step: "author", kind: "curator_failed", title: "The curator's last run failed",
  what_happened: "The run stopped with an error: writer timed out.", what_to_do: "Open Engine > Pipeline.",
  link: "/setup/pipeline", status: "open", opened_at: "2026-11-22T10:00:00Z", last_seen_at: "2026-11-22T10:30:00Z",
  cleared_at: "2026-11-22T11:00:00Z", closed_at: null, closed_by: null,
  notes: [{ at: "2026-11-22T10:40:00Z", by: "owner@example.com", body: "Looking." }],
};

function world(over: { ticket?: Row | null; close?: boolean } = {}) {
  const screens = createScreens();
  const deps = screens.deps as { store: typeof screens.fake.store };
  const note = vi.fn(async () => true);
  const close = vi.fn(async () => over.close ?? true);
  const tickets = vi.fn(async (email: string) => {
    if (email !== OWNER) throw new AppDeniedError("not allowed");
    return [OPEN];
  });
  deps.store = {
    ...screens.fake.store,
    tickets,
    ticket: async (email: string) => {
      if (email !== OWNER) throw new AppDeniedError("not allowed");
      return over.ticket === undefined ? OPEN : over.ticket;
    },
    ticketNote: note,
    closeTicket: close,
  };
  const app = new Hono();
  app.route("/app", makeOwnerRoutes(() => screens.deps));
  return { note, close, tickets, http: client(app) };
}

describe("Tickets", () => {
  it("To do lists open tickets first for an administrator, with 'looks fixed since'", async () => {
    const html = await (await world().http.get("/app/todo", ASSERT.owner)).text();
    expect(html).toContain("<h2>Tickets <span class=\"count\">1</span></h2>");
    expect(html).toContain('<a href="/app/tickets/QB-0012"><span class="ticket-ref">QB-0012</span>');
    expect(html).toContain("looks fixed since 2026-11-22 11:00 UTC");
    expect(html.indexOf("Tickets")).toBeLessThan(html.indexOf("Changes to approve"));
  });

  it("To do has no Tickets section for someone who is not an administrator", async () => {
    const w = world();
    const html = await (await w.http.get("/app/todo", ASSERT.reader)).text();
    expect(html).not.toContain("<h2>Tickets");
    expect(w.tickets).not.toHaveBeenCalled();
  });

  it("one ticket shows what happened, what to do, its notes, and a Close button", async () => {
    const html = await (await world().http.get("/app/tickets/qb-0012", ASSERT.owner)).text();
    expect(html).toContain("Ticket QB-0012");
    expect(html).toContain("writer timed out");
    expect(html).toContain('<a href="/setup/pipeline">Go there</a>');
    expect(html).toContain("Looking.");
    expect(html).toContain("Close this ticket");
    expect(html).toContain("Tickets never close by themselves");
  });

  it("a closed ticket shows who closed it and when, and no Close button", async () => {
    const closed = { ...OPEN, status: "closed", closed_at: "2026-11-22T12:00:00Z", closed_by: "owner@example.com" };
    const html = await (await world({ ticket: closed }).http.get("/app/tickets/QB-0012", ASSERT.owner)).text();
    expect(html).toContain("Closed</strong> 2026-11-22 12:00 UTC by owner");
    expect(html).not.toContain("Close this ticket");
    expect(html).not.toContain("looks fixed");
  });

  it("a to-do ticket whose queue is empty says Nothing is waiting now instead of linking to an empty list", async () => {
    const done = { ...OPEN, kind: "reviews_waiting", link: "/app/reviews", status: "closed", closed_at: "2026-11-22T12:00:00Z", closed_by: "the Engine",
      notes: [{ at: "2026-11-22T12:00:00Z", by: "the Engine", body: "Closed by itself: nothing left waiting." }] };
    const html = await (await world({ ticket: done }).http.get("/app/tickets/QB-0001", ASSERT.owner)).text();
    expect(html).toContain("Nothing is waiting now.");
    expect(html).not.toContain('href="/app/reviews">Go there');
    expect(html).toContain("Closed by itself: nothing left waiting.");
    // A fault that looks fixed still links to where to check.
    const fault = await (await world().http.get("/app/tickets/QB-0012", ASSERT.owner)).text();
    expect(fault).toContain('<a href="/setup/pipeline">Go there</a>');
  });

  it("a bad or unknown id is not found; a reader is refused", async () => {
    const w = world({ ticket: null });
    expect((await w.http.get("/app/tickets/QB-0099", ASSERT.owner)).status).toBe(404);
    expect((await w.http.get("/app/tickets/..%2Fx", ASSERT.owner)).status).toBe(404);
    expect((await world().http.get("/app/tickets/QB-0012", ASSERT.reader)).status).toBe(403);
  });

  it("adds a note and closes with the form token; never without it", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/app/tickets/QB-0012", ASSERT.owner)).text());
    const noted = await w.http.post("/app/tickets/QB-0012/note", { csrf, body: " Restarted the service. " }, ASSERT.owner);
    expect(noted.status).toBe(303);
    expect(w.note).toHaveBeenCalledWith(OWNER, "QB-0012", "Restarted the service.");
    const closed = await w.http.post("/app/tickets/QB-0012/close", { csrf, note: "" }, ASSERT.owner);
    expect(closed.status).toBe(303);
    expect(w.close).toHaveBeenCalledWith(OWNER, "QB-0012", null);
    const forged = await w.http.post("/app/tickets/QB-0012/close", { csrf: "nope" }, ASSERT.owner);
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty note, and says so when the ticket was already closed", async () => {
    const w = world({ close: false });
    const csrf = csrfIn(await (await w.http.get("/app/tickets/QB-0012", ASSERT.owner)).text());
    expect((await w.http.post("/app/tickets/QB-0012/note", { csrf, body: "  " }, ASSERT.owner)).status).toBe(400);
    expect(w.note).not.toHaveBeenCalled();
    expect((await w.http.post("/app/tickets/QB-0012/close", { csrf }, ASSERT.owner)).status).toBe(409);
  });
});
