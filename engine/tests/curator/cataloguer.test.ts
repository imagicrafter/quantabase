import { describe, expect, it, vi } from "vitest";
import { runTick } from "../../src/curator/run.js";
import { buildSummaryPrompt } from "../../src/curator/prompt.js";
import { DEFAULT_TUNING, parseTuning } from "../../src/curator/tuning.js";
import { fakeStore, modelSaying } from "./fixtures.js";

/**
 * The Cataloguer (summaries) and the Index clerk (the search embedding), the
 * step after publishing (migration 0075). Synthetic pages only.
 */

const GOOD = "Northwind's route pilot: tablets are ready and launch moves to 2026-11-30.";
const QUEUED = { id: "p1", drawer: "projects", title: "Pilot", description: null, body: "# Pilot", summary_queued_at: "2026-11-19T11:00:00Z" };

function setup(reply: unknown = { summary: GOOD }, embed = vi.fn().mockResolvedValue(Array(384).fill(0.01))) {
  const f = fakeStore();
  const model = modelSaying(reply);
  const makeModel = vi.fn().mockReturnValue(model);
  return { f, model, embed, deps: { store: f.store, embed, makeModel, now: () => new Date("2026-11-19T12:00:00Z") } };
}

describe("summary length (the Cataloguer's one setting)", () => {
  it("defaults to standard and reads only short or standard", () => {
    expect(DEFAULT_TUNING.summaryLength).toBe("standard");
    expect(parseTuning({ summary_length: "short" }).summaryLength).toBe("short");
    expect(parseTuning({ summary_length: "epic" }).summaryLength).toBe("standard");
    expect(parseTuning(null).summaryLength).toBe("standard");
  });

  it("asks for fewer sentences when short; standard is the old prompt", () => {
    const page = { title: "Pilot", drawer: "projects", description: null, body: "# Pilot" };
    expect(buildSummaryPrompt(page)).toContain("2 to 4 plain sentences (at most 600 characters)");
    expect(buildSummaryPrompt(page, "standard")).toContain("2 to 4 plain sentences (at most 600 characters)");
    const short = buildSummaryPrompt(page, "short");
    expect(short).toContain("1 or 2 plain sentences (at most 300 characters)");
    expect(short).not.toContain("2 to 4");
  });

  it("the run passes the owner's choice into the summary prompt", async () => {
    const { f, model, deps } = setup();
    (f.store as unknown as { pipeline: unknown }).pipeline = vi.fn().mockResolvedValue({ ...DEFAULT_TUNING, summaryLength: "short" });
    f.store.summaryQueue.mockResolvedValueOnce([QUEUED]);
    await runTick("tick", deps);
    const prompt = String(model.complete.mock.calls.at(-1)?.[1] ?? "");
    expect(prompt).toContain("1 or 2 plain sentences");
  });
});

describe("summary cost and failures are recorded on their own", () => {
  it("records the Cataloguer's cost and model apart from the rest", async () => {
    const { f, deps } = setup();
    f.store.summaryQueue.mockResolvedValueOnce([QUEUED]);
    const stats = await runTick("tick", deps);
    expect(stats).toMatchObject({ summaries: 1, summary_model: "openai-gpt-oss-120b" });
    expect(typeof stats?.["usd_summaries"]).toBe("number");
    expect(Number(stats?.["usd_summaries"])).toBeGreaterThan(0);
    // Still part of the run's total.
    expect(Number(stats?.["usd"])).toBeGreaterThanOrEqual(Number(stats?.["usd_summaries"]));
  });

  it("an unusable summary is a Cataloguer failure", async () => {
    const { f, deps } = setup({ summary: "short" });
    f.store.summaryQueue.mockResolvedValueOnce([QUEUED]);
    const stats = await runTick("tick", deps);
    expect(stats?.["summary_failed"]).toBe(1);
    expect(stats?.["index_failed"]).toBeUndefined();
    expect(f.store.writeSummary).not.toHaveBeenCalled();
  });

  it("a model error is a Cataloguer failure", async () => {
    const { f, model, deps } = setup();
    model.complete.mockRejectedValueOnce(new Error("model down"));
    f.store.summaryQueue.mockResolvedValueOnce([QUEUED]);
    const stats = await runTick("tick", deps);
    expect(stats?.["summary_failed"]).toBe(1);
  });

  it("a good summary that cannot be embedded or filed is an Index clerk failure", async () => {
    const { f, deps } = setup({ summary: GOOD }, vi.fn().mockRejectedValue(new Error("embed down")));
    f.store.summaryQueue.mockResolvedValueOnce([QUEUED]);
    const stats = await runTick("tick", deps);
    expect(stats?.["index_failed"]).toBe(1);
    expect(stats?.["summary_failed"]).toBeUndefined();

    const two = setup();
    two.f.store.writeSummary.mockRejectedValueOnce(new Error("write failed"));
    two.f.store.summaryQueue.mockResolvedValueOnce([QUEUED]);
    expect((await runTick("tick", two.deps))?.["index_failed"]).toBe(1);
  });

  it("an unpriced summary model records no cost, so it cannot pull the redo estimate down", async () => {
    const { f, deps } = setup();
    f.store.settings.mockResolvedValue({ enabled: true, model: "unpriced-model", templates: ["consulting"], batchSize: 10, hasModelKey: true });
    f.store.summaryQueue.mockResolvedValueOnce([QUEUED]);
    const stats = await runTick("tick", deps);
    expect(stats).toMatchObject({ summaries: 1, summary_model: "unpriced-model" });
    expect(stats?.["usd_summaries"]).toBeUndefined();
  });

  it("no summaries, no Cataloguer keys", async () => {
    const { deps } = setup();
    const stats = await runTick("tick", deps);
    expect(stats?.["usd_summaries"]).toBeUndefined();
    expect(stats?.["summary_model"]).toBeUndefined();
  });
});
