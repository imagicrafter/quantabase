import { describe, it, expect } from "vitest";
import { applyOp, describeRule, forSave, needsYes, ruleFromForm } from "../../src/app/sources-edit.js";
import type { Rule } from "../../src/sources/rules.js";

const A: Rule = { id: "a", kind: "include", match: { from: ["@a.com"] }, topic: "clients" };
const B: Rule = { id: "b", kind: "exclude", match: { labels: [{ id: "L9", name: "Personal" }] } };
const C: Rule = { id: "c", kind: "include", match: { to: ["x@y.com"] }, private: true };
const LIST = [A, B, C] as const;

describe("applyOp never changes the list it was given", () => {
  it("moves, removes and adds into a new list", () => {
    const frozen = Object.freeze([...LIST]);
    expect(applyOp(frozen, { op: "up", index: 1 })).toEqual([B, A, C]);
    expect(applyOp(frozen, { op: "down", index: 1 })).toEqual([A, C, B]);
    expect(applyOp(frozen, { op: "delete", index: 0 })).toEqual([B, C]);
    expect(applyOp(frozen, { op: "add", rule: C })).toHaveLength(4);
    expect(frozen).toEqual(LIST);
  });

  it("refuses moves off the ends and unknown indexes", () => {
    expect(applyOp(LIST, { op: "up", index: 0 })).toMatch(/first/);
    expect(applyOp(LIST, { op: "down", index: 2 })).toMatch(/last/);
    expect(applyOp(LIST, { op: "delete", index: 7 })).toMatch(/No such/);
  });

  it("changes where an include rule files items; an exclude has no topic", () => {
    const next = applyOp(LIST, { op: "target", index: 0, target: { kind: "private" } }) as Rule[];
    expect(next[0]).toEqual({ id: "a", kind: "include", match: { from: ["@a.com"] }, private: true });
    expect(applyOp(LIST, { op: "target", index: 1, target: { kind: "private" } })).toMatch(/Only an include/);
  });
});

describe("needsYes: only edits that could widen who sees new items", () => {
  it("narrowing edits apply at once", () => {
    expect(needsYes(LIST, { op: "add", rule: B })).toBe(false);
    expect(needsYes(LIST, { op: "add", rule: C })).toBe(false);
    expect(needsYes(LIST, { op: "target", index: 0, target: { kind: "private" } })).toBe(false);
  });

  it("widening edits need a yes", () => {
    expect(needsYes(LIST, { op: "add", rule: A })).toBe(true);
    expect(needsYes(LIST, { op: "delete", index: 1 })).toBe(true);
    // Removing an include can let items fall through to a lower, wider rule.
    expect(needsYes(LIST, { op: "delete", index: 0 })).toBe(true);
    expect(needsYes(LIST, { op: "up", index: 1 })).toBe(true);
    expect(needsYes(LIST, { op: "target", index: 2, target: { kind: "topic", topic: "clients" } })).toBe(true);
  });
});

describe("ruleFromForm", () => {
  const picker = [{ id: "L1", name: "Clients" }];
  const form = (over: Partial<Parameters<typeof ruleFromForm>[1]> = {}) => ({
    kind: "include", name: " Acme ", target: "topic:clients", text: { any_address: "acme.com, bob@x.org" }, labels: [] as string[], ...over,
  });

  it("builds a rule from the boxes, normalising addresses", () => {
    expect(ruleFromForm("gmail", form(), picker, ["clients"])).toEqual({
      kind: "include", name: "Acme", match: { any_address: ["@acme.com", "bob@x.org"] }, topic: "clients",
    });
  });

  it("ignores fields the source does not have", () => {
    const r = ruleFromForm("fireflies", form({ text: { from: "a@b.com", participants: "acme.com" } }), [], ["clients"]) as Rule;
    expect(r.match).toEqual({ participants: ["@acme.com"] });
  });

  it("refuses an unknown label, an empty rule, a topic not held, and a bad address", () => {
    expect(ruleFromForm("gmail", form({ labels: ["L404"], text: {} }), picker, ["clients"])).toMatch(/Choose labels/);
    expect(ruleFromForm("gmail", form({ text: {} }), picker, ["clients"])).toMatch(/at least one/);
    expect(ruleFromForm("gmail", form({ target: "topic:secret" }), picker, ["clients"])).toMatch(/your topics/);
    expect(ruleFromForm("gmail", form({ text: { from: "nope" } }), picker, ["clients"])).toMatch(/Not an email/);
  });
});

describe("forSave and describeRule", () => {
  it("drops display-only keys and label names", () => {
    expect(forSave({ ...B, broken: true, match: { labels: [{ id: "L9", name: "Personal", deleted: true }] } })).toEqual({
      id: "b", kind: "exclude", match: { labels: [{ id: "L9" }] },
    });
  });

  it("describes rules in plain words", () => {
    expect(describeRule(A)).toBe("Keep where from is @a.com, filed under clients");
    expect(describeRule(B)).toBe("Leave out items where label is Personal");
    expect(describeRule(C)).toMatch(/private \(only you\)/);
  });
});
