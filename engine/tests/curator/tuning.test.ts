import { describe, expect, it, vi } from "vitest";
import { entitySchema } from "../../src/entities/templates.js";
import { LARGE_REMOVAL_SHARE, judgeUpdate } from "../../src/curator/policy.js";
import { buildTriagePrompt } from "../../src/curator/triage.js";
import { runTick } from "../../src/curator/run.js";
import {
  ARCHIVIST_FLOOR, BIG_CHANGE_SHARE, DEFAULT_TUNING, archivistThreshold, parseTuning, removalShare, triageLean,
} from "../../src/curator/tuning.js";
import { OVENS, fakeStore, item, page } from "./fixtures.js";

const schema = entitySchema(["consulting"]);

describe("the Pipeline screen's choices (0071) as the curator uses them", () => {
  it("reads the row, and keeps the default for anything unknown or missing", () => {
    expect(parseTuning(null)).toEqual(DEFAULT_TUNING);
    expect(parseTuning({ desk_editor: "keep_less", archivist_bar: "rarely_new", publisher_ask: "big_changes", paused: true }))
      .toEqual({ deskEditor: "keep_less", archivistBar: "rarely_new", publisherAsk: "big_changes", paused: true, summaryLength: "standard" });
    expect(parseTuning({ desk_editor: "drop_everything", publisher_ask: "off", paused: "yes" })).toEqual(DEFAULT_TUNING);
  });

  it("desk editor leans the triage prompt; normal adds nothing", () => {
    expect(triageLean("normal")).toBe("");
    expect(triageLean(undefined)).toBe("");
    const more = buildTriagePrompt(item(), [], schema, "0123abcd", "keep_more");
    const less = buildTriagePrompt(item(), [], schema, "0123abcd", "keep_less");
    const normal = buildTriagePrompt(item(), [], schema, "0123abcd");
    expect(more).toContain(triageLean("keep_more"));
    expect(less).toContain(triageLean("keep_less"));
    expect(normal).not.toContain("LEAN:");
  });

  it("archivist's rarely_new lowers the match bar a little, never below the floor and never raises it", () => {
    expect(archivistThreshold(0.85, "normal")).toBe(0.85);
    expect(archivistThreshold(0.85, "rarely_new")).toBeCloseTo(0.8, 10);
    expect(archivistThreshold(0.52, "rarely_new")).toBe(ARCHIVIST_FLOOR);
    expect(archivistThreshold(0.4, "rarely_new")).toBe(0.4);
  });

  it("publisher's big_changes asks sooner; no choice ever asks later than the built-in check", () => {
    expect(removalShare("never")).toBe(LARGE_REMOVAL_SHARE);
    expect(removalShare("big_changes")).toBe(BIG_CHANGE_SHARE);
    expect(removalShare("big_changes")).toBeLessThan(LARGE_REMOVAL_SHARE);
    const body = "# T\n\n## Summary\n" + "A".repeat(300) + "\n" + "C".repeat(700) + "\n\n## Timeline\n- 2026-10-02: sent.\n";
    const quarter = { key: OVENS.key, fields: {}, patches: [{ op: "replace-line" as const, section: "Summary", old: "A".repeat(300), new: "B" }] };
    const p = page({ ...OVENS, body });
    expect(judgeUpdate(quarter, p, schema, false)).toEqual({ apply: true });
    expect(judgeUpdate(quarter, p, schema, false, removalShare("big_changes"))).toMatchObject({ apply: false });
    // A share above the built-in one is capped: the large-removal check cannot be loosened.
    const big = page({ ...OVENS, body: "# T\n\n## Summary\n" + "A".repeat(500) + "\n\n## Timeline\n- 2026-10-02: sent.\n" });
    const most = { key: OVENS.key, fields: {}, patches: [{ op: "replace-line" as const, section: "Summary", old: "A".repeat(500), new: "B" }] };
    expect(judgeUpdate(most, big, schema, false, 0.99)).toMatchObject({ apply: false });
  });

  it("a paused curator reads nothing and says so in the run stats", async () => {
    const f = fakeStore();
    const store = { ...f.store, pipeline: vi.fn().mockResolvedValue({ ...DEFAULT_TUNING, paused: true }) };
    const makeModel = vi.fn();
    const stats = await runTick("tick", { store, embed: vi.fn(), makeModel, now: () => new Date("2026-11-22T12:00:00Z") });
    expect(stats?.["paused"]).toBe(true);
    expect(f.store.claim).not.toHaveBeenCalled();
    expect(makeModel).not.toHaveBeenCalled();
  });

  it("a failed read of the choices keeps the defaults and the run goes on", async () => {
    const f = fakeStore();
    const store = { ...f.store, pipeline: vi.fn().mockRejectedValue(new Error("db down")) };
    const stats = await runTick("tick", { store, embed: vi.fn(), makeModel: vi.fn().mockReturnValue({ complete: vi.fn() }), now: () => new Date() });
    expect(stats?.["paused"]).toBeUndefined();
    expect(f.store.claim).toHaveBeenCalled();
  });
});
