import { describe, it, expect } from "vitest";
import {
  ageDays,
  contactsForDb,
  isBulkAddress,
  isFreeMail,
  isStrong,
  startsTicked,
  mailContactsSchema,
  parseSuggestions,
  ruleCovering,
} from "../../src/sources/mail-contacts.js";
import type { Rule } from "../../src/sources/rules.js";

const REPORT = {
  account: "ann@work.example",
  days: 90,
  messages_read: 40,
  addresses: [
    { address: "bob@acme.example", sent_to: 5, received_from: 3, threads: 4, replied: 2, last_seen: "2026-11-20T10:00:00Z", free_mail: false },
    { address: "pat@gmail.com", sent_to: 1, received_from: 0, threads: 1, replied: 0, last_seen: "2026-11-01T10:00:00Z" },
  ],
  domains: [{ domain: "acme.example", sent_to: 6, received_from: 3, threads: 5, replied: 2, last_seen: "2026-11-20T10:00:00Z", people: 2 }],
  dropped: { bulk: 3, category: 9, skipped: 0, unreadable: 0 },
};

describe("mail contacts: the report schema takes counts only", () => {
  it("accepts the plugin script's output as it is", () => {
    expect(mailContactsSchema.parse(REPORT).addresses).toHaveLength(2);
  });

  it.each([
    ["a subject", { subject: "Q3 numbers" }],
    ["a snippet", { snippet: "hello" }],
    ["a message id", { message_id: "m1" }],
    ["a name", { name: "Bob Smith" }],
  ])("refuses %s on an address", (_what, extra) => {
    const bad = { ...REPORT, addresses: [{ ...REPORT.addresses[0], ...extra }] };
    expect(mailContactsSchema.safeParse(bad).success).toBe(false);
  });

  it("refuses unknown top-level keys, negative counts, bad addresses and too many rows", () => {
    expect(mailContactsSchema.safeParse({ ...REPORT, bodies: [] }).success).toBe(false);
    expect(mailContactsSchema.safeParse({ ...REPORT, addresses: [{ ...REPORT.addresses[0], sent_to: -1 }] }).success).toBe(false);
    expect(mailContactsSchema.safeParse({ ...REPORT, addresses: [{ ...REPORT.addresses[0], address: "not mail" }] }).success).toBe(false);
    expect(mailContactsSchema.safeParse({ ...REPORT, domains: [{ ...REPORT.domains[0], domain: "acme example" }] }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => ({ ...REPORT.addresses[0], address: `p${i}@acme.example` }));
    expect(mailContactsSchema.safeParse({ ...REPORT, addresses: many }).success).toBe(false);
    expect(mailContactsSchema.safeParse({ ...REPORT, days: 400 }).success).toBe(false);
  });
});

describe("mail contacts: what goes to the database", () => {
  it("flattens to rows, marks free mail itself and keeps no names", () => {
    const { rows } = contactsForDb(mailContactsSchema.parse(REPORT));
    expect(rows).toContainEqual({ kind: "address", value: "pat@gmail.com", sent_to: 1, received_from: 0, threads: 1, replied: 0, people: 1, free_mail: true, chosen: null, last_seen: "2026-11-01T10:00:00.000Z" });
    expect(rows).toContainEqual(expect.objectContaining({ kind: "domain", value: "acme.example", people: 2, free_mail: false }));
  });

  it("carries the person's choices from Claude: true, false, or null when they made none", () => {
    const report = mailContactsSchema.parse({
      ...REPORT,
      addresses: [{ ...REPORT.addresses[0], chosen: true }, { ...REPORT.addresses[1], chosen: false }],
    });
    const { rows } = contactsForDb(report);
    expect(rows.map((r) => r.chosen)).toEqual([true, false, null]);
    expect(mailContactsSchema.safeParse({ ...REPORT, domains: [{ ...REPORT.domains[0], chosen: "yes" }] }).success).toBe(false);
  });

  it("drops the account itself, bulk senders and free-mail domains, and says how many", () => {
    const report = mailContactsSchema.parse({
      ...REPORT,
      addresses: [...REPORT.addresses, { ...REPORT.addresses[0], address: "ann@work.example" }, { ...REPORT.addresses[0], address: "no-reply@acme.example" }],
      domains: [...REPORT.domains, { ...REPORT.domains[0], domain: "gmail.com" }],
    });
    const { rows, dropped } = contactsForDb(report);
    expect(rows.map((r) => r.value)).toEqual(["bob@acme.example", "pat@gmail.com", "acme.example"]);
    expect(dropped).toBe(3);
  });

  it("knows bulk and free-mail addresses", () => {
    for (const a of ["noreply@x.example", "notifications@x.example", "mailer-daemon@x.example", "bounce-9@x.example"]) expect(isBulkAddress(a)).toBe(true);
    for (const a of ["bob@x.example", "noreen@x.example", "replyall@x.example"]) expect(isBulkAddress(a)).toBe(false);
    expect(isFreeMail("outlook.com")).toBe(true);
    expect(isFreeMail("acme.example")).toBe(false);
  });
});

describe("mail contacts: suggestions on the rule screen", () => {
  const rows = [
    { kind: "domain", value: "acme.example", sent_to: 6, received_from: 3, threads: 5, replied: 2, people: 2, free_mail: false, last_seen: "2026-11-20T10:00:00Z" },
    { kind: "address", value: "pat@gmail.com", sent_to: 1, received_from: 4, threads: 3, replied: 0, people: 1, free_mail: true, last_seen: null },
    { kind: "bogus", value: "x" },
    "junk",
  ];

  it("parses rows from the database and drops anything malformed", () => {
    const list = parseSuggestions(rows);
    expect(list.map((s) => s.value)).toEqual(["acme.example", "pat@gmail.com"]);
    expect(parseSuggestions(null)).toEqual([]);
  });

  it("is strong when the owner sent to it three or more times", () => {
    const [acme, pat] = parseSuggestions(rows);
    expect(isStrong(acme!)).toBe(true);
    expect(isStrong(pat!)).toBe(false);
  });

  it("starts ticked: the person's picks when they made any, else anyone sent mail three or more times", () => {
    const [acme, pat] = parseSuggestions(rows);
    expect([acme!, pat!].map((s) => s.chosen)).toEqual([null, null]);
    const noChoices = [acme!, pat!];
    expect(noChoices.filter(startsTicked(noChoices)).map((s) => s.value)).toEqual(["acme.example"]);
    const picked = [{ ...acme!, chosen: false }, { ...pat!, chosen: true }];
    expect(picked.filter(startsTicked(picked)).map((s) => s.value)).toEqual(["pat@gmail.com"]);
    expect(parseSuggestions([{ ...(rows[0] as object), chosen: true }])[0]!.chosen).toBe(true);
  });

  it("finds the rule that already covers an address or a domain", () => {
    const rules: Rule[] = [
      { kind: "include", name: "Acme", match: { any_address: ["@acme.example"] }, topic: "clients" },
      { kind: "exclude", name: "Pat", match: { from: ["pat@gmail.com"] } },
      { kind: "include", name: "Board", match: { labels: [{ id: "L1", name: "Board" }] }, private: true },
    ];
    const [acme, pat] = parseSuggestions(rows);
    expect(ruleCovering(rules, acme!)?.name).toBe("Acme");
    expect(ruleCovering(rules, pat!)?.name).toBe("Pat");
    expect(ruleCovering(rules, { ...acme!, value: "sales.acme.example" })?.name).toBe("Acme");
    expect(ruleCovering(rules, { ...pat!, value: "bob@sales.acme.example" })?.name).toBe("Acme");
    expect(ruleCovering(rules, { ...acme!, value: "notacme.example" })).toBeNull();
    expect(ruleCovering(rules, { ...acme!, value: "example" })).toBeNull();
  });

  it("gives the age in whole days, or null without a date", () => {
    const now = new Date("2026-12-25T12:00:00Z");
    expect(ageDays("2026-11-20T10:00:00Z", now)).toBe(35);
    expect(ageDays(null, now)).toBeNull();
    expect(ageDays("nonsense", now)).toBeNull();
  });
});
