import { describe, expect, it, vi } from "vitest";
import { curateItem } from "../../src/curator/curate.js";
import { merge, normaliseField } from "../../src/curator/consensus.js";
import type { ModelBackend } from "../../src/curator/model.js";
import type { Plan } from "../../src/curator/output.js";
import { entitySchema, loadTemplates } from "../../src/entities/templates.js";
import { fakeStore, page } from "./fixtures.js";
import { NORTHWIND_EMAIL } from "./northwind.js";

/**
 * Slug-keyed drawers (deals, projects) get a free name from the model, so
 * three runs invent three keys for the same deal. The vote compares them by
 * their anchor (the organisation, from the template's key_rule.anchor) and
 * field values after normalising, so the same deal is one decision.
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-21T12:00:00Z");
const ORG = "northwind-test.com";
const PERSON = "pat.rivera@northwind-test.com";
const PROJECT = "project:northwind-pilot";
const SLUGS = ["deal:northwind-test.com-pilot", "deal:northwind-test.com-6-week-pilot", "deal:northwind-test.com-sow"] as const;
const ctx = (shortlist = [orgPage]) => ({ schema, shortlist });

const orgPage = page({ key: ORG, drawer: "organisations", title: "Northwind", body: "# Northwind\n\n## Timeline\n- 2026-11-01: met.\n", fields: { role: "prospect" } });
const personPage = page({ key: PERSON, drawer: "people", title: "Pat Rivera", body: "# Pat Rivera\n\n## Timeline\n- 2026-11-01: met.\n", fields: { organisation: ORG } });
const projectPage = page({ key: PROJECT, drawer: "projects", title: "Northwind pilot", body: "# Northwind pilot\n\n## Timeline\n- 2026-11-01: idea.\n", fields: { organisation: ORG, status: "proposed" } });

type DealOver = { key?: string; stage?: string; value?: number; nextStep?: string; text?: string };
const deal = (o: DealOver = {}) => ({
  drawer: "deals", key: o.key ?? SLUGS[0], title: "Northwind pilot deal",
  fields: { organisation: ORG, stage: o.stage ?? "proposal", value: o.value ?? 12000, ...(o.nextStep ? { next_step: o.nextStep } : {}) },
  related: [ORG],
  sections: [{ heading: "Summary", text: o.text ?? "Pilot." }],
});
const orgUpdate = (nextStep: string, dealKey: string) => ({
  key: ORG,
  patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-20: Pat asked for a SOW." }],
  fields: { last_contact: "2026-11-20", next_step: nextStep },
  related: [dealKey],
});
const reply = (dealOver: DealOver, nextStep = "Send the SOW") => {
  const d = deal(dealOver);
  return { updates: [orgUpdate(nextStep, d.key)], new_pages: [d], notes: "" };
};
const plan = (r: ReturnType<typeof reply>): Plan => ({
  updates: r.updates.map((u) => ({ ...u, patches: u.patches as never })),
  newPages: r.new_pages as never,
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

describe("templates name the anchor in YAML", () => {
  it("deals and projects anchor on organisation; every anchor is a field of its drawer", () => {
    const deals = schema.drawers.find((d) => d.id === "deals")!;
    expect(deals.key_rule.anchor).toEqual({ field: "organisation", single_open: { field: "stage", closed: ["won", "lost"] } });
    expect(schema.drawers.find((d) => d.id === "projects")!.key_rule.anchor?.field).toBe("organisation");
    for (const t of loadTemplates().values()) {
      for (const d of t.drawers) {
        const a = d.key_rule.anchor;
        if (!a) continue;
        expect(d.key_rule.kind).toBe("slug");
        expect(d.fields.map((f) => f.name)).toContain(a.field);
        if (a.single_open) expect(d.fields.map((f) => f.name)).toContain(a.single_open.field);
      }
    }
  });
});

describe("field values are normalised before the vote", () => {
  const deals = schema.drawers.find((d) => d.id === "deals")!;
  it("numbers, dates, enums, keys", () => {
    expect(normaliseField(deals, "value", 12000)).toBe(normaliseField(deals, "value", "$12,000"));
    expect(normaliseField(deals, "value", 12000.0)).toBe(normaliseField(deals, "value", "12000"));
    expect(normaliseField(deals, "next_date", "2026-11-25")).toBe(normaliseField(deals, "next_date", "2026-11-25T00:00:00Z"));
    expect(normaliseField(deals, "stage", "Proposal")).toBe(normaliseField(deals, "stage", "proposal"));
    expect(normaliseField(deals, "organisation", " Northwind-Test.com ")).toBe(normaliseField(deals, "organisation", ORG));
    expect(normaliseField(deals, "value", 12000)).not.toBe(normaliseField(deals, "value", 15000));
  });
  it("free text votes on being set, not on wording", () => {
    expect(normaliseField(deals, "next_step", "Send the SOW")).toBe(normaliseField(deals, "next_step", "Email Pat the scope of work"));
  });
});

describe("slug-keyed pages vote by anchor", () => {
  it("three runs, three deal slugs, same org and value: one deal, no uncertain", () => {
    const m = merge(
      [plan(reply({ key: SLUGS[0] }, "Send the SOW")), plan(reply({ key: SLUGS[1] }, "Write the scope")), plan(reply({ key: SLUGS[2] }, "SOW by 11/25"))],
      ctx(),
    );
    expect(m.uncertain).toEqual([]);
    expect(m.plan.newPages).toHaveLength(1);
    expect(m.plan.newPages[0]).toMatchObject({ drawer: "deals", key: SLUGS[0], fields: { organisation: ORG, stage: "proposal", value: 12000 } });
    // The org update from run 1 links to the canonical deal key.
    expect(m.plan.updates[0]!.related).toEqual([SLUGS[0]]);
    expect(m.plan.updates[0]!.fields["next_step"]).toBe("Send the SOW");
  });

  it("links from the winning side are rewritten to the canonical key", () => {
    const a = reply({ key: SLUGS[1] });
    const m = merge([plan(reply({ key: SLUGS[0] })), plan(a), plan(a)], ctx());
    expect(m.plan.newPages[0]!.key).toBe(SLUGS[0]);
    expect(m.plan.updates.flatMap((u) => u.related)).toEqual([SLUGS[0]]);
  });

  it("an open deal for the organisation on the shortlist is patched, not duplicated", () => {
    const open = page({ key: "deal:northwind-test.com-existing", drawer: "deals", title: "Northwind deal", body: "# Northwind deal\n\n## Notes\n- 2026-11-01: lead.\n", fields: { organisation: ORG, stage: "lead" } });
    const m = merge([plan(reply({ key: SLUGS[0] })), plan(reply({ key: SLUGS[1] })), plan(reply({ key: SLUGS[2] }))], ctx([orgPage, open]));
    expect(m.uncertain).toEqual([]);
    expect(m.plan.newPages).toEqual([]);
    const u = m.plan.updates.find((x) => x.key === open.key)!;
    expect(u.fields).toMatchObject({ stage: "proposal", value: 12000 });
    expect(u.fields["organisation"]).toBeUndefined();
    expect(m.plan.updates.find((x) => x.key === ORG)!.related).toEqual([open.key]);
  });

  it("a closed (won) deal for the organisation does not take the new one", () => {
    const won = page({ key: "deal:northwind-test.com-2025", drawer: "deals", title: "Old deal", body: "# Old\n", fields: { organisation: ORG, stage: "won" } });
    const m = merge([plan(reply({ key: SLUGS[0] })), plan(reply({ key: SLUGS[1] })), plan(reply({ key: SLUGS[2] }))], ctx([orgPage, won]));
    expect(m.plan.newPages.map((n) => n.key)).toEqual([SLUGS[0]]);
  });

  it("uncertain decisions carry each run's target and value", () => {
    const m = merge(
      [plan(reply({ key: SLUGS[0], stage: "lead" })), plan(reply({ key: SLUGS[1], stage: "proposal" })), plan(reply({ key: SLUGS[2], stage: "won" }))],
      ctx(),
    );
    expect(m.uncertain.map((u) => u.decision)).toEqual([`field:deals@${ORG}:stage`]);
    expect(m.uncertain[0]!.proposals).toEqual([`${SLUGS[0]} stage = "lead"`, `${SLUGS[1]} stage = "proposal"`, `${SLUGS[2]} stage = "won"`]);
    expect(m.plan.newPages[0]!.fields["stage"]).toBeUndefined();
    expect(m.plan.newPages[0]!.fields["value"]).toBe(12000);
  });
});

describe("curation with consensus: same deal, different slugs", () => {
  it("one deal page, tiebreak, no failure", async () => {
    const f = fakeStore([orgPage]);
    const r = await curateItem(
      NORTHWIND_EMAIL,
      deps(backend(reply({ key: SLUGS[0] }), reply({ key: SLUGS[1] })), backend(reply({ key: SLUGS[2] })), f.store),
    );
    expect(r.outcome).not.toBe("failed");
    expect(r.consensus).toBe("agreed"); // the two primary runs already agree by organisation
    const deals = f.saves.filter((s) => String(s.page["key"]).startsWith("deal:"));
    expect(deals.map((s) => s.page["key"])).toEqual([SLUGS[0]]);
    expect(deals[0]!.page["fields"]).toMatchObject({ value: 12000, organisation: ORG });
    expect(f.uncertain).toEqual([]);
  });

  it("live shape: existing person, org and project; resent pilot email with $12,000 and a SOW ask", async () => {
    const f = fakeStore([personPage, orgPage, projectPage]);
    const live = (slug: string, step: string, projectStep: string) => ({
      updates: [
        { ...orgUpdate(step, slug), related: [PROJECT, slug] },
        { key: PERSON, patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-20: asked for the SOW." }], fields: { last_contact: "2026-11-20", next_step: step } },
        { key: PROJECT, patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-20: SOW requested." }], fields: { next_step: projectStep, start_date: "2026-12-01" } },
      ],
      new_pages: [{ ...deal({ key: slug, stage: "proposal", value: 12000, nextStep: step }), related: [ORG, PERSON, PROJECT] }],
      notes: "",
    });
    const r = await curateItem(
      NORTHWIND_EMAIL,
      deps(
        backend(live(SLUGS[0], "Send the SOW", "Draft SOW"), live(SLUGS[1], "Send SOW by 11/25", "Write the scope")),
        backend(live(SLUGS[2], "Reply with a SOW", "SOW due 2026-11-25")),
        f.store,
      ),
    );
    expect(f.uncertain).toEqual([]);
    expect(r.consensus).toBe("agreed"); // the two primary runs already agree by organisation
    expect(r.outcome).toBe("applied");
    const keys = f.saves.map((s) => s.page["key"]);
    expect(keys.filter((k) => String(k).startsWith("deal:"))).toEqual([SLUGS[0]]);
    expect(keys).toEqual(expect.arrayContaining([ORG, PERSON, PROJECT]));
  });
});
