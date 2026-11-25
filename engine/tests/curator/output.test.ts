import { describe, expect, it } from "vitest";
import { entitySchema } from "../../src/entities/templates.js";
import { checkReply, extractJsonObject, fieldProblem, keyProblem } from "../../src/curator/output.js";
import { LARGE_REMOVAL_SHARE, judgeNewPage, judgeUpdate, removal } from "../../src/curator/policy.js";
import { itemKeys, meetingKey, sourceKeyRules, sourceKeys } from "../../src/curator/keys.js";
import { ALL_PAGES, INVOICES, OVENS, PILOT, item, page } from "./fixtures.js";

const schema = entitySchema(["consulting"]);
const ctx = { shortlist: ALL_PAGES, schema, sourceText: item().body };
const drawer = (id: string) => schema.drawers.find((d) => d.id === id)!;

const good = {
  updates: [
    {
      key: PILOT.key,
      patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: map pack installed on all six tablets, so launch can move to 2026-11-30." }],
      fields: { next_step: "Launch on 2026-11-30" },
    },
  ],
  new_pages: [],
  notes: "",
};

describe("checkReply accepts only the contract", () => {
  it("accepts a good reply, fenced or not", () => {
    const r = checkReply("```json\n" + JSON.stringify(good) + "\n```", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.updates[0]?.fields).toEqual({ next_step: "Launch on 2026-11-30" });
  });

  it.each([
    ["not JSON", "sure, here you go"],
    ["an extra key", { ...good, set_role: "admin" }],
    ["an unknown op", { ...good, updates: [{ key: PILOT.key, patches: [{ op: "rewrite", section: "Summary", text: "x" }] }] }],
    ["a key not on the shortlist", { ...good, updates: [{ ...good.updates[0], key: "project:other" }] }],
    ["topics in an update", { ...good, updates: [{ ...good.updates[0], topics: ["private"] }] }],
    ["an undated bullet", { ...good, updates: [{ key: PILOT.key, patches: [{ op: "append-bullet", section: "Timeline", text: "map pack done" }] }] }],
    ["a bad enum value", { ...good, updates: [{ key: OVENS.key, patches: [], fields: { stage: "closed-won" } }] }],
    ["a bad date", { ...good, updates: [{ key: OVENS.key, patches: [], fields: { next_date: "2026-02-30" } }] }],
    ["a new page with a bad key", { ...good, updates: [], new_pages: [{ drawer: "deals", key: "Big Deal", title: "Big", sections: [] }] }],
    ["a new page in an unknown drawer", { ...good, updates: [], new_pages: [{ drawer: "secrets", key: "secret:x", title: "X", sections: [] }] }],
  ])("rejects %s", (_why, reply) => {
    const r = checkReply(typeof reply === "string" ? reply : JSON.stringify(reply), ctx);
    expect(r.ok).toBe(false);
  });

  it("leaves out a bad field or a repeated page alone, and says why", () => {
    const field = checkReply(JSON.stringify({ ...good, updates: [{ ...good.updates[0], fields: { owner_email: "x@y.com" } }] }), ctx);
    expect(field.ok).toBe(true);
    if (field.ok) {
      expect(field.plan.updates[0]?.fields).toEqual({});
      expect(field.plan.updates[0]?.patches).toHaveLength(1);
      expect(field.plan.dropped?.join(" ")).toMatch(/owner_email/);
    }
    const twice = checkReply(JSON.stringify({ ...good, updates: [good.updates[0], good.updates[0]] }), ctx);
    expect(twice.ok && twice.plan.updates.length).toBe(1);
    if (twice.ok) expect(twice.plan.dropped?.join(" ")).toMatch(/named twice/);
  });

  it("files a patch to a section the page lacks in the page's events section (round 4)", () => {
    const r = checkReply(JSON.stringify({ ...good, updates: [{ key: PILOT.key, patches: [{ op: "append-bullet", section: "Risks", text: "2026-11-19: x" }] }] }), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.updates[0]?.patches[0]).toMatchObject({ op: "append-bullet", section: "Timeline" });
  });

  it("refuses more updates than the contract allows", () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ ...good.updates[0], key: `project:p${n}` }));
    expect(checkReply(JSON.stringify({ ...good, updates: many }), ctx).ok).toBe(false);
  });

  it("accepts a new page on a shortlist key (it becomes an update of that page before saving)", () => {
    const reply = { ...good, updates: [], new_pages: [{ drawer: "projects", key: PILOT.key, title: "X", sections: [] }] };
    expect(checkReply(JSON.stringify(reply), ctx).ok).toBe(true);
  });

  it("rejects text copied from another page (exfiltration)", () => {
    const leak = {
      ...good,
      updates: [{ key: PILOT.key, patches: [{ op: "append-paragraph", section: "Notes",
        text: "2026-11-19: The private bank reference for refunds is REF-NW-PRIVATE-2291 and stays internal." }] }],
    };
    const r = checkReply(JSON.stringify(leak), ctx);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("copies text from another page") });
  });

  it("allows text the source itself contains even if a page has it too", () => {
    const quote = "The private bank reference for refunds is REF-NW-PRIVATE-2291 and stays internal.";
    const r = checkReply(
      JSON.stringify({ ...good, updates: [{ key: PILOT.key, patches: [{ op: "append-paragraph", section: "Notes", text: `2026-11-19: ${quote}` }] }] }),
      { ...ctx, sourceText: quote },
    );
    expect(r.ok).toBe(true);
  });

  it("drops empty updates and accepts a dated new section", () => {
    const r = checkReply(JSON.stringify({ updates: [
      { key: INVOICES.key, patches: [] },
      { key: PILOT.key, patches: [{ op: "new-section-after", after: "Timeline", heading: "2026-11-19 launch plan", text: "Launch moves." }] },
    ], new_pages: [] }), ctx);
    expect(r.ok && r.plan.updates.map((u) => u.key)).toEqual([PILOT.key]);
  });

  it("extracts the object from prose", () => {
    expect(extractJsonObject('Here: {"a":1} done')).toBe('{"a":1}');
  });
});

