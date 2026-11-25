import { describe, expect, it, vi } from "vitest";
import { curateItem, type CurateDeps } from "../../src/curator/curate.js";
import { agree, agreement, decisionsOf } from "../../src/curator/consensus.js";
import { doInference, outputLimit, type ModelBackend } from "../../src/curator/model.js";
import { checkReply, normaliseNewKey } from "../../src/curator/output.js";
import { buildPrompt } from "../../src/curator/prompt.js";
import { needsStrong, strongRouting } from "../../src/curator/quality.js";
import { repairPatches } from "../../src/curator/repair.js";
import { abStats, parseAbArgs } from "../../src/eval/ab-args.js";
import { entitySchema } from "../../src/entities/templates.js";
import { fakeStore, item, page } from "./fixtures.js";

/**
 * Round 1 of the live blind A/B (2026-11-21), reproduced with fiction only:
 * imported pages with their own headings, a key the model wrote in capitals,
 * two runs that said the same thing differently, a reply cut off at the
 * output limit, routing to the strong model, and the harness flags.
 * No model is called.
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-21T12:00:00Z");
const drawer = (id: string) => schema.drawers.find((d) => d.id === id)!;

type Reply = { text: string; finish: string; inputTokens: number; outputTokens: number };
const stop = (r: unknown): Reply => ({ text: JSON.stringify(r), finish: "stop", inputTokens: 100, outputTokens: 20 });
const cut = (): Reply => ({ text: '{"updates":[{"key":"x', finish: "length", inputTokens: 100, outputTokens: 4096 });

function backend(...replies: Reply[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce(r);
  return { complete };
}

function deps(over: Partial<CurateDeps> & { store: CurateDeps["store"] }): CurateDeps {
  return { model: backend(), modelName: "openai-gpt-oss-120b", schema, now: NOW, ...over };
}

// An imported wiki page: its own headings, none of the template's.
const IMPORTED_PROJECT = page({
  key: "project:harbor-rollout", drawer: "projects", title: "Harbor Rollout",
  body: "# Harbor Rollout\n\n## Phase Structure\nThree phases.\n\n## Open Items\n- tablets\n\n## Meetings\n- 2026-11-01: kickoff\n",
});
const IMPORTED_PERSON = page({
  key: "dana@harbor.example", drawer: "people", title: "Dana Whitlock",
  body: "# Dana Whitlock\n\n## Summary\nOps lead.\n\n## Role & Context\nRuns dispatch.\n\n## Meetings\n- 2026-11-01: kickoff\n",
});

const meeting = item({
  id: "item-m", source: "fireflies", source_id: "01MEETINGFAKE", metadata: { meeting_id: "01MEETINGFAKE" },
  title: "Harbor build session (2026-11-19)",
  body: "Participants: dana@harbor.example, owner@example.com\n\nDana said phase two starts 2026-12-01.",
});

const bullet = (section: string, text = "2026-11-19: Dana said phase two starts 2026-12-01.") =>
  ({ op: "append-bullet", section, text });

describe("1. a patch to a section the page does not have", () => {
  it("becomes a new section after the page's last section", () => {
    const r = repairPatches(IMPORTED_PROJECT.body, [bullet("Timeline")], drawer("projects"));
    expect(r.dropped).toEqual([]);
    expect(r.patches[0]).toMatchObject({ op: "new-section-after", after: "Meetings", heading: "Timeline" });
    expect(r.body).toMatch(/## Meetings\n- 2026-11-01: kickoff\n\n## Timeline\n- 2026-11-19: Dana said/);
  });

  it("goes after the template's nearest earlier section when the page has one", () => {
    // people: Summary | Contact | Working with them | Timeline | Notes
    const r = repairPatches(IMPORTED_PERSON.body, [bullet("Contact", "2026-11-19: new desk phone.")], drawer("people"));
    expect(r.patches[0]).toMatchObject({ op: "new-section-after", after: "Summary", heading: "Contact" });
    expect(r.body.indexOf("## Contact")).toBeLessThan(r.body.indexOf("## Role & Context"));
  });

  it("two patches to the same missing section make one section", () => {
    const r = repairPatches(IMPORTED_PROJECT.body, [bullet("Notes", "2026-11-19: one."), bullet("Notes", "2026-11-19: two.")], drawer("projects"));
    expect(r.body.match(/## Notes/g)).toHaveLength(1);
    expect(r.body).toContain("- 2026-11-19: one.\n- 2026-11-19: two.");
  });

  it("drops only a patch that cannot be repaired, and says why", () => {
    const bad = { op: "replace-line", section: "Open Items", old: "- not on the page", new: "- 2026-11-19: x" };
    const r = repairPatches(IMPORTED_PROJECT.body, [bad, bullet("Open Items")], drawer("projects"));
    expect(r.patches).toHaveLength(1);
    expect(r.dropped[0]).toMatch(/not found/);
  });

  it("the prompt lists each shortlist page's actual headings", () => {
    const p = buildPrompt(meeting, [IMPORTED_PROJECT], schema, "abcdef12");
    expect(p).toContain("Sections: Phase Structure | Open Items | Meetings");
  });

  it("one bad update never drops the whole reply", () => {
    const reply = {
      updates: [
        { key: IMPORTED_PROJECT.key, patches: [bullet("Timeline")] },
        { key: "project:not-shown", patches: [bullet("Notes")] },
      ],
      new_pages: [],
    };
    const r = checkReply(JSON.stringify(reply), { shortlist: [IMPORTED_PROJECT], schema, sourceText: meeting.body });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.updates.map((u) => u.key)).toEqual([IMPORTED_PROJECT.key]);
    expect(r.plan.dropped?.join(" ")).toMatch(/project:not-shown.*not on the shortlist/);
  });

  it("the meeting is filed (not failed) and the reason for each repair is kept", async () => {
    const f = fakeStore([IMPORTED_PROJECT, IMPORTED_PERSON]);
    const reply = { updates: [{ key: IMPORTED_PROJECT.key, patches: [bullet("Timeline"), bullet("Notes", "undated, dropped")] }], new_pages: [] };
    const r = await curateItem(meeting, deps({ store: f.store, model: backend(stop(reply)) }));
    expect(r.outcome).toBe("applied");
    expect(String(f.saves[0]!.page["body"])).toContain("## Timeline\n- 2026-11-19: Dana said");
    expect(r.dropped?.join(" ")).toMatch(/date/);
  });
});

describe("2. a new page key the model wrote loosely", () => {
  it("is normalised: lower case, no spaces, a slug after the prefix", () => {
    expect(normaliseNewKey(drawer("people"), " Riley.Moss@Harbor.Example ")).toBe("riley.moss@harbor.example");
    expect(normaliseNewKey(drawer("people"), "person:Riley Moss")).toBe("person:riley-moss");
    expect(normaliseNewKey(drawer("deals"), "deal:Harbor.example Price List")).toBe("deal:harbor.example-price-list");
    expect(normaliseNewKey(drawer("organisations"), "WWW.Harbor.Example")).toBe("harbor.example");
  });

  it("a key in capitals no longer fails the item (the exact rule: 'a key is lower case with no spaces')", () => {
    const reply = { updates: [], new_pages: [{ drawer: "people", key: "person:Riley Moss", title: "Riley Moss", sections: [] }] };
    const r = checkReply(JSON.stringify(reply), { shortlist: [], schema, sourceText: "Riley Moss" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.newPages[0]!.key).toBe("person:riley-moss");
  });

  it("a bare name is mapped to the page that already has that name or alias", () => {
    const index = [{ key: "riley@harbor.example", drawer: "people", title: "Riley Moss", aliases: ["R. Moss"], description: null, identities: [], score: 1, matched_on: "search" }];
    const reply = { updates: [], new_pages: [{ drawer: "people", key: "R. Moss", title: "Riley Moss", sections: [] }] };
    const r = checkReply(JSON.stringify(reply), { shortlist: [], schema, sourceText: "x", index, indexKeys: index.map((i) => i.key) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.newPages[0]!.key).toBe("riley@harbor.example");
  });

  it("a key that still breaks the rule drops that page only, with the reason", () => {
    const reply = {
      updates: [{ key: IMPORTED_PERSON.key, patches: [bullet("Summary", "2026-11-19: Dana confirmed.")] }],
      new_pages: [{ drawer: "deals", key: "Price List", title: "Price list", sections: [] }],
    };
    const r = checkReply(JSON.stringify(reply), { shortlist: [IMPORTED_PERSON], schema, sourceText: "Dana confirmed." });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.dropped?.join(" ")).toMatch(/Price List.*deal:/);
  });
});

describe("3. consensus compares decisions, not wording", () => {
  const ctx = { schema, shortlist: [IMPORTED_PERSON, IMPORTED_PROJECT] };
  const up = (key: string, fields: Record<string, string | number> = {}, text = "2026-11-19: x") =>
    ({ key, patches: [{ op: "append-bullet" as const, section: "Meetings", text }], fields, related: [] });
  const plan = (updates: ReturnType<typeof up>[], newPages: unknown[] = []) => ({ updates, newPages, notes: "" }) as never;

  it("two runs with the same pages in another order, other wording and a key in capitals agree", () => {
    const a = plan([up(IMPORTED_PERSON.key, {}, "2026-11-19: Dana said A."), up(IMPORTED_PROJECT.key)]);
    const b = plan([up(IMPORTED_PROJECT.key.toUpperCase()), up(IMPORTED_PERSON.key, {}, "2026-11-19: Dana told us A.")]);
    expect(agree(decisionsOf(a, ctx), decisionsOf(b, ctx))).toBe(true);
    expect(agreement(decisionsOf(a, ctx), decisionsOf(b, ctx))).toBe(1);
  });

  it("a field only one run set does not break agreement; a different value does", () => {
    const a = plan([up(IMPORTED_PROJECT.key, { status: "active" })]);
    const b = plan([up(IMPORTED_PROJECT.key)]);
    const c = plan([up(IMPORTED_PROJECT.key, { status: "paused" })]);
    expect(agree(decisionsOf(a, ctx), decisionsOf(b, ctx))).toBe(true);
    expect(agree(decisionsOf(a, ctx), decisionsOf(c, ctx))).toBe(false);
    expect(agreement(decisionsOf(a, ctx), decisionsOf(c, ctx))).toBe(0.5);
  });

  it("agreement is 0 when the runs share no decision", () => {
    expect(agreement(decisionsOf(plan([up(IMPORTED_PROJECT.key)]), ctx), decisionsOf(plan([up(IMPORTED_PERSON.key)]), ctx))).toBe(0);
  });

  it("the item result carries the agreement", async () => {
    const f = fakeStore([IMPORTED_PROJECT]);
    const reply = (t: string) => ({ updates: [{ key: IMPORTED_PROJECT.key, patches: [bullet("Meetings", `2026-11-19: ${t}`)] }], new_pages: [] });
    const r = await curateItem(meeting, deps({
      store: f.store, model: backend(stop(reply("Dana said phase two starts 2026-12-01.")), stop(reply("Phase two starts 2026-12-01, per Dana."))),
      consensus: { tiebreak: backend(), tiebreakName: "tb" },
    }));
    expect(r.consensus).toBe("agreed");
    expect(r.agreement).toBe(1);
  });
});

describe("4. output limits per model, and a cut-off reply", () => {
  it("reasoning models get 16k, gpt-oss its 4k, and settings may override", () => {
    expect(outputLimit("deepseek-v4.1-flash")).toBe(16384);
    expect(outputLimit("deepseek-v4-pro")).toBe(16384);
    expect(outputLimit("openai-gpt-oss-120b")).toBe(4096);
    expect(outputLimit("some-new-model")).toBe(4096);
    expect(outputLimit("deepseek-v4.1-flash", { "deepseek-v4.1-flash": 32000 })).toBe(32000);
  });

  it("the request asks for the model's own limit", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await doInference("deepseek-v4.1-flash", "k").complete("s", "u");
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).max_tokens).toBe(16384);
      await doInference("deepseek-v4.1-flash", "k", { maxOutputTokens: 9000 }).complete("s", "u");
      expect(JSON.parse(fetchMock.mock.calls[1]![1].body).max_tokens).toBe(9000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("finish_reason=length is retried once with a higher limit, never parsed", async () => {
    const f = fakeStore([IMPORTED_PROJECT]);
    const good = { updates: [{ key: IMPORTED_PROJECT.key, patches: [bullet("Meetings")] }], new_pages: [] };
    const model = Object.assign(backend(cut(), stop(good)), { maxOutputTokens: 4096 });
    const r = await curateItem(meeting, deps({ store: f.store, model }));
    expect(r.outcome).toBe("applied");
    expect(model.complete.mock.calls[1]![2]).toBe(8192);
  });

  it("cut off twice: the run failed (a tiebreak cut off is not used)", async () => {
    const f = fakeStore([IMPORTED_PROJECT]);
    const r = await curateItem(meeting, deps({ store: f.store, model: backend(cut(), cut()) }));
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/cut off.*finish_reason=length/);
  });
});

describe("5. routing to the strong model", () => {
  const CONCEPT = page({ key: "concept:dense-routes", drawer: "concepts", title: "Dense routes", body: "# Dense routes\n\n## Summary\nx\n" });

  it("an update to a page in a judgement drawer escalates", () => {
    const p = { updates: [{ key: CONCEPT.key, patches: [], fields: {}, related: [] }], newPages: [], notes: "" };
    expect(needsStrong(p, "single", schema, { shortlist: [CONCEPT] })).toMatch(/concepts/);
  });

  it("low agreement between the consensus runs escalates", () => {
    const p = { updates: [], newPages: [], notes: "" };
    expect(needsStrong(p, "tiebreak", schema, { shortlist: [], agreement: 0.2 })).toMatch(/agreed on 20%/);
    expect(needsStrong(p, "tiebreak", schema, { shortlist: [], agreement: 0.9 })).toBeNull();
  });

  it("says why not, too", () => {
    const p = { updates: [], newPages: [], notes: "" };
    expect(strongRouting(p, "agreed", schema, { shortlist: [], agreement: 1 }, true).why).toBeNull();
    expect(strongRouting(p, "agreed", schema, { shortlist: [], agreement: 1 }, true).note).toMatch(/no judgement drawer.*agreement 100%/);
    expect(strongRouting(p, "uncertain", schema, { shortlist: [] }, false).note).toMatch(/no strong model/);
  });

  it("the item result records the routing", async () => {
    const f = fakeStore([CONCEPT]);
    const reply = { updates: [{ key: CONCEPT.key, patches: [bullet("Summary", "2026-11-19: dense routes cut fuel 18%.")] }], new_pages: [] };
    const strong = backend(stop(reply));
    const r = await curateItem(item({ body: "From: dana@harbor.example\n\nDense routes cut fuel 18%." }),
      deps({ store: f.store, model: backend(stop(reply)), strong: { model: strong, name: "strong-model" } }));
    expect(strong.complete).toHaveBeenCalledTimes(1);
    expect(r.escalated).toBe(true);
    expect(r.routing).toMatch(/concepts/);
  });
});

describe("6. harness flags run the production pipeline", () => {
  it("parses --consensus, --tiebreak-model, --strong-model and --max-tokens", () => {
    const a = parseAbArgs(["--items", "i", "--pages", "p.json", "--out", "o", "--consensus", "--tiebreak-model", "tb",
      "--strong-model", "st", "--max-tokens", "16384"]);
    expect(a).toMatchObject({ items: "i", pages: "p.json", out: "o", consensus: true, tiebreakModel: "tb", strongModel: "st", maxTokens: 16384 });
  });

  it("defaults: consensus off, production model names", () => {
    const a = parseAbArgs(["--items", "i", "--pages", "p", "--out", "o"]);
    expect(a.consensus).toBe(false);
    expect(a.tiebreakModel).toBe("deepseek-v4.1-flash");
    expect(a.maxTokens).toBeUndefined();
  });

  it("refuses a bad --max-tokens", () => {
    expect(() => parseAbArgs(["--items", "i", "--pages", "p", "--out", "o", "--max-tokens", "lots"])).toThrow(/max-tokens/);
  });

  it("stats carry the agree rate", () => {
    const s = abStats([
      { id: "a", outcome: "applied", pages: [], queued: 0, consensus: "agreed", agreement: 1 },
      { id: "b", outcome: "applied", pages: [], queued: 0, consensus: "tiebreak", agreement: 0.5 },
      { id: "c", outcome: "failed", pages: [], queued: 0, reason: "x" },
    ]);
    expect(s.agree_rate).toBe(0.5);
    expect(s.mean_agreement).toBe(0.75);
    expect(s.failed).toBe(1);
  });
});
