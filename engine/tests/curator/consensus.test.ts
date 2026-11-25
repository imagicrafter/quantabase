import { describe, expect, it, vi } from "vitest";
import { curateItem } from "../../src/curator/curate.js";
import { decisionsOf, merge } from "../../src/curator/consensus.js";
import type { ModelBackend } from "../../src/curator/model.js";
import type { Plan } from "../../src/curator/output.js";
import { entitySchema } from "../../src/entities/templates.js";
import { fakeStore, page } from "./fixtures.js";
import { NORTHWIND_EMAIL } from "./northwind.js";

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-21T12:00:00Z");
const ORG = "northwind-test.com";
const DEAL = "deal:northwind-test.com-pilot";
const org = page({ key: ORG, drawer: "organisations", title: "Northwind", body: "# Northwind\n\n## Timeline\n- 2026-11-01: met.\n" });

const dealPage = (stage: string, text = "Pilot.") => ({
  drawer: "deals", key: DEAL, title: "Northwind pilot deal",
  fields: { organisation: ORG, stage, value: 12000 }, related: [ORG],
  sections: [{ heading: "Summary", text }],
});
const reply = (stage: string, text?: string) => ({
  updates: [{ key: ORG, patches: [{ op: "append-bullet", section: "Timeline", text: `2026-11-20: Pat asked for a SOW (${text ?? "a"}).` }], fields: { last_contact: "2026-11-20" } }],
  new_pages: [dealPage(stage, text)],
  notes: "",
});

function backend(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 100, outputTokens: 20 });
  return { complete };
}

const deps = (primary: ModelBackend, tiebreak: ModelBackend, store: ReturnType<typeof fakeStore>["store"]) => ({
  store, model: primary, modelName: "openai-gpt-oss-120b", schema, now: NOW,
  consensus: { tiebreak, tiebreakName: "deepseek-v4.1-flash" },
});

const plan = (r: ReturnType<typeof reply>): Plan => ({
  updates: r.updates.map((u) => ({ ...u, patches: u.patches as never, related: [] })),
  newPages: r.new_pages.map((n) => ({ ...n, sections: n.sections })) as never,
  notes: "",
});

describe("decisions compare structure, not wording", () => {
  it("same pages and fields with different wording agree", () => {
    const a = decisionsOf(plan(reply("lead", "one wording")));
    const b = decisionsOf(plan(reply("lead", "other wording")));
    expect(a).toEqual(b);
    expect(a.get(`page:deals:${DEAL}`)).toBe("create");
    expect(a.get(`field:${DEAL}:stage`)).toBe('"lead"');
  });

  it("majority of three wins per decision; all-different is uncertain", () => {
    const m = merge([plan(reply("lead")), plan(reply("proposal")), plan(reply("lead"))]);
    expect(m.plan.newPages[0]!.fields["stage"]).toBe("lead");
    expect(m.uncertain).toEqual([]);
    const u = merge([plan(reply("lead")), plan(reply("proposal")), plan(reply("won"))]);
    expect(u.uncertain.map((d) => d.decision)).toEqual([`field:${DEAL}:stage`]); // no vote context: compared by key
    expect(u.plan.newPages[0]!.fields["stage"]).toBeUndefined();
    expect(u.uncertain[0]!.proposals).toEqual([`${DEAL} stage = "lead"`, `${DEAL} stage = "proposal"`, `${DEAL} stage = "won"`]);
  });
});

describe("consensus curation", () => {
  it("agree: two primary runs agree, run 1's patches apply, no tiebreak", async () => {
    const f = fakeStore([org]);
    const primary = backend(reply("lead", "first"), reply("lead", "second"));
    const tiebreak = backend();
    const r = await curateItem(NORTHWIND_EMAIL, deps(primary, tiebreak, f.store));
    expect(primary.complete).toHaveBeenCalledTimes(2);
    expect(tiebreak.complete).not.toHaveBeenCalled();
    expect(r.consensus).toBe("agreed");
    expect(r.tokens).toBe(240);
    const deal = f.saves.find((s) => s.page["key"] === DEAL)!;
    expect(String(deal.page["body"])).toContain("first");
  });

  it("tiebreak: the runs differ, the tiebreaker sides with one, that side's text applies", async () => {
    const f = fakeStore([org]);
    const primary = backend(reply("lead", "first"), reply("proposal", "second"));
    const tiebreak = backend(reply("proposal", "third"));
    const r = await curateItem(NORTHWIND_EMAIL, deps(primary, tiebreak, f.store));
    expect(tiebreak.complete).toHaveBeenCalledTimes(1);
    expect(r.consensus).toBe("tiebreak");
    const deal = f.saves.find((s) => s.page["key"] === DEAL)!;
    expect(deal.page["fields"]).toMatchObject({ stage: "proposal" });
    expect(f.uncertain).toHaveLength(0);
  });

  it("uncertain: all three differ, the decision is dropped and recorded, never queued", async () => {
    const f = fakeStore([org]);
    const r = await curateItem(
      NORTHWIND_EMAIL,
      deps(backend(reply("lead"), reply("proposal")), backend(reply("won")), f.store),
    );
    expect(r.consensus).toBe("uncertain");
    expect(f.reviews).toHaveLength(0);
    const deal = f.saves.find((s) => s.page["key"] === DEAL)!;
    expect((deal.page["fields"] as Record<string, unknown>)["stage"]).toBeUndefined();
    expect(f.uncertain).toEqual([
      expect.objectContaining({ itemId: NORTHWIND_EMAIL.id, decision: `field:deals@${ORG}:stage`, proposals: [`${DEAL} stage = "lead"`, `${DEAL} stage = "proposal"`, `${DEAL} stage = "won"`] }),
    ]);
  });
});
