import { describe, expect, it, vi } from "vitest";
import { curateItem } from "../../src/curator/curate.js";
import type { ModelBackend } from "../../src/curator/model.js";
import { resolveCreates, sectionsAsPatches } from "../../src/curator/resolve.js";
import { StoreError, type PageRow } from "../../src/curator/store.js";
import { entitySchema } from "../../src/entities/templates.js";
import { fakeStore, page } from "./fixtures.js";
import { NORTHWIND_EMAIL } from "./northwind.js";

/**
 * Live, 2026-11-21: a private-rule Gmail item (topics: none) about a person
 * and organisation the owner already had pages for was curated with
 * consensus; the plan proposed CREATING a page on a key the owner already had
 * in the same (empty) topic set, the database refused it ("you already have
 * a page with this key"), and the run summary said failed 1, queued 0 while
 * the log said "sent for review".
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-21T12:00:00Z");
const PERSON = "pat.rivera@northwind-test.com";
const PROJECT = "project:northwind-pilot";
const PRIVATE_ITEM = {
  ...NORTHWIND_EMAIL,
  topics: [] as string[],
  title: "Northwind follow-up",
  body: "From: pat.rivera@northwind-test.com\nTo: owner@example.com\nSubject: Northwind follow-up\n\n" +
    "Hi,\n\nThanks for the call. I am still the COO and will lead the pilot. I will send my notes by 2026-11-25.\n\nPat Rivera",
};

const person = page({
  key: PERSON, drawer: "people", title: "Pat Rivera", topics: [],
  body: "# Pat Rivera\n\n## Summary\nCOO of Northwind Logistics.\n\n## Timeline\n- 2026-11-01: first call.\n",
});
const project = page({
  key: PROJECT, drawer: "projects", title: "Northwind pilot", topics: [],
  body: "# Northwind pilot\n\n## Summary\nA pilot.\n\n## Timeline\n- 2026-11-01: scoped.\n",
});

const createPerson = {
  drawer: "people", key: PERSON, title: "Pat Rivera", fields: { role: "COO" }, related: [PROJECT],
  sections: [
    { heading: "Summary", text: "COO of Northwind Logistics." },
    { heading: "Timeline", text: "- 2026-11-20: asked for a SOW by 2026-11-25." },
  ],
};
const createProject = {
  drawer: "projects", key: PROJECT, title: "Northwind pilot", fields: { status: "proposed" }, related: [PERSON],
  sections: [{ heading: "Timeline", text: "- 2026-11-20: SOW asked for." }, { heading: "Budget", text: "$12,000." }],
};
const patchPerson = {
  key: PERSON, patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-20: asked for a SOW by 2026-11-25." }],
  fields: { role: "COO" }, related: [],
};

function backend(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 100, outputTokens: 20 });
  return { complete };
}

/**
 * Like curator_candidates: key matches first, then what the search shows
 * (`shown`); a page whose key the item does not name and the search missed
 * is found only by a lookup on its own key.
 */
function storeWith(pages: readonly PageRow[], shown: readonly PageRow[]) {
  const f = fakeStore(pages);
  f.store.candidates.mockImplementation(async (_i: string, keys: readonly string[]) => {
    const byKey = pages.filter((p) => keys.includes(p.key));
    return [...byKey, ...shown.filter((p) => !byKey.includes(p))];
  });
  return f;
}

describe("resolveCreates", () => {
  it("turns a create on an existing key into a patch of that page", async () => {
    const r = await resolveCreates(
      { updates: [], newPages: [createPerson as never], notes: "" }, [person], "item-x", async () => null,
    );
    expect(r.plan.newPages).toEqual([]);
    expect(r.plan.updates.map((u) => u.key)).toEqual([PERSON]);
    expect(r.plan.updates[0]!.fields).toEqual({ role: "COO" });
    expect(r.converted).toEqual([PERSON]);
  });

  it("finds a page the shortlist missed by a key lookup", async () => {
    const lookup = vi.fn(async (k: string) => (k === PROJECT ? project : null));
    const r = await resolveCreates({ updates: [], newPages: [createProject as never], notes: "" }, [], "item-x", lookup);
    expect(lookup).toHaveBeenCalledWith(PROJECT);
    expect(r.shortlist.map((p) => p.key)).toEqual([PROJECT]);
    expect(r.plan.updates[0]!.patches).toEqual([
      { op: "append-bullet", section: "Timeline", text: "2026-11-20: SOW asked for." },
      { op: "new-section-after", after: "Timeline", heading: "Budget", text: "$12,000." },
    ]);
  });

  it("keeps a create with no existing page", async () => {
    const r = await resolveCreates({ updates: [], newPages: [createProject as never], notes: "" }, [], "item-x", async () => null);
    expect(r.plan.newPages.map((n) => n.key)).toEqual([PROJECT]);
  });

  it("drops a create whose existing page already lists this item", async () => {
    const written = { ...project, sources: [{ item: "item-x" }] };
    const r = await resolveCreates({ updates: [], newPages: [createProject as never], notes: "" }, [], "item-x", async () => written);
    expect(r.plan.updates).toEqual([]);
    expect(r.done).toEqual([written.id]);
  });

  it("leaves out a section patch that would not apply", () => {
    expect(sectionsAsPatches("no headings here", [{ heading: "Budget", text: "x" }])).toEqual([]);
  });
});

