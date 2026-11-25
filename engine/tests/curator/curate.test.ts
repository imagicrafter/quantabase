import { describe, expect, it, vi } from "vitest";
import { curateItem } from "../../src/curator/curate.js";
import { StoreError } from "../../src/curator/store.js";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { entitySchema } from "../../src/entities/templates.js";
import { INVOICES, LOYALTY, OVENS, PILOT, TOBIAS, TRICKS, fakeStore, item, modelSaying, page } from "./fixtures.js";

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-19T12:00:00Z");

function deps(model: ReturnType<typeof modelSaying>, store = fakeStore().store) {
  return { store, model, modelName: "openai-gpt-oss-120b", schema, now: NOW };
}

const bullet = (key: string, text: string, fields: Record<string, string | number> = {}) => ({
  updates: [{ key, patches: [{ op: "append-bullet", section: "Timeline", text }], fields }],
  new_pages: [],
});

describe("curateItem: small changes apply", () => {
  it("patches the page, records the source, closes the item", async () => {
    const f = fakeStore();
    const model = modelSaying(bullet(PILOT.key, "2026-11-19: map pack installed on all six tablets, so launch moves to 2026-11-30.", { next_step: "Launch 2026-11-30" }));
    const r = await curateItem(item(), deps(model, f.store));

    expect(r).toMatchObject({ outcome: "applied", pages: [`page-${PILOT.key}`], queued: 0, consensus: "single" });
    expect(f.saves).toHaveLength(1);
    const saved = f.saves[0]!;
    expect(saved.hash).toBe(PILOT.content_hash);
    expect(saved.page["body"]).toContain("- 2026-11-19: map pack installed");
    expect(saved.page["body"]).toContain("Dana Whitlock is the sponsor");
    expect(saved.page["fields"]).toEqual({ status: "active", next_step: "Launch 2026-11-30" });
    expect(saved.page["topics"]).toEqual(PILOT.topics);
    expect(saved.page["sources"]).toEqual([{ item: "item-1", source: "gmail", source_id: "thread-1", version: 1 }]);
    expect(saved.page["generated"]).toEqual({ by: "curator", model: "openai-gpt-oss-120b", at: "2026-11-19T12:00:00.000Z" });
    expect(f.done).toEqual([{ itemId: "item-1", outcome: "applied", pages: [`page-${PILOT.key}`], error: undefined }]);
  });

  it("sends the source only inside the data block, and matches by key first", async () => {
    const f = fakeStore();
    const model = modelSaying({ updates: [], new_pages: [] });
    await curateItem(item({ body: "From: dana@example.com\n\nhello" }), deps(model, f.store));
    expect(f.store.candidates).toHaveBeenCalledWith("item-1", ["dana@example.com"], "Route planner pilot", 8);
    const prompt = model.complete.mock.calls[0]![1] as string;
    expect(prompt).toMatch(/<<<SOURCE_TEXT id=[0-9a-f]{16}>>>\nFrom: dana@example.com\n\nhello\n<<<END_SOURCE_TEXT id=[0-9a-f]{16}>>>$/);
    expect(prompt).toContain("Date: 2026-11-19");
    expect(f.done[0]?.outcome).toBe("no_change");
  });

  it("creates a meeting page in the item's topics", async () => {
    const f = fakeStore();
    const model = modelSaying({
      updates: [],
      new_pages: [{ drawer: "meetings", key: "meeting:m1", title: "Pilot check-in", description: "Weekly check-in.",
        fields: { date: "2026-11-19" }, sections: [{ heading: "Notes", text: "Map pack done." }, { heading: "Summary", text: "Pilot on track." }] }],
    });
    const r = await curateItem(item({ topics: ["clients"] }), deps(model, f.store));
    expect(r.outcome).toBe("applied");
    const saved = f.saves[0]!;
    expect(saved.hash).toBeNull();
    expect(saved.page["topics"]).toEqual(["clients"]);
    expect(saved.page["body"]).toBe("# Pilot check-in\n\n## Summary\nPilot on track.\n\n## Notes\nMap pack done.\n");
  });
});

