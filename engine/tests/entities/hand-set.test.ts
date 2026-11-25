import { describe, expect, it } from "vitest";
import { handSetFields, markHandSet } from "../../src/entities/hand-set.js";

const AT = "2026-11-21T10:00:00.000Z";

describe("hand-set fields", () => {
  it("records each field a person changed, with its value, and keeps other entries", () => {
    const other = { note: "checked by Dana" };
    const out = markHandSet([other], { stage: "lead", value: 1 }, { stage: "won", value: 1, next_step: "Sign" }, AT);
    expect(out).toEqual([
      other,
      { field: "stage", value: "won", by: "person", at: AT },
      { field: "next_step", value: "Sign", by: "person", at: AT },
    ]);
  });

  it("replaces an older mark for the same field and marks a removed field as null", () => {
    const first = markHandSet([], {}, { stage: "lead" }, "2026-11-01T00:00:00Z");
    const out = markHandSet(first, { stage: "lead" }, {}, AT);
    expect(out).toEqual([{ field: "stage", value: null, by: "person", at: AT }]);
  });

  it("returns the same list when nothing changed (no new object needed)", () => {
    const v = [{ field: "stage", value: "lead", by: "person", at: AT }];
    expect(markHandSet(v, { stage: "lead" }, { stage: "lead" }, AT)).toBe(v);
  });

  it("reads only well-formed person marks", () => {
    const m = handSetFields([{ field: "stage", value: "won", by: "person", at: AT }, { field: "value", by: "curator" }, "junk", null]);
    expect([...m.entries()]).toEqual([["stage", "won"]]);
  });
});
