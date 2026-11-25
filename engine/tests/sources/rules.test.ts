import { describe, it, expect } from "vitest";
import {
  addressValue,
  firefliesFilter,
  gmailClause,
  gmailLabelTerm,
  gmailAfterTerm,
  gmailNewerThanTerm,
  gmailQuery,
  parseRules,
  splitAddresses,
  type Rule,
} from "../../src/sources/rules.js";

const inc = (match: Rule["match"], topic = "clients"): Rule => ({ kind: "include", match, topic });
const exc = (match: Rule["match"]): Rule => ({ kind: "exclude", match });

describe("address values", () => {
  it("keeps an address, turns a domain into @domain, refuses anything else", () => {
    expect(addressValue(" Bob@Acme.com ")).toBe("bob@acme.com");
    expect(addressValue("acme.com")).toBe("@acme.com");
    expect(addressValue("@Sales.Acme.com")).toBe("@sales.acme.com");
    expect(addressValue("not an address")).toBeNull();
    expect(addressValue("acme")).toBeNull();
  });

  it("splits typed chips and reports the bad ones", () => {
    expect(splitAddresses("bob@acme.com, acme.org; nope  @x.io")).toEqual({
      values: ["bob@acme.com", "@acme.org", "@x.io"],
      bad: ["nope"],
    });
  });
});

describe("Gmail query", () => {
  it("label terms use the name in Gmail's search form", () => {
    expect(gmailLabelTerm("Clients/Acme Inc")).toBe("label:clients-acme-inc");
  });

  it("label terms: mixed case, spaces and nested labels", () => {
    expect(gmailLabelTerm("Quantabase-test")).toBe("label:quantabase-test");
    expect(gmailLabelTerm("QuantaBase TEST")).toBe("label:quantabase-test");
    expect(gmailLabelTerm("  Board   Pack  ")).toBe("label:board-pack");
    expect(gmailLabelTerm("Clients/Acme/2026 Deals")).toBe("label:clients-acme-2026-deals");
  });

  it("label rules use the name's search form, while the rule keeps the label id", () => {
    const rule = inc({ labels: [{ id: "Label_42", name: "Quantabase-test" }] });
    expect(gmailClause(rule)).toBe("label:quantabase-test");
    expect(rule.match.labels![0]!.id).toBe("Label_42");
  });

  it("the after term is a date one day before since (never epoch seconds)", () => {
    expect(gmailAfterTerm("2026-11-18T09:30:00Z")).toBe("after:2026/11/17");
    expect(gmailAfterTerm("2026-03-01T00:00:00Z")).toBe("after:2026/02/28");
    expect(gmailAfterTerm("2026-01-01T05:00:00Z")).toBe("after:2025/12/31");
  });

  it("the fallback term is newer_than whole days back to since, plus one day", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(gmailNewerThanTerm("2026-11-18T09:30:00Z", now)).toBe("newer_than:5d");
    expect(gmailNewerThanTerm("2026-11-21T11:00:00Z", now)).toBe("newer_than:2d");
    expect(gmailNewerThanTerm("2026-11-22T00:00:00Z", now)).toBe("newer_than:1d");
  });

  it("a rule's fields are ANDed and its values ORed", () => {
    expect(gmailClause(inc({ from: ["bob@acme.com", "@acme.org"], labels: [{ id: "L1", name: "Deals" }] }))).toBe(
      "((from:bob@acme.com OR from:acme.org) label:deals)",
    );
  });

  it("is the OR of include rules, minus every exclude, after since", () => {
    const q = gmailQuery([exc({ labels: [{ id: "L9", name: "Personal" }] }), inc({ any_address: ["@acme.com"] }), inc({ labels: [{ id: "L2", name: "Board" }] })], "after:2026/11/17");
    expect(q).toBe("((from:acme.com OR to:acme.com OR cc:acme.com) OR label:board) -label:personal after:2026/11/17");
  });

  it("one include alone needs no outer group", () => {
    expect(gmailQuery([inc({ to: ["ann@x.com"] })], "newer_than:3d")).toBe("to:ann@x.com newer_than:3d");
  });

  it("is null when no include rule works: nothing to list", () => {
    expect(gmailQuery([], "after:2026/01/01")).toBeNull();
    expect(gmailQuery([exc({ from: ["@spam.com"] })], "after:2026/01/01")).toBeNull();
    expect(gmailQuery([{ ...inc({ labels: [{ id: "gone" }] }), broken: true }], "after:2026/01/01")).toBeNull();
  });
});

describe("Fireflies filter", () => {
  it("collects channels and participants from working include rules only", () => {
    expect(
      firefliesFilter([
        inc({ channels: [{ id: "c1" }] }),
        inc({ participants: ["@acme.com"] }),
        exc({ participants: ["@hr.example"] }),
        { ...inc({ channels: [{ id: "c-gone" }] }), broken: true },
      ]),
    ).toEqual({ channel_ids: ["c1"], participants: ["@acme.com"] });
    expect(firefliesFilter([exc({ channels: [{ id: "c" }] })])).toBeNull();
  });
});

describe("parseRules", () => {
  it("drops malformed rules from the database answer", () => {
    expect(parseRules([{ kind: "include", match: { from: ["a@b.com"] }, topic: "x" }, { kind: "weird" }, "nope"])).toHaveLength(1);
    expect(parseRules(null)).toEqual([]);
  });
});