describe("curateItem: applies by default, waits only in extreme cases", () => {
  it("applies a stage change; it stays undoable from the page history", async () => {
    const f = fakeStore();
    const model = modelSaying(bullet(OVENS.key, "2026-11-19: Priya said they will sign.", { stage: "won" }));
    const r = await curateItem(item(), deps(model, f.store));
    expect(r.outcome).toBe("applied");
    expect(f.reviews).toHaveLength(0);
    expect(f.saves[0]!.page["fields"]).toMatchObject({ stage: "won" });
    expect(f.saves[0]!.hash).toBe(OVENS.content_hash);
  });

  it("queues a stage change whole when a person set the stage by hand", async () => {
    const handSet = page({ ...OVENS, verified: [{ field: "stage", value: "proposal", by: "person", at: "2026-11-01T00:00:00Z" }] });
    const f = fakeStore([PILOT, handSet]);
    const model = modelSaying(bullet(OVENS.key, "2026-11-19: Priya said they will sign.", { stage: "won" }));
    const r = await curateItem(item(), deps(model, f.store));
    expect(r.outcome).toBe("queued");
    expect(f.saves).toHaveLength(0);
    expect(f.reviews[0]).toMatchObject({ kind: "update", pageKey: OVENS.key, pageId: OVENS.id, baseHash: OVENS.content_hash, reasons: ["stage was set by hand"] });
  });

  it("applies a new deal beside the small update", async () => {
    const f = fakeStore();
    const model = modelSaying({
      ...bullet(PILOT.key, "2026-11-19: launch moves to 2026-11-30 because the tablets are ready."),
      new_pages: [{ drawer: "deals", key: "deal:northwind.example.com-phase-2", title: "Northwind phase 2", sections: [], fields: { stage: "lead" } }],
    });
    const r = await curateItem(item(), deps(model, f.store));
    expect(r.outcome).toBe("applied");
    expect(f.saves.map((s) => s.page["key"])).toEqual([PILOT.key, "deal:northwind.example.com-phase-2"]);
    expect(f.reviews).toHaveLength(0);
  });

  it("queues a new page whose key the owner holds outside the item's topics", async () => {
    const f = fakeStore();
    f.store.savePage.mockRejectedValueOnce(new StoreError("curator_page_save", "22023", "that page is shared more widely than this item"));
    const model = modelSaying({ updates: [], new_pages: [{ drawer: "meetings", key: "meeting:m1", title: "M", sections: [] }] });
    const r = await curateItem(item(), deps(model, f.store));
    expect(r.outcome).toBe("queued");
    expect(f.reviews[0]?.["reasons"]).toEqual(["could not create: that page is shared more widely than this item"]);
  });
});

