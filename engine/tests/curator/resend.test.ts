import { describe, expect, it, vi } from "vitest";
import { curateItem } from "../../src/curator/curate.js";
import { dropRepeats, nearSame } from "../../src/curator/dedupe.js";
import { missingRequired } from "../../src/curator/required.js";
import { entitySchema } from "../../src/entities/templates.js";
import type { ModelBackend } from "../../src/curator/model.js";
import { ALL_PAGES, fakeStore, page } from "./fixtures.js";
import { NORTHWIND_EMAIL, NORTHWIND_PLAN } from "./northwind.js";

/**
 * Regression for the 2026-11-21 live run: the Northwind email re-sent as a new
 * item, with the person, organisation and project pages already there. The
 * model ignored the deal rule (no deal page) and repeated facts on Pat's page.
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-21T12:00:00Z");
const ORG = "northwind-test.com";
const PERSON = "pat.rivera@northwind-test.com";
const PROJECT = "project:northwind-pilot";
const PAT_LINE = "- 2026-11-20: asked for a SOW by 2026-11-25 for a 6-week pilot from 2026-12-01.";

const existing = [
  page({ key: PERSON, drawer: "people", title: "Pat Rivera", body: `# Pat Rivera\n\n## Summary\nCOO.\n\n## Timeline\n${PAT_LINE}\n` }),
  page({ key: ORG, drawer: "organisations", title: "Northwind Logistics", body: "# Northwind\n\n## Summary\nProspect.\n\n## Timeline\n- 2026-11-20: pilot asked.\n" }),
  page({ key: PROJECT, drawer: "projects", title: "Northwind pilot", body: "# Pilot\n\n## Summary\nPilot.\n\n## Timeline\n- 2026-11-20: SOW asked.\n" }),
];

const RESENT = { ...NORTHWIND_EMAIL, id: "item-nw-2", source_id: "thread-nw-2", received_at: "2026-11-21T09:00:00Z" };

/** No deal; repeats Pat's line with a new date; adds one real new fact. */
const NO_DEAL = {
  updates: [
    {
      key: PERSON,
      patches: [
        { op: "append-bullet", section: "Timeline", text: "2026-11-21: Asked for a SOW by 2026-11-25 for a 6-week pilot from 2026-12-01" },
        { op: "append-bullet", section: "Timeline", text: "2026-11-21: Pat Rivera said she leads the pilot as COO." },
      ],
      fields: { last_contact: "2026-11-21" },
    },
    { key: ORG, patches: [], fields: { last_contact: "2026-11-21" } },
  ],
  new_pages: [],
  notes: "",
};

const DEAL_PAGE = NORTHWIND_PLAN.new_pages.find((n) => n.drawer === "deals")!;
const WITH_DEAL = { ...NO_DEAL, new_pages: [{ ...DEAL_PAGE, related: [PERSON, ORG, PROJECT] }] };

function modelReplying(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 1, outputTokens: 1 });
  return { complete };
}

const deps = (model: ModelBackend, store: ReturnType<typeof fakeStore>["store"]) => ({
  store, model, modelName: "openai-gpt-oss-120b", schema, now: NOW,
});

describe("required drawers come from template patterns", () => {
  it("the Northwind email matches the Deals pattern; a plain note does not", () => {
    const plan = { updates: [], newPages: [], notes: "" };
    expect(missingRequired(NORTHWIND_EMAIL.body, plan, schema, existing)).toEqual(["deals"]);
    expect(missingRequired("See you Tuesday.", plan, schema, existing)).toEqual([]);
    expect(missingRequired(NORTHWIND_EMAIL.body, plan, entitySchema(["solo"]), existing)).toEqual([]);
  });

  it("an update to a deal on the shortlist counts", () => {
    const deal = page({ key: "deal:northwind-test.com-pilot", drawer: "deals", title: "Deal", body: "## Notes\n" });
    const plan = { updates: [{ key: deal.key, patches: [], fields: {}, related: [] }], newPages: [], notes: "" };
    expect(missingRequired(NORTHWIND_EMAIL.body, plan, schema, [deal])).toEqual([]);
  });
});

describe("repeated facts are skipped", () => {
  it("near-same ignores the date, case and punctuation", () => {
    expect(nearSame("2026-11-21: Asked for a SOW by 2026-11-25 for a 6-week pilot from 2026-12-01", PAT_LINE)).toBe(true);
    expect(nearSame("2026-11-21: Pat Rivera said she leads the pilot as COO.", PAT_LINE)).toBe(false);
  });

  it("drops a repeated line and keeps the new one", () => {
    const plan = { updates: [{ key: PERSON, patches: NO_DEAL.updates[0]!.patches as never, fields: {}, related: [] }], newPages: [], notes: "" };
    const out = dropRepeats(plan, existing);
    expect(out.updates[0]!.patches).toHaveLength(1);
    expect(JSON.stringify(out.updates[0]!.patches)).toContain("leads the pilot");
  });
});

describe("the re-sent Northwind email with existing pages", () => {
  it("gives the deal rule as a hint in the prompt and asks only once", async () => {
    const f = fakeStore([...ALL_PAGES, ...existing]);
    const model = modelReplying(WITH_DEAL);
    const r = await curateItem(RESENT, deps(model, f.store));
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(String(model.complete.mock.calls[0]![1])).toMatch(/HINT: this item may concern a deal \(drawer deals\)/);
    expect(r.outcome).toBe("applied");
    const deal = f.saves.find((s) => s.page["drawer"] === "deals");
    expect(deal?.page["key"]).toBe("deal:northwind-test.com-pilot");
    // Pat's page gets the new fact once, never the repeat.
    const pat = String(f.saves.find((s) => s.page["key"] === PERSON)!.page["body"]);
    expect(pat.match(/SOW by 2026-11-25/g)).toHaveLength(1);
    expect(pat).toContain("leads the pilot as COO");
  });

  it("never fails an item for a missing deal: the rest is applied", async () => {
    const f = fakeStore([...ALL_PAGES, ...existing]);
    const r = await curateItem(RESENT, deps(modelReplying(NO_DEAL), f.store));
    expect(r.outcome).toBe("applied");
    expect(f.done[0]).toMatchObject({ outcome: "applied" });
    expect(f.saves.some((s) => s.page["drawer"] === "deals")).toBe(false);
  });
});