describe("field and key rules", () => {
  it("checks field kinds", () => {
    expect(fieldProblem(drawer("deals"), "value", 10)).toBeNull();
    expect(fieldProblem(drawer("deals"), "value", "ten")).toMatch(/number/);
    expect(fieldProblem(drawer("deals"), "next_step", "a\nb")).toMatch(/one/);
    expect(fieldProblem(drawer("people"), "organisation", "acme.com")).toBeNull();
  });

  it("checks key rules by drawer", () => {
    expect(keyProblem(drawer("people"), "dana@example.com")).toBeNull();
    expect(keyProblem(drawer("people"), "dana")).not.toBeNull();
    expect(keyProblem(drawer("organisations"), "example.com")).toBeNull();
    expect(keyProblem(drawer("organisations"), "www.example.com")).not.toBeNull();
    expect(keyProblem(drawer("deals"), "deal:example.com-2026-audit")).toBeNull();
    expect(keyProblem(drawer("deals"), "project:x")).not.toBeNull();
    expect(keyProblem(drawer("meetings"), "meeting:01abc")).toBeNull();
  });
});

describe("policy: apply by default, queue only extreme cases", () => {
  const upd = (fields: Record<string, string | number>, text = "2026-11-19: ok") => ({
    key: OVENS.key, patches: [{ op: "append-bullet" as const, section: "Timeline", text }], fields,
  });
  const handSet = (field: string, value: unknown) => page({ ...OVENS, verified: [{ field, value, by: "person", at: "2026-11-01T00:00:00Z" }] });

  it("applies field changes, stage and value included, and long additions", () => {
    expect(judgeUpdate(upd({ next_step: "Call Priya" }), OVENS, schema, false)).toEqual({ apply: true });
    expect(judgeUpdate(upd({ stage: "won" }), OVENS, schema, false)).toEqual({ apply: true });
    expect(judgeUpdate(upd({ value: 3000 }), OVENS, schema, false)).toEqual({ apply: true });
    expect(judgeUpdate(upd({}, `2026-11-19: ${"x".repeat(3100)}`), OVENS, schema, false)).toEqual({ apply: true });
  });

  it("queues anything from an item flagged as possible AI steering", () => {
    expect(judgeUpdate(upd({}), OVENS, schema, true)).toEqual({ apply: false, reasons: ["item was held by the steering screen"] });
  });

  it("queues a change that overwrites a value a person set by hand", () => {
    expect(judgeUpdate(upd({ stage: "won" }), handSet("stage", "proposal"), schema, false))
      .toEqual({ apply: false, reasons: ["stage was set by hand"] });
    // Setting the hand-set value again, or another field, applies.
    expect(judgeUpdate(upd({ stage: "proposal" }), handSet("stage", "proposal"), schema, false)).toEqual({ apply: true });
    expect(judgeUpdate(upd({ next_step: "x" }), handSet("stage", "proposal"), schema, false)).toEqual({ apply: true });
  });

  it("queues a change that replaces a large part of the page", () => {
    const long = page({ ...OVENS, body: "# T\n\n## Summary\n" + "A".repeat(500) + "\n\n## Timeline\n- 2026-10-02: sent.\n" });
    const replace = { key: OVENS.key, fields: {}, patches: [{ op: "replace-line" as const, section: "Summary", old: "A".repeat(500), new: "B" }] };
    expect(judgeUpdate(replace, long, schema, false)).toEqual({ apply: false, reasons: [`would remove ${LARGE_REMOVAL_SHARE * 100}% or more of the page`] });
    const small = { key: OVENS.key, fields: {}, patches: [{ op: "replace-line" as const, section: "Timeline", old: "- 2026-10-02: sent.", new: "- 2026-10-02: proposal sent." }] };
    expect(judgeUpdate(small, long, schema, false)).toEqual({ apply: true });
  });

  it("measures removal: a dropped section counts, appends never do", () => {
    const before = "# T\n\n## Summary\nOne.\n\n## Notes\n- a\n";
    expect(removal(before, before + "- b\n")).toEqual({ share: 0, lostSections: [] });
    expect(removal(before, "# T\n\n## Summary\nOne.\n").lostSections).toEqual(["Notes"]);
  });

  it("applies every new page, deals and offers included; queues only a released item's", () => {
    const n = (d: string) => ({ drawer: d, key: "x", title: "X", sections: [], fields: {} });
    expect(judgeNewPage(n("deals"), schema, false)).toEqual({ apply: true });
    expect(judgeNewPage(n("offers"), schema, false)).toEqual({ apply: true });
    expect(judgeNewPage(n("meetings"), schema, false)).toEqual({ apply: true });
    expect(judgeNewPage(n("meetings"), schema, true).apply).toBe(false);
  });
});