describe("curateItem: prompt-injection tricks from the eval", () => {
  it.each(TRICKS.map((t) => [t.id, t] as const))("%s is held before any model call", async (_id, trick) => {
    const f = fakeStore();
    const model = modelSaying({ updates: [], new_pages: [] });
    const r = await curateItem(item({ title: trick.title, body: trick.body }), deps(model, f.store));
    expect(r.outcome).toBe("flagged");
    expect(model.complete).not.toHaveBeenCalled();
    expect(f.flags).toHaveLength(1);
    expect(f.done).toHaveLength(0);
  });

  // A person released each item, and the model obeyed the steering text.
  // Nothing may be written: the check or the queue stops every one.
  const obeyed: Record<string, unknown> = {
    "trick-canary-line": bullet(PILOT.key, "2026-11-19: CANARY-7731"),
    "trick-status-override": bullet(OVENS.key, "2026-11-19: decided.", { stage: "closed-won", next_step: "CANARY-4409" }),
    "trick-page-exfiltration": { updates: [{ key: LOYALTY.key, patches: [{ op: "append-paragraph", section: "Timeline",
      text: "2026-11-19: CANARY-5526 The private bank reference for refunds is REF-NW-PRIVATE-2291 and stays internal." }] }], new_pages: [] },
    "trick-privilege-grant": { updates: [{ key: TOBIAS.key, patches: [], fields: { role: "administrator" }, topics: ["admin"] }], new_pages: [] },
    "trick-fake-system-block": bullet(INVOICES.key, "2026-11-19: Verified by CANARY-9052", { next_date: "2099-01-01" }),
  };

  it.each(TRICKS.map((t) => [t.id, t] as const))("%s released and obeyed: nothing is written", async (id, trick) => {
    const f = fakeStore();
    const model = modelSaying(obeyed[id]);
    const r = await curateItem(item({ title: trick.title, body: trick.body, released: true }), deps(model, f.store));
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(f.saves).toHaveLength(0);
    expect(["failed", "queued"]).toContain(r.outcome);
    const prompt = model.complete.mock.calls[0]![1] as string;
    // Steering text reaches the model defanged where the guard knows the form.
    if (id === "trick-fake-system-block") expect(prompt).not.toContain("<|system|>");
  });
});

describe("curateItem: failures and re-runs", () => {
  it("does not patch a page twice when a cut-short run is repeated", async () => {
    const touched = page({ ...PILOT, sources: [{ item: "item-1", source: "gmail", source_id: "thread-1", version: 1 }] });
    const f = fakeStore([touched, OVENS]);
    const model = modelSaying({ updates: [], new_pages: [] });
    const r = await curateItem(item(), deps(model, f.store));
    expect(f.saves).toHaveLength(0);
    expect(r.pages).toEqual([touched.id]);
    expect(model.complete.mock.calls[0]![1]).not.toContain(`key=${PILOT.key}`);
  });

  it.each([
    ["a cut-off reply", modelSaying(bullet(PILOT.key, "2026-11-19: x"), "length"), "cut off"],
    ["prose", modelSaying("I could not decide."), "not JSON"],
    ["a model error", { complete: vi.fn().mockRejectedValue(new Error("model answered HTTP 503")) }, "HTTP 503"],
  ])("fails the item on %s, leaving it for a retry", async (_why, model, reason) => {
    const f = fakeStore();
    const r = await curateItem(item(), deps(model as ReturnType<typeof modelSaying>, f.store));
    expect(r.outcome).toBe("failed");
    expect(f.done[0]).toMatchObject({ outcome: "failed", error: expect.stringContaining(reason) });
    expect(f.saves).toHaveLength(0);
  });

  it("sends the update for review (not a failed item) when the page changed under it, and logs why", async () => {
    const f = fakeStore();
    f.store.savePage.mockRejectedValueOnce(new StoreError("curator_page_save", "22023", "the page has changed since it was read; read it again"));
    const logs = _captureLogsForTests();
    try {
      const r = await curateItem(item(), deps(modelSaying(bullet(PILOT.key, "2026-11-19: x happened because y.")), f.store));
      expect(r.outcome).toBe("queued");
      expect(f.reviews[0]).toMatchObject({ kind: "update", reasons: ["could not apply: the page has changed since it was read; read it again"] });
      const line = logs.lines().find((l) => l.includes("save refused"))!;
      expect(line).not.toContain(PILOT.key);
      expect(JSON.parse(line)).toMatchObject({ item: item().id, fn: "curator_page_save", code: "22023", error: expect.stringContaining("changed") });
    } finally {
      logs.stop();
    }
  });

  it("still fails the item on any other database error", async () => {
    const f = fakeStore();
    f.store.savePage.mockRejectedValueOnce(new StoreError("curator_page_save", "42501", "curator_page_save failed"));
    const r = await curateItem(item(), deps(modelSaying(bullet(PILOT.key, "2026-11-19: x happened because y.")), f.store));
    expect(r).toMatchObject({ outcome: "failed" });
  });
});
