import { describe, expect, it, vi } from "vitest";
import { curateItem } from "../../src/curator/curate.js";
import { merge } from "../../src/curator/consensus.js";
import type { ModelBackend } from "../../src/curator/model.js";
import type { Plan } from "../../src/curator/output.js";
import { StoreError } from "../../src/curator/store.js";
import { entitySchema } from "../../src/entities/templates.js";
import { fakeStore, page } from "./fixtures.js";
import { NORTHWIND_EMAIL } from "./northwind.js";

/**
 * Live, 2026-11-21: three Gmail items under a private rule (topics: none),
 * consensus on; one applied, two failed with curator_page_save 22023 right
 * after a tiebreak. A merged plan could name the same page twice (one run's
 * update and new page on one key shared a vote target), so the page was
 * written twice and the second write failed the database's stale-hash check
 * ("the page has changed since it was read"), which failed the whole item.
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-21T12:00:00Z");
const ORG = "northwind-test.com";
const org = page({ key: ORG, drawer: "organisations", title: "Northwind", body: "# Northwind\n\n## Timeline\n- 2026-11-01: met.\n", topics: [] });
const PRIVATE_ITEM = { ...NORTHWIND_EMAIL, topics: [] as string[] };

const orgUpdate = (text: string) => ({ key: ORG, patches: [{ op: "append-bullet" as const, section: "Timeline", text }], fields: { last_contact: "2026-11-20" }, related: [] as string[] });

function backend(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 100, outputTokens: 20 });
  return { complete };
}

describe("a merged plan writes each page key once", () => {
  it("an update and a new page on the same key in one run do not become two writes of one page", () => {
    const run: Plan = {
      updates: [orgUpdate("2026-11-20: SOW asked.") as never],
      newPages: [{ drawer: "people", key: ORG, title: "Northwind", fields: {}, related: [], sections: [] } as never],
      notes: "",
    };
    const m = merge([run, run, run], { schema, shortlist: [org] });
    const keys = [...m.plan.updates.map((u) => u.key), ...m.plan.newPages.map((n) => n.key)];
    expect(keys).toEqual([ORG]);
    expect(m.plan.updates.map((u) => u.key)).toEqual([ORG]);
  });
});

describe("private-rule Gmail item, tiebreak merge", () => {
  it("does not fail the item when a save is refused: the change goes to review with the reason", async () => {
    const f = fakeStore([org]);
    // What the database does for a second write on a stale hash.
    f.store.savePage.mockRejectedValueOnce(new StoreError("curator_page_save", "22023", "the page has changed since it was read; read it again"));
    const reply = (stage: string) => ({
      updates: [orgUpdate(`2026-11-20: Pat asked for a SOW (${stage}).`)],
      new_pages: [{ drawer: "deals", key: "deal:northwind-test.com-pilot", title: "Northwind pilot deal", fields: { organisation: ORG, stage, value: 12000 }, related: [ORG], sections: [{ heading: "Summary", text: "Pilot." }] }],
      notes: "",
    });
    const r = await curateItem(PRIVATE_ITEM, {
      store: f.store, model: backend(reply("lead"), reply("proposal")), modelName: "openai-gpt-oss-120b", schema, now: NOW,
      consensus: { tiebreak: backend(reply("proposal")), tiebreakName: "deepseek-v4.1-flash" },
    });
    expect(r.consensus).toBe("tiebreak");
    expect(r.outcome).not.toBe("failed");
    expect(f.reviews).toHaveLength(1);
    expect(f.reviews[0]!["reasons"]).toEqual(["could not apply: the page has changed since it was read; read it again"]);
    // Every save is in the item's own topics: none, for a private rule.
    for (const s of f.saves) expect(s.page["topics"] ?? []).toEqual([]);
  });
});
