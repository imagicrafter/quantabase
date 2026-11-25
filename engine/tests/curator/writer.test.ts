import { describe, expect, it, vi } from "vitest";
import { curateItem, type CurateDeps } from "../../src/curator/curate.js";
import { withUpdateLine } from "../../src/curator/apply.js";
import { buildWriterPrompt, writerSystem } from "../../src/curator/prompt.js";
import type { ModelBackend } from "../../src/curator/model.js";
import { entitySchema } from "../../src/entities/templates.js";
import { ALL_PAGES, INVOICES, PILOT, fakeStore, item } from "./fixtures.js";

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-22T12:00:00Z");
const WRITER = "anthropic-claude-sonnet-5.5";
const TRIAGE = "openai-gpt-oss-120b";

function replying(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) {
    complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000 });
  }
  return { complete };
}

const deps = (writer: ModelBackend, store: ReturnType<typeof fakeStore>["store"], triage?: ModelBackend): CurateDeps => ({
  store, model: writer, modelName: WRITER, schema, now: NOW,
  writer: triage ? { triage: { model: triage, name: TRIAGE } } : {},
});

const PILOT_UPDATE = {
  updates: [{
    key: PILOT.key,
    patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: Dana said the offline map pack is installed on all six tablets; launch moves to 2026-11-30." }],
    update_line: "Map pack installed on all six tablets; launch moves to 2026-11-30.",
  }],
  new_pages: [],
  notes: "",
};

describe("single writer with triage (the default curator)", () => {
  it("stops at triage when nothing is durable: no writer call, outcome no change, cost recorded", async () => {
    const f = fakeStore();
    const triage = replying({ durable: false, reason: "a scheduling reply" });
    const writer = replying(PILOT_UPDATE);
    const r = await curateItem(item({ body: "Can we move our call to 3pm? Thanks!" }), deps(writer, f.store, triage));
    expect(writer.complete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ outcome: "no_change", triaged: true, reason: "triage: a scheduling reply" });
    expect(f.done[0]).toMatchObject({ outcome: "no_change" });
    expect(r.usage?.[TRIAGE]).toMatchObject({ calls: 1, input: 1000, output: 200 });
    expect(r.usd).toBeGreaterThan(0);
  });

  it("gives the writer only the target pages, a short title list and no full index; applies with a dated updates line", async () => {
    const f = fakeStore();
    const triage = replying({
      durable: true, reason: "launch date", summary: "Map pack installed; launch 2026-11-30.",
      targets: [PILOT.key], new_pages: [], excerpts: [[1, 4]],
    });
    const writer = replying(PILOT_UPDATE);
    // Only the pilot matches strongly; the other pages came from a word search.
    f.store.candidates.mockImplementation(async (_i: string, keys: readonly string[]) =>
      ALL_PAGES.some((p) => keys.includes(p.key))
        ? ALL_PAGES.filter((p) => keys.includes(p.key))
        : ALL_PAGES.map((p) => ({ ...p, matched_on: "search" })));
    const r = await curateItem(item(), deps(writer, f.store, triage));
    expect(r.outcome).toBe("applied");
    const [system, user] = writer.complete.mock.calls[0]! as [string, string];
    expect(system).toContain("RULES");
    expect(system).toContain("DRAWERS");
    expect(system).not.toContain("offline map pack is installed");
    expect(user).toContain(`=== PAGE key=${PILOT.key}`);
    expect(user).not.toContain(`=== PAGE key=${INVOICES.key}`);
    expect(user).toContain("Summary of the whole item");
    const saved = String(f.saves[0]!.page["body"]);
    expect(saved).toMatch(/^# Northwind Route Planner Pilot\n\n## Major updates\n- 2026-11-19: Map pack installed/);
    expect(saved).toContain("launch moves to 2026-11-30.");
    expect(Object.keys(r.usage ?? {}).sort()).toEqual([WRITER, TRIAGE].sort());
    expect(r.usage?.[WRITER]?.cacheRead).toBe(3000);
  });

  it("falls back to the matched pages when the triage reply is unusable", async () => {
    const f = fakeStore();
    const triage = { complete: vi.fn().mockResolvedValue({ text: "sorry", finish: "stop", inputTokens: 10, outputTokens: 2 }) };
    const writer = replying(PILOT_UPDATE);
    const r = await curateItem(item(), deps(writer, f.store, triage));
    expect(writer.complete).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("applied");
    expect(r.routing).toMatch(/triage unusable/);
  });

  it("runs without triage when it is off", async () => {
    const f = fakeStore();
    const writer = replying(PILOT_UPDATE);
    const r = await curateItem(item(), deps(writer, f.store));
    expect(writer.complete).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ outcome: "applied", consensus: "single" });
  });
});

describe("writer prompt", () => {
  it("keeps the system prompt the same for every item, so the provider can cache it", () => {
    expect(writerSystem(schema)).toBe(writerSystem(schema));
    expect(writerSystem(schema)).toContain("PAGE SHAPE");
    expect(writerSystem(schema)).toContain('"update_line"');
    expect(writerSystem(schema)).toContain("Key Interactions");
  });

  it("lists at most 20 other page titles", () => {
    const index = Array.from({ length: 50 }, (_, i) => ({
      key: `project:p${i}`, drawer: "projects", title: `P ${i}`, aliases: [], description: null, identities: [], score: 0, matched_on: "search",
    }));
    const u = buildWriterPrompt({ item: item(), pages: [PILOT], index, schema, source: "x", excerpted: false });
    expect(u.match(/^- project:p\d+/gm)).toHaveLength(20);
  });
});

describe("updates line at the top of a page", () => {
  const body = "# Pat Rivera\n\n## Summary\nCOO.\n\n## Key Interactions\n- 2026-11-01: met.\n";
  const u = { heading: "Major updates", max: 2, date: "2026-11-22", text: "Signed the pilot SOW." };

  it("adds the section after the title, newest first, capped, and keeps other sections", () => {
    const one = withUpdateLine(body, u);
    expect(one).toMatch(/^# Pat Rivera\n\n## Major updates\n- 2026-11-22: Signed the pilot SOW\.\n\n## Summary/);
    expect(one).toContain("## Key Interactions\n- 2026-11-01: met.");
    const two = withUpdateLine(one, { ...u, date: "2026-11-23", text: "Kickoff set." });
    const three = withUpdateLine(two, { ...u, date: "2026-11-24", text: "2026-11-24: Invoice sent." });
    expect(three).toContain("## Major updates\n- 2026-11-24: Invoice sent.\n- 2026-11-23: Kickoff set.\n\n## Summary");
    expect(three).not.toContain("Signed the pilot SOW");
  });

  it("does not add the same line twice", () => {
    const once = withUpdateLine(body, u);
    expect(withUpdateLine(once, u)).toBe(once);
  });
});
