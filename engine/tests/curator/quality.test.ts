import { describe, expect, it, vi } from "vitest";
import { curateItem, type CurateDeps } from "../../src/curator/curate.js";
import type { ModelBackend } from "../../src/curator/model.js";
import { checkReply, keyProblem } from "../../src/curator/output.js";
import { buildPrompt } from "../../src/curator/prompt.js";
import { renderIndex, type IndexRow } from "../../src/curator/page-index.js";
import { durabilityFor, hasStrongKey, isJudgementDrawer, matchThreshold, needsStrong } from "../../src/curator/quality.js";
import { acceptedIdentities } from "../../src/curator/identity.js";
import { entitySchema, templateSchema } from "../../src/entities/templates.js";
import { fakeStore, item, page } from "./fixtures.js";

/**
 * Curator quality (2026-11-22): the durability filter, the page index, the
 * strong model where judgement matters, identities and name matching before
 * a create. Fiction only; no model is called.
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-22T12:00:00Z");
const drawer = (id: string) => schema.drawers.find((d) => d.id === id)!;

function backend(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 100, outputTokens: 20 });
  return { complete };
}

const PAT = page({
  key: "pat@northwind.example", drawer: "people", title: "Pat Rivera", fields: { organisation: "northwind.example" },
  body: "# Pat Rivera\n\n## Summary\nCOO of Northwind.\n\n## Timeline\n- 2026-11-01: first call.\n",
});
const DENSITY = page({
  key: "concept:route-density", drawer: "concepts", title: "Route Density", aliases: ["Stops per mile"],
  body: "# Route Density\n\n## Summary\nStops per mile.\n\n## How it works\n- Count stops.\n",
});

const conceptItem = item({
  id: "item-c", title: "Why stop density matters",
  body: "From: dana@northwind.example\nTo: owner@example.com\n\nWe measured stop clustering: dense routes cut fuel 18% in October. " +
    "We will plan all new routes by stops per mile from now on.",
});

const newConcept = {
  updates: [], notes: "",
  new_pages: [{
    drawer: "concepts", key: "concept:stop-clustering", title: "Stop Clustering", description: "Grouping stops on a route.",
    sections: [{ heading: "Summary", text: "2026-11-19: dense routes cut fuel 18% in October (Northwind measurement)." }],
  }],
};

function deps(over: Partial<CurateDeps> & { store: CurateDeps["store"] }): CurateDeps {
  return { model: backend(), modelName: "openai-gpt-oss-120b", schema, now: NOW, ...over };
}

describe("templates: curator rules live in YAML", () => {
  it("base sets the durability rule, the skip list and the thresholds", () => {
    expect(schema.rules?.durability.join(" ")).toMatch(/six months/);
    expect(schema.rules?.durability.join(" ")).toMatch(/Not derivable/);
    expect(schema.rules?.skip.join(" ")).toMatch(/Pleasantries/);
    expect(schema.rules?.matchThreshold).toBe(0.9);
    expect(schema.rules?.duplicateThreshold).toBe(0.92);
  });

  it("marks the judgement drawers, and routine drawers stay routine", () => {
    for (const id of ["concepts", "decisions", "research", "playbooks"]) expect(isJudgementDrawer(schema, id)).toBe(true);
    for (const id of ["people", "organisations", "meetings", "deals"]) expect(isJudgementDrawer(schema, id)).toBe(false);
  });

  it("a drawer may replace the durability rule and the match threshold", () => {
    const custom = {
      ...schema,
      drawers: schema.drawers.map((d) => d.id === "concepts"
        ? { ...d, curator: { ...d.curator, durability: ["An idea named twice"], match_threshold: 0.8 } } : d),
    };
    expect(durabilityFor(custom, "concepts")).toEqual(["An idea named twice"]);
    expect(durabilityFor(custom, "people")).toEqual(schema.rules?.durability);
    expect(matchThreshold(custom, "concepts")).toBe(0.8);
    expect(matchThreshold(custom, "people")).toBe(0.9);
  });

  it("refuses identities or a fallback on a slug key, and a threshold out of range", () => {
    const base = { name: "x", label: "X", description: "x" };
    const d = { id: "things", label: "T", fields: [], sections: ["S"], signals: [], update_rules: { auto: [], needs_yes: [] }, list_views: [] };
    expect(templateSchema.safeParse({ ...base, drawers: [{ ...d, key_rule: { kind: "slug", text: "thing: x", fallback: "t" } }] }).success).toBe(false);
    expect(templateSchema.safeParse({ ...base, drawers: [{ ...d, key_rule: { kind: "email", text: "e", identities: "emails", fallback: "person" } }] }).success).toBe(true);
    expect(templateSchema.safeParse({ ...base, curator: { match_threshold: 0.2 }, drawers: [] }).success).toBe(false);
  });
});

describe("keys: a person or organisation without an address", () => {
  it("accepts person:<name> and org:<name> as fallback keys", () => {
    expect(keyProblem(drawer("people"), "person:pat-rivera")).toBeNull();
    expect(keyProblem(drawer("organisations"), "org:northwind")).toBeNull();
    expect(keyProblem(drawer("people"), "concept:pat")).not.toBeNull();
    expect(hasStrongKey(drawer("people"), "pat@northwind.example")).toBe(true);
    expect(hasStrongKey(drawer("people"), "person:pat-rivera")).toBe(false);
    expect(hasStrongKey(drawer("concepts"), "concept:x")).toBe(false);
    expect(hasStrongKey(drawer("meetings"), "meeting:abc")).toBe(true);
  });
});

describe("1. durability filter", () => {
  it("puts the YAML rule text and the no-change answer in the prompt", () => {
    const prompt = buildPrompt(conceptItem, [], schema, "0123456789abcdef");
    expect(prompt).toMatch(/DURABLE FACTS ONLY/);
    expect(prompt).toContain("Durable: still relevant six months from now");
    expect(prompt).toContain("Pleasantries, thanks, greetings and sign-offs");
    expect(prompt).toMatch(/no updates and no new pages.*valid answer/i);
    expect(prompt).toMatch(/people: key email \(or "person:<name>"/);
  });

  it("shows a drawer's own durability rule on its line", () => {
    const custom = { ...schema, drawers: schema.drawers.map((d) => d.id === "concepts" ? { ...d, curator: { ...d.curator, durability: ["An idea named twice"] } } : d) };
    expect(buildPrompt(conceptItem, [], custom, "0123456789abcdef")).toMatch(/- concepts: .*durable here: An idea named twice/);
  });

  it("an item with nothing durable is 'no change': counted, not failed", async () => {
    const f = fakeStore([PAT]);
    const r = await curateItem(item({ title: "Thanks!", body: "From: pat@northwind.example\n\nThanks, see you Tuesday." }),
      deps({ store: f.store, model: backend({ updates: [], new_pages: [], notes: "nothing durable: a thank-you" }) }));
    expect(r.outcome).toBe("no_change");
    expect(r.reason).toMatch(/nothing durable/);
    expect(f.done).toEqual([{ itemId: "item-1", outcome: "no_change", pages: [], error: undefined }]);
    expect(f.saves).toHaveLength(0);
  });
});

describe("2. page index context", () => {
  const rows: IndexRow[] = [
    { key: "pat@northwind.example", drawer: "people", title: "Pat Rivera", aliases: [], description: "COO", identities: ["pat.r@gmail.example"], score: 2, matched_on: "key" },
    { key: "concept:route-density", drawer: "concepts", title: "Route Density", aliases: ["Stops per mile"], description: "How tightly stops cluster.", identities: [], score: 0.8, matched_on: "similar" },
    ...Array.from({ length: 200 }, (_, i) => ({
      key: `concept:filler-${i}`, drawer: "concepts", title: `Filler ${i}`, aliases: [], description: "x".repeat(80), identities: [], score: 0.1, matched_on: "recent",
    })),
  ];

  it("renders one line per page (key, drawer, title, aliases, description) within the token budget", () => {
    const text = renderIndex(rows, [], 300);
    expect(text).toContain("- concept:route-density | concepts | Route Density | aka Stops per mile | How tightly stops cluster.");
    expect(text).toContain("aka pat.r@gmail.example");
    expect(text.length / 4).toBeLessThanOrEqual(300);
    expect(text).toMatch(/more pages not shown/);
  });

  it("always keeps key matches, even past the budget, and leaves out shortlist pages", () => {
    const text = renderIndex(rows, ["concept:route-density"], 1);
    expect(text).toContain("pat@northwind.example");
    expect(text).not.toContain("concept:route-density |");
  });

  it("is in the prompt, and the curator reads it ranked by key, words and embedding", async () => {
    const f = fakeStore([PAT]);
    f.store.pageIndex.mockResolvedValue(rows.slice(0, 2));
    const embed = vi.fn().mockResolvedValue(Array(384).fill(0.1));
    const model = backend({ updates: [], new_pages: [], notes: "nothing durable" });
    await curateItem(conceptItem, deps({ store: f.store, model, embed }));
    expect(f.store.pageIndex).toHaveBeenCalledWith("item-c", expect.arrayContaining(["dana@northwind.example"]), expect.any(String), expect.any(Array), expect.any(Number));
    const prompt = String(model.complete.mock.calls[0]![1]);
    expect(prompt).toMatch(/PAGE INDEX/);
    expect(prompt).toContain("concept:route-density | concepts | Route Density");
  });

  it("works without embeddings (keyword only) when the embed call fails", async () => {
    const f = fakeStore([PAT]);
    const embed = vi.fn().mockRejectedValue(new Error("down"));
    await curateItem(conceptItem, deps({ store: f.store, model: backend({ updates: [], new_pages: [] }), embed }));
    expect(f.store.pageIndex).toHaveBeenCalledWith("item-c", expect.any(Array), expect.any(String), null, expect.any(Number));
  });

  it("a link to an index page is allowed", () => {
    const reply = { updates: [], new_pages: [{ ...newConcept.new_pages[0]!, related: ["concept:route-density"] }] };
    expect(checkReply(JSON.stringify(reply), { shortlist: [], schema, sourceText: conceptItem.body, indexKeys: ["concept:route-density"] }).ok).toBe(true);
    const without = checkReply(JSON.stringify(reply), { shortlist: [], schema, sourceText: conceptItem.body });
    expect(without.ok && without.plan.newPages[0]?.related).toEqual([]);
    if (without.ok) expect(without.plan.dropped?.join(" ")).toMatch(/concept:route-density/);
  });
});

describe("3. model routing", () => {
  it("needsStrong: new pages in judgement drawers and uncertain consensus; routine work is not", () => {
    const plan = (drawer: string) => ({ updates: [], newPages: [{ drawer } as never], notes: "" });
    expect(needsStrong(plan("concepts"), "agreed", schema)).toMatch(/concepts/);
    expect(needsStrong(plan("people"), "agreed", schema)).toBeNull();
    expect(needsStrong({ updates: [], newPages: [], notes: "" }, "uncertain", schema)).toMatch(/uncertain/);
    expect(needsStrong({ updates: [], newPages: [], notes: "" }, "single", schema)).toBeNull();
  });

  it("a new concept page is decided by the strong model, and written as its work", async () => {
    const f = fakeStore([]);
    const primary = backend(newConcept);
    const strong = backend({ ...newConcept, new_pages: [{ ...newConcept.new_pages[0]!, title: "Stop Clustering (strong)" }] });
    const r = await curateItem(conceptItem, deps({ store: f.store, model: primary, strong: { model: strong, name: "deepseek-v4.1-flash" } }));
    expect(r.reason).toBeUndefined();
    expect(strong.complete).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("applied");
    expect(f.saves[0]!.page["title"]).toBe("Stop Clustering (strong)");
    expect(f.saves[0]!.page["generated"]).toMatchObject({ model: "deepseek-v4.1-flash" });
    expect(r.escalated).toBe(true);
  });

  it("a routine person update stays on the primary model", async () => {
    const f = fakeStore([PAT]);
    const reply = { updates: [{ key: PAT.key, patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: Pat confirmed the 6-week pilot." }] }], new_pages: [] };
    const strong = backend();
    const r = await curateItem(item({ body: "From: pat@northwind.example\n\nConfirmed the 6-week pilot." }),
      deps({ store: f.store, model: backend(reply), strong: { model: strong, name: "deepseek-v4.1-flash" } }));
    expect(strong.complete).not.toHaveBeenCalled();
    expect(r.outcome).toBe("applied");
    expect(r.escalated).toBeFalsy();
  });

  it("when the strong model fails, the primary plan is kept", async () => {
    const f = fakeStore([]);
    const strong = { complete: vi.fn().mockRejectedValue(new Error("HTTP 500")) };
    const r = await curateItem(conceptItem, deps({ store: f.store, model: backend(newConcept), strong: { model: strong, name: "deepseek-v4.1-flash" } }));
    expect(r.outcome).toBe("applied");
    expect(f.saves[0]!.page["title"]).toBe("Stop Clustering");
  });

  it("an uncertain consensus goes to the strong model, and nothing is recorded as uncertain when it answers", async () => {
    const f = fakeStore([PAT]);
    const u = (text: string, date?: string) => ({
      updates: [{ key: PAT.key, patches: [{ op: "append-bullet", section: "Timeline", text: `2026-11-19: ${text}` }], ...(date ? { fields: { next_date: date } } : {}) }],
      new_pages: [],
    });
    const primary = backend(u("Pat leads the pilot.", "2026-11-25"), u("Pat leads the pilot.", "2026-11-26"));
    const tiebreak = backend(u("Pat leads the pilot.", "2026-11-27"));
    const strong = backend(u("Pat leads the pilot.", "2026-11-25"));
    const r = await curateItem(item({ body: "From: pat@northwind.example\n\nI lead the pilot; next check-in 2026-11-25." }), deps({
      store: f.store, model: primary,
      consensus: { tiebreak, tiebreakName: "deepseek-v4.1-flash" },
      strong: { model: strong, name: "deepseek-v4-pro" },
    }));
    expect(strong.complete).toHaveBeenCalledTimes(1);
    expect(f.uncertain).toHaveLength(0);
    expect(f.saves[0]!.page["fields"]).toMatchObject({ next_date: "2026-11-25" });
    expect(r.escalated).toBe(true);
  });
});

describe("4b. identities", () => {
  const source = "From: pat.rivera@northwind.example\n\nPat Rivera here, writing from my other Northwind address.";

  it("accepts an address with the same name and organisation, and refuses the rest", () => {
    const got = acceptedIdentities(["pat.rivera@northwind.example", "pat@other.example", "nobody@northwind.example", "PAT@northwind.example"], PAT, drawer("people"), source);
    expect(got.add).toEqual(["pat.rivera@northwind.example"]);
    expect(got.refused.map((r) => r.value)).toEqual(["pat@other.example", "nobody@northwind.example", "pat@northwind.example"]);
  });

  it("refuses when the page's name is not in the item", () => {
    expect(acceptedIdentities(["pat.rivera@northwind.example"], PAT, drawer("people"), "From: pat.rivera@northwind.example\n\nhello").add).toEqual([]);
  });

  it("refuses on a drawer without identities", () => {
    expect(acceptedIdentities(["x@y.example"], DENSITY, drawer("concepts"), "x@y.example Route Density").add).toEqual([]);
  });

  it("an organisation may gain a domain named in the item with its name", () => {
    const org = page({ key: "northwind.example", drawer: "organisations", title: "Northwind", body: "# Northwind\n" });
    expect(acceptedIdentities(["northwind-logistics.example"], org, drawer("organisations"),
      "Northwind moved its mail to northwind-logistics.example").add).toEqual(["northwind-logistics.example"]);
  });

  it("a curator update adds the accepted address to the page's emails list (never a merge)", async () => {
    const f = fakeStore([PAT]);
    const reply = {
      updates: [{ key: PAT.key, identities: ["pat.rivera@northwind.example"],
        patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: Pat Rivera wrote from a second Northwind address." }] }],
      new_pages: [],
    };
    await curateItem(item({ body: source }), deps({ store: f.store, model: backend(reply) }));
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]!.page["fields"]).toMatchObject({ organisation: "northwind.example", emails: ["pat.rivera@northwind.example"] });
  });
});

describe("4c. name match before create", () => {
  it("a new page close to an existing one in the drawer becomes an update, with the new name as alias", async () => {
    const f = fakeStore([DENSITY]);
    f.store.candidates.mockImplementation(async (_i: string, keys: readonly string[]) => [DENSITY].filter((p) => keys.includes(p.key)));
    f.store.nameMatch.mockResolvedValue([{ id: DENSITY.id, key: DENSITY.key, title: DENSITY.title, score: 0.95, how: "embedding" }]);
    const embed = vi.fn().mockResolvedValue(Array(384).fill(0.1));
    const r = await curateItem(conceptItem, deps({ store: f.store, model: backend(newConcept), embed }));
    expect(f.store.nameMatch).toHaveBeenCalledWith("item-c", "concepts", expect.arrayContaining(["Stop Clustering"]), expect.any(Array));
    expect(r.outcome).toBe("applied");
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]!.page["key"]).toBe(DENSITY.key);
    expect(f.saves[0]!.hash).toBe(DENSITY.content_hash);
    expect(f.saves[0]!.page["aliases"]).toEqual(["Stops per mile", "Stop Clustering"]);
    expect(String(f.saves[0]!.page["body"])).toContain("dense routes cut fuel 18%");
  });

  it("an anchored drawer (one deal per organisation) is never matched by name", async () => {
    const f = fakeStore([]);
    f.store.nameMatch.mockResolvedValue([{ id: "x", key: "deal:northwind.example-old", title: "Pilot", score: 1, how: "name" }]);
    const deal = { updates: [], new_pages: [{ drawer: "deals", key: "deal:northwind.example-pilot", title: "Pilot",
      fields: { organisation: "northwind.example", stage: "lead", value: 12000 },
      sections: [{ heading: "Summary", text: "2026-11-19: Northwind asked for a $12,000 pilot quote." }] }] };
    await curateItem(item({ body: "From: dana@northwind.example\n\nCould you quote the $12,000 pilot?" }), deps({ store: f.store, model: backend(deal) }));
    expect(f.store.nameMatch).not.toHaveBeenCalled();
    expect(f.saves[0]!.page["key"]).toBe("deal:northwind.example-pilot");
  });

  it("below the drawer's threshold, the page is created", async () => {
    const f = fakeStore([DENSITY]);
    f.store.nameMatch.mockResolvedValue([{ id: DENSITY.id, key: DENSITY.key, title: DENSITY.title, score: 0.7, how: "embedding" }]);
    await curateItem(conceptItem, deps({ store: f.store, model: backend(newConcept) }));
    expect(f.saves[0]!.page["key"]).toBe("concept:stop-clustering");
    expect(f.saves[0]!.hash).toBeNull();
  });

  it("a person without an address (person:<name>) is matched by name; one with an address is not", async () => {
    const f = fakeStore([PAT]);
    f.store.candidates.mockImplementation(async (_i: string, keys: readonly string[]) => [PAT].filter((p) => keys.includes(p.key)));
    f.store.nameMatch.mockResolvedValue([{ id: PAT.id, key: PAT.key, title: PAT.title, score: 1, how: "name" }]);
    const person = (key: string) => ({ updates: [], new_pages: [{ drawer: "people", key, title: "Pat Rivera",
      sections: [{ heading: "Timeline", text: "- 2026-11-19: Pat Rivera agreed to lead the pilot." }] }] });
    const body = "Meeting notes: Pat Rivera agreed to lead the pilot.";
    await curateItem(item({ body }), deps({ store: f.store, model: backend(person("person:pat-rivera")) }));
    expect(f.saves[0]!.page["key"]).toBe(PAT.key);
    f.store.nameMatch.mockClear();
    await curateItem(item({ id: "item-2", body: `From: p2@northwind.example\n\n${body}` }), deps({ store: f.store, model: backend(person("p2@northwind.example")) }));
    expect(f.store.nameMatch).not.toHaveBeenCalled();
  });
});