describe("private item about an existing person and project", () => {
  it("patches both pages and does not fail (single run)", async () => {
    const f = storeWith([person, project], []);
    f.store.savePage.mockImplementation(async (_i: string, p: Record<string, unknown>, hash: string | null) => {
      if (hash === null) throw new StoreError("curator_page_save", "22023", "you already have a page with this key; read it with find_entity and pass its content_hash as expected_hash");
      f.saves.push({ itemId: _i, page: p, hash });
      return { id: `page-${String(p["key"])}`, changed: true, created: false };
    });
    const reply = { updates: [], new_pages: [createPerson, createProject], notes: "" };
    const r = await curateItem(PRIVATE_ITEM, { store: f.store, model: backend(reply, reply), modelName: "m", schema, now: NOW });
    expect([r.outcome, r.reason]).toEqual(["applied", undefined]);
    expect(r.queued).toBe(0);
    expect(f.saves.map((s) => [s.page["key"], s.hash])).toEqual([[PERSON, person.content_hash], [PROJECT, project.content_hash]]);
    for (const s of f.saves) expect(s.page["topics"]).toEqual([]);
    // The page has a Timeline: the proposed "Budget" section goes there, not beside it.
    expect(String(f.saves[1]!.page["body"])).not.toContain("## Budget");
    expect(String(f.saves[1]!.page["body"])).toContain("$12,000.");
  });

  it("consensus: one run creates, two patch -> one patch, no failure", async () => {
    const f = storeWith([person], [person]);
    const create = { updates: [], new_pages: [{ ...createPerson, key: PERSON, related: [] }], notes: "" };
    const patch = { updates: [patchPerson], new_pages: [], notes: "" };
    const r = await curateItem(PRIVATE_ITEM, {
      store: f.store, model: backend(create, patch), modelName: "m", schema, now: NOW,
      consensus: { tiebreak: backend(patch), tiebreakName: "t" },
    });
    expect([r.outcome, r.reason]).toEqual(["applied", undefined]);
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]!.hash).toBe(person.content_hash);
    expect(f.reviews).toEqual([]);
  });

  it("consensus: two runs create, one patches -> still a patch of the existing page", async () => {
    const f = storeWith([person], []);
    const create = { updates: [], new_pages: [{ ...createPerson, key: PERSON, related: [] }], notes: "" };
    const r = await curateItem(PRIVATE_ITEM, {
      store: f.store, model: backend(create, create), modelName: "m", schema, now: NOW,
      consensus: { tiebreak: backend(create), tiebreakName: "t" },
    });
    expect(r.reason).toBeUndefined();
    expect(f.saves.every((s) => s.hash === person.content_hash)).toBe(true);
  });
});

describe("review counting matches the log", () => {
  it("a refused save that reaches review is counted as queued", async () => {
    const f = storeWith([], []);
    f.store.savePage.mockRejectedValueOnce(new StoreError("curator_page_save", "22023", "you already have a page with this key"));
    const reply = { updates: [], new_pages: [{ ...createProject, related: [] }], notes: "" };
    const r = await curateItem(PRIVATE_ITEM, { store: f.store, model: backend(reply, reply), modelName: "m", schema, now: NOW });
    expect(r.queued).toBe(1);
    expect(f.reviews).toHaveLength(1);
  });

  it("a repeat of an open review (no row made) is not counted as queued", async () => {
    const f = storeWith([], []);
    f.store.savePage.mockRejectedValueOnce(new StoreError("curator_page_save", "22023", "you already have a page with this key"));
    f.store.queueReview.mockResolvedValueOnce(null as never);
    const reply = { updates: [], new_pages: [{ ...createProject, related: [] }], notes: "" };
    const r = await curateItem(PRIVATE_ITEM, { store: f.store, model: backend(reply, reply), modelName: "m", schema, now: NOW });
    expect(r.queued).toBe(0);
  });
});