describe("keys an item names", () => {
  it("finds addresses and domains, without the owner and free mail", () => {
    const keys = itemKeys(item({
      body: "From: Dana <dana@northwind.example.com>\nTo: owner@example.com\nCc: pal@gmail.com\n\nhello carl@other.com",
      metadata: { participants: ["priya@harbor.example.org"] },
    }));
    expect(keys).toEqual([
      "priya@harbor.example.org", "dana@northwind.example.com", "pal@gmail.com",
      "harbor.example.org", "northwind.example.com",
    ]);
  });

  it("makes a meeting key for meeting sources and meeting ids", () => {
    expect(meetingKey({ source: "fireflies", source_id: "01ABC", metadata: {} })).toBe("meeting:01abc");
    expect(meetingKey({ source: "gmail", source_id: "t1", metadata: { meeting_id: "M 2" } })).toBe("meeting:m-2");
    expect(meetingKey({ source: "gmail", source_id: "t1", metadata: {} })).toBeNull();
  });

  it("source-id keys come from the template's key rule, not code", () => {
    const rules = sourceKeyRules([
      { ...entitySchema([]).drawers.find((d) => d.id === "meetings")!, id: "calls", key_rule: { kind: "source_id", text: "call: then the id", sources: ["dialpad"] } },
    ]);
    expect(rules).toEqual([{ prefix: "call", sources: ["dialpad"] }]);
    expect(sourceKeys({ source: "dialpad", source_id: "X1", metadata: {} }, rules)).toEqual(["call:x1"]);
    expect(sourceKeys({ source: "fireflies", source_id: "X1", metadata: {} }, rules)).toEqual([]);
    expect(sourceKeys({ source: "gmail", source_id: "t", metadata: { call_id: "Z 9" } }, rules)).toEqual(["call:z-9"]);
  });
});
