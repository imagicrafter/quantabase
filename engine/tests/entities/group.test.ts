import { describe, it, expect } from "vitest";
import { groupByKey, summariseEntities } from "../../src/entities/group.js";

const row = (o: Partial<Record<string, unknown>>) => ({
  id: "id",
  owner_handle: "ann",
  is_own: false,
  drawer: "deals",
  key: "k",
  title: "T",
  description: null,
  fields: {},
  status: "unreviewed",
  reviewed: null,
  updated_at: "2026-11-01T00:00:00Z",
  ...o,
});

describe("groupByKey", () => {
  it("one group per key, own page first, order of first appearance kept", () => {
    const groups = groupByKey([
      row({ id: "1", key: "b", is_own: false }),
      row({ id: "2", key: "a" }),
      row({ id: "3", key: "b", is_own: true }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["b", "a"]);
    expect(groups[0]!.pages.map((p) => p.id)).toEqual(["3", "1"]);
  });
});

describe("summariseEntities", () => {
  const rows = [
    row({ id: "1", key: "deal:a", is_own: true, fields: { stage: "won", value: 10 } }),
    row({ id: "2", key: "deal:a", owner_handle: "eve", fields: { stage: "proposal", value: 10 } }),
    row({ id: "3", key: "deal:b", fields: { stage: "lead", value: 5 } }),
    row({ id: "4", key: "deal:c", fields: { stage: "won", value: 7 } }),
  ];

  it("counts keys, not pages, and marks field conflicts with both values", () => {
    const out = summariseEntities(rows, {});
    expect(out.count).toBe(3);
    const a = out.entities.find((e) => e.key === "deal:a")!;
    expect(a.pages).toHaveLength(2);
    expect(a.fields["value"]).toEqual({ value: 10 });
    expect(a.fields["stage"]).toEqual({ conflict: true, values: ["won", "proposal"] });
    expect(a.conflicts).toEqual(["stage"]);
  });

  it("filters exactly: a key matches when any of its pages has the value", () => {
    const out = summariseEntities(rows, { filter: { stage: "won" } });
    expect(out.entities.map((e) => e.key).sort()).toEqual(["deal:a", "deal:c"]);
    expect(out.count).toBe(2);
  });

  it("sorts on a field, keys without it last, and limits", () => {
    const out = summariseEntities(rows, { sort: "value", desc: true, limit: 2 });
    expect(out.entities.map((e) => e.key)).toEqual(["deal:a", "deal:c"]);
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(true);
  });
});
