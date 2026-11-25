import { describe, expect, it, vi } from "vitest";
import { accountMatch, accountPeople, dropAccountPages } from "../../src/curator/accounts.js";
import { curateItem, type CurateDeps } from "../../src/curator/curate.js";
import { cutPlan, factCheck, parseUnsupported, sentencesOf, withoutSentences } from "../../src/curator/factcheck.js";
import type { ModelBackend } from "../../src/curator/model.js";
import { checkReply, type Plan, type PlannedNewPage } from "../../src/curator/output.js";
import { RULES, buildWriterPrompt } from "../../src/curator/prompt.js";
import { repairPatches } from "../../src/curator/repair.js";
import { sameAsExisting } from "../../src/curator/similar.js";
import { accountsOf } from "../../src/eval/ab-args.js";
import { entitySchema } from "../../src/entities/templates.js";
import { fakeStore, item, page } from "./fixtures.js";

/**
 * Curator round 4 (blind A/B, 2026-11-22): update first, no owner page, no
 * duplicate project pages, events in the page's own section, links between
 * new pages of one reply, and a fact check. Fiction only: a made-up bakery.
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-22T12:00:00Z");
const WRITER = "anthropic-claude-sonnet-5.5";
const TRIAGE = "openai-gpt-oss-120b";

function replying(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) {
    complete.mockResolvedValueOnce({ text: typeof r === "string" ? r : JSON.stringify(r), finish: "stop", inputTokens: 100, outputTokens: 20 });
  }
  return { complete };
}

const ACCOUNT = page({
  key: "acme-bakery.example.com",
  drawer: "organisations",
  title: "Acme Bakery",
  body: "# Acme Bakery\n\n## Summary\nA wholesale bakery.\n\n## Key Interactions\n- 2026-10-01: first call.\n\n## Notes\n- Pays on net 30.\n",
});

const CARE_PLAN = page({
  key: "concept:oven-care-plan",
  drawer: "concepts",
  title: "Oven Care Plan",
  aliases: ["Acme Phase 4"],
  body: "# Oven Care Plan\n\n## Summary\nA monthly support retainer.\n\n## Key Interactions\n- 2026-10-30: retainer first discussed.\n",
});

const PHASE3 = page({
  key: "project:acme-phase-3",
  title: "Acme Phase 3",
  body: "# Acme Phase 3\n\n## Summary\nDelivery routing.\n\n## Timeline\n- 2026-09-01: started.\n",
});

const newPage = (over: Partial<PlannedNewPage> & Pick<PlannedNewPage, "key" | "title" | "drawer">): PlannedNewPage => ({
  description: "", fields: {}, related: [], sections: [{ heading: "Summary", text: "2026-11-19: x." }], ...over,
});

describe("1 and 3: update first, and no duplicate project pages", () => {
  const pages = [ACCOUNT, CARE_PLAN, PHASE3];

  it("matches a create to a page with the same name, or one whose title shares almost every word", () => {
    expect(sameAsExisting(newPage({ drawer: "projects", key: "project:acme-phase-three", title: "Acme Phase 3" }), pages, schema))
      .toEqual({ key: PHASE3.key, how: "name" });
    const long = page({ key: "project:acme-van-routing", title: "Acme Bakery Van Routing Phase 3", body: "# x\n" });
    expect(sameAsExisting(newPage({ drawer: "projects", key: "project:x", title: "Acme Bakery Van Routing Phase 3 work" }), [...pages, long], schema))
      .toEqual({ key: long.key, how: "words" });
  });

  it("never files a later phase on an earlier one (numbers differ)", () => {
    expect(sameAsExisting(newPage({ drawer: "projects", key: "project:acme-phase-5", title: "Acme Phase 5" }), pages, schema)).toBeNull();
  });

  it("files a project on a page in another drawer that already has its name as an alias", () => {
    expect(sameAsExisting(newPage({ drawer: "projects", key: "project:acme-phase-4", title: "Acme Phase 4" }), pages, schema))
      .toEqual({ key: CARE_PLAN.key, how: "alias" });
  });

  it("leaves a really new page alone, and never cross-matches people", () => {
    expect(sameAsExisting(newPage({ drawer: "projects", key: "project:freezer-audit", title: "Freezer audit" }), pages, schema)).toBeNull();
    expect(sameAsExisting(newPage({ drawer: "people", key: "person:oven-care-plan", title: "Oven Care Plan" }), pages, schema)).toBeNull();
  });

  it("curateItem: a duplicate project create becomes a patch on the existing page, nothing new is made", async () => {
    const f = fakeStore(pages);
    const writer = replying({
      updates: [],
      new_pages: [{ drawer: "projects", key: "project:acme-phase-4", title: "Acme Phase 4", description: "retainer",
        fields: {}, related: [], sections: [{ heading: "Summary", text: "2026-11-19: Dana agreed the retainer starts in December." }] }],
      notes: "",
    });
    const deps: CurateDeps = { store: f.store, model: writer, modelName: WRITER, schema, now: NOW, writer: {} };
    const r = await curateItem(item({ body: "Dana agreed the retainer starts in December." }), deps);
    expect(r.outcome).toBe("applied");
    expect(f.saves.map((s) => [s.page["key"], s.hash === null])).toEqual([[CARE_PLAN.key, false]]);
    const body = String(f.saves[0]!.page["body"]);
    expect(body).toContain("retainer starts in December");
    expect(body).not.toMatch(/## Summary\n[\s\S]*## Summary/);
  });

  it("the writer is told to update first, with the shortlist marked as pages to update", () => {
    expect(RULES).toMatch(/Update first/);
    const prompt = buildWriterPrompt({ item: item(), pages: [ACCOUNT], index: [], schema, source: "x", excerpted: false });
    expect(prompt).toMatch(/SHORTLIST \(1 existing pages: update these first\)/);
  });
});

describe("1: an update to a page shown only in the index is not lost", () => {
  it("reads the page by key and applies the update", async () => {
    const f = fakeStore([ACCOUNT, PHASE3]);
    f.store.candidates.mockImplementation(async (_i: string, keys: readonly string[]) =>
      keys.length === 1 ? [ACCOUNT, PHASE3].filter((p) => p.key === keys[0]) : [ACCOUNT]);
    f.store.pageIndex.mockResolvedValue([{ key: PHASE3.key, drawer: "projects", title: PHASE3.title, aliases: [], description: null, identities: [], score: 1, matched_on: "search" }]);
    const triage = replying({ durable: true, reason: "x", summary: "", targets: [ACCOUNT.key], new_pages: [], excerpts: [] }, { unsupported: [] });
    const writer = replying({
      updates: [{ key: PHASE3.key, patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: Routing went live." }] }],
      new_pages: [], notes: "",
    });
    const deps: CurateDeps = { store: f.store, model: writer, modelName: WRITER, schema, now: NOW, writer: { triage: { model: triage, name: TRIAGE } } };
    const r = await curateItem(item({ body: "Routing went live." }), deps);
    expect(r.outcome).toBe("applied");
    expect(f.saves.map((s) => s.page["key"])).toEqual([PHASE3.key]);
    expect(r.routing).toMatch(/1 index pages read/);
  });
});

describe("2: no person page for the owner or an account user", () => {
  const people = [{ email: "boss@example.com", name: "Avery Boss" }];

  it("knows people by key, address or whole name, never a first name alone", () => {
    expect(accountMatch({ key: "boss@example.com", title: "Avery" }, people)).not.toBeNull();
    expect(accountMatch({ key: "person:avery-boss", title: "Avery Boss" }, people)).not.toBeNull();
    expect(accountMatch({ key: "person:avery", title: "Avery" }, people)).toBeNull();
    expect(accountMatch({ key: "person:avery-boss-senior-baker-at-acme", title: "x" }, people)).toBeNull();
  });

  it("always counts the item's owner, once", () => {
    expect(accountPeople(people, "owner@example.com")).toEqual([...people, { email: "owner@example.com", name: null }]);
    expect(accountPeople(people, "BOSS@example.com")).toEqual(people);
  });

  it("drops the page and every link to it", () => {
    const plan: Plan = {
      updates: [{ key: ACCOUNT.key, patches: [], fields: {}, related: ["person:avery-boss"] }],
      newPages: [newPage({ drawer: "people", key: "person:avery-boss", title: "Avery Boss" })],
      notes: "",
    };
    const r = dropAccountPages(plan, people, schema);
    expect(r.plan.newPages).toEqual([]);
    expect(r.plan.updates[0]!.related).toEqual([]);
    expect(r.dropped[0]).toMatch(/owner or an account user/);
  });

  it("curateItem: owner pages from the database list and the item owner are never made; the writer is told who they are", async () => {
    const f = fakeStore([ACCOUNT]);
    const writer = replying({
      updates: [],
      new_pages: [
        { drawer: "people", key: "owner@example.com", title: "Owner", fields: {}, related: [], sections: [{ heading: "Summary", text: "2026-11-19: x." }] },
        { drawer: "people", key: "person:avery-boss", title: "Avery Boss", fields: {}, related: [], sections: [{ heading: "Summary", text: "2026-11-19: y." }] },
      ],
      notes: "",
    });
    const deps: CurateDeps = { store: f.store, model: writer, modelName: WRITER, schema, now: NOW, writer: {}, people };
    const r = await curateItem(item(), deps);
    expect(f.saves).toEqual([]);
    expect(r.dropped?.filter((d) => /account user/.test(d))).toHaveLength(2);
    expect(String(writer.complete.mock.calls[0]![1])).toMatch(/Account users[^\n]*\n- Avery Boss <boss@example.com>\n- <owner@example.com>/);
  });

  it("the harness takes account users as --account \"Name <email>\"", () => {
    expect(accountsOf(["--account", "Avery Boss <Boss@Example.com>", "--account", "x@example.com"]))
      .toEqual([{ name: "Avery Boss", email: "boss@example.com" }, { name: null, email: "x@example.com" }]);
  });
});

describe("4: dated events go in the page's own events section", () => {
  const drawer = schema.drawers.find((d) => d.id === "organisations");
  const rule = { sections: ["Key Interactions", "Timeline"], updatesHeading: "Major updates" };

  it("a patch to a missing Timeline lands in Key Interactions", () => {
    const r = repairPatches(ACCOUNT.body, [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: call." }], drawer, rule);
    expect(r.patches).toEqual([{ op: "append-bullet", section: "Key Interactions", text: "2026-11-19: call." }]);
    expect(r.body).not.toContain("## Timeline");
  });

  it("a new Timeline section becomes lines in Key Interactions", () => {
    const r = repairPatches(ACCOUNT.body, [{ op: "new-section-after", after: "Notes", heading: "Timeline", text: "- 2026-11-19: call." }], drawer, rule);
    expect(r.patches[0]).toMatchObject({ op: "append-bullet", section: "Key Interactions" });
    expect(r.body.match(/^## /gm)).toHaveLength(3);
  });

  it("never writes into the Engine's own updates heading", () => {
    const r = repairPatches(ACCOUNT.body, [{ op: "append-bullet", section: "Major updates", text: "2026-11-19: x." }], drawer, rule);
    expect(r.patches[0]).toMatchObject({ section: "Key Interactions" });
  });

  it("without an events section, an unknown section is refused alone; a template section is still added", () => {
    const bare = "# Acme\n\n## Summary\nA bakery.\n";
    const r = repairPatches(bare, [
      { op: "append-bullet", section: "Gossip", text: "2026-11-19: x." },
      { op: "append-bullet", section: "Timeline", text: "2026-11-19: call." },
    ], drawer, rule);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatch(/Gossip/);
    expect(r.body).toContain("## Timeline");
  });

  it("checkReply keeps the item when one op is refused", () => {
    const bare = page({ key: "acme.example.com", drawer: "organisations", title: "Acme", body: "# Acme\n\n## Summary\nA bakery.\n" });
    const r = checkReply(JSON.stringify({
      updates: [{ key: bare.key, patches: [
        { op: "new-section-after", after: "Summary", heading: "History", text: "2026-11-19: x." },
        { op: "append-paragraph", section: "Summary", text: "2026-11-19: Acme opened a second shop." },
      ] }],
      new_pages: [], notes: "",
    }), { shortlist: [bare], schema, sourceText: "Acme opened a second shop." });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.updates[0]!.patches).toHaveLength(1);
      expect(r.plan.dropped?.join(" ")).toMatch(/History/);
    }
  });
});

describe("5: links between new pages of the same reply are kept", () => {
  it("resolves drawer-prefixed and loosely written keys to the new pages", () => {
    const reply = {
      updates: [],
      new_pages: [
        { drawer: "people", key: "rob@ovenco.example.com", title: "Rob Oven", fields: {}, related: ["organisations:ovenco.example.com", "meetings:meeting:2026-11-19 Oven Setup"], sections: [{ heading: "Summary", text: "2026-11-19: x." }] },
        { drawer: "organisations", key: "ovenco.example.com", title: "OvenCo", fields: {}, related: ["people:rob@ovenco.example.com"], sections: [{ heading: "Summary", text: "2026-11-19: y." }] },
        { drawer: "meetings", key: "meeting:2026-11-19 Oven Setup", title: "Oven setup", fields: {}, related: ["People:Rob@OvenCo.example.com"], sections: [{ heading: "Summary", text: "2026-11-19: z." }] },
      ],
      notes: "",
    };
    const r = checkReply(JSON.stringify(reply), { shortlist: [], schema, sourceText: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const links = Object.fromEntries(r.plan.newPages.map((n) => [n.key, n.related]));
    expect(links["rob@ovenco.example.com"]).toEqual(["ovenco.example.com", "meeting:2026-11-19-oven-setup"]);
    expect(links["ovenco.example.com"]).toEqual(["rob@ovenco.example.com"]);
    expect(links["meeting:2026-11-19-oven-setup"]).toEqual(["rob@ovenco.example.com"]);
    expect((r.plan.dropped ?? []).filter((d) => /link to/.test(d))).toEqual([]);
  });

  it("still leaves out a link to a page outside the reply", () => {
    const r = checkReply(JSON.stringify({ updates: [], new_pages: [{ drawer: "organisations", key: "ovenco.example.com", title: "OvenCo", fields: {}, related: ["people:nobody@example.com"], sections: [{ heading: "Summary", text: "2026-11-19: y." }] }], notes: "" }), { shortlist: [], schema, sourceText: "x" });
    expect(r.ok && r.plan.dropped?.some((d) => /nobody/.test(d))).toBe(true);
  });
});

describe("6: fact check", () => {
  it("splits sentences under a leading date and keeps the date when the first is cut", () => {
    const text = "2026-11-19: Dana signed the order. She wants 40 ovens.";
    expect(sentencesOf(text)).toEqual(["Dana signed the order.", "She wants 40 ovens."]);
    expect(withoutSentences(text, new Set(["Dana signed the order."]))).toBe("2026-11-19: She wants 40 ovens.");
    expect(withoutSentences(text, new Set(sentencesOf(text)))).toBe("");
  });

  it("does not split on an initial or an abbreviation, and skips link-only sentences", async () => {
    expect(sentencesOf("2026-11-19: 45 W. Lee Flowers stores moved, e.g. Dr. Kay's. Then more.")).toEqual(["45 W. Lee Flowers stores moved, e.g. Dr. Kay's.", "Then more."]);
    const checker = replying({ unsupported: [] });
    const links: Plan = { updates: [{ key: ACCOUNT.key, fields: {}, related: [], patches: [{ op: "append-paragraph", section: "Notes", text: "See [[project:acme-phase-3]]." }] }], newPages: [], notes: "" };
    await factCheck(links, "x", { model: checker, name: TRIAGE }, "i");
    expect(checker.complete).not.toHaveBeenCalled();
  });

  it("reads only sentence numbers in range", () => {
    expect(parseUnsupported('{"unsupported":[2, 9, "1", 2]}', 3)).toEqual([2, 1]);
    expect(parseUnsupported("not json", 3)).toBeNull();
  });

  const plan: Plan = {
    updates: [{ key: ACCOUNT.key, fields: {}, related: [], patches: [
      { op: "append-bullet", section: "Key Interactions", text: "2026-11-19: Dana signed the order. She wants 40 ovens." },
      { op: "append-bullet", section: "Key Interactions", text: "2026-11-19: Acme bought the competitor." },
    ] }],
    newPages: [],
    notes: "",
  };

  it("cuts unsupported sentences, drops a patch left empty and lists each cut", async () => {
    const checker = replying({ unsupported: [2, 3] });
    const r = await factCheck(plan, "Dana signed the order.", { model: checker, name: TRIAGE }, "item-1");
    expect(r.plan.updates[0]!.patches).toEqual([{ op: "append-bullet", section: "Key Interactions", text: "2026-11-19: Dana signed the order." }]);
    expect(r.plan.dropped).toHaveLength(2);
    expect(r.plan.dropped![0]).toMatch(/fact check/);
    expect(r.usage[TRIAGE]?.calls).toBe(1);
  });

  it("leaves the plan as it was when the check fails or cannot be read", async () => {
    expect((await factCheck(plan, "x", { model: replying("nonsense"), name: TRIAGE }, "i")).plan).toBe(plan);
    const broken: ModelBackend = { complete: vi.fn().mockRejectedValue(new Error("down")) };
    expect((await factCheck(plan, "x", { model: broken, name: TRIAGE }, "i")).plan).toBe(plan);
  });

  it("drops a new page whose every sentence was cut", () => {
    const p: Plan = { updates: [], newPages: [newPage({ drawer: "projects", key: "project:x", title: "X", sections: [{ heading: "Summary", text: "2026-11-19: Made up." }] })], notes: "" };
    expect(cutPlan(p, new Set(["Made up."])).newPages).toEqual([]);
  });

  it("curateItem: the triage model checks the writer's sentences and the unsupported one is not saved", async () => {
    const f = fakeStore([ACCOUNT]);
    const triage = replying(
      { durable: true, reason: "order", summary: "Order signed.", targets: [ACCOUNT.key], new_pages: [], excerpts: [] },
      { unsupported: [2] },
    );
    const writer = replying({
      updates: [{ key: ACCOUNT.key, patches: [{ op: "append-bullet", section: "Key Interactions", text: "2026-11-19: Dana signed the order. Acme bought the competitor." }] }],
      new_pages: [], notes: "",
    });
    const deps: CurateDeps = { store: f.store, model: writer, modelName: WRITER, schema, now: NOW, writer: { triage: { model: triage, name: TRIAGE } } };
    const r = await curateItem(item({ body: "From: dana@acme-bakery.example.com\n\nDana signed the order." }), deps);
    expect(r.outcome).toBe("applied");
    const body = String(f.saves[0]!.page["body"]);
    expect(body).toContain("Dana signed the order.");
    expect(body).not.toContain("competitor");
    expect(r.routing).toMatch(/fact checked/);
    expect(triage.complete).toHaveBeenCalledTimes(2);
  });
});
