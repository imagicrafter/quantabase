import { describe, expect, it, vi } from "vitest";
import { runTick } from "../../src/curator/run.js";
import { fakeStore, item } from "./fixtures.js";

const embed = vi.fn().mockResolvedValue(Array(384).fill(0.01));

function reply(text: unknown, inputTokens: number, outputTokens: number) {
  return { complete: vi.fn().mockResolvedValue({ text: JSON.stringify(text), finish: "stop", inputTokens, outputTokens }) };
}

describe("runTick with the single writer (0069 applied, consensus off)", () => {
  it("uses the writer and triage models from the settings and records tokens and USD per model", async () => {
    const f = fakeStore();
    f.store.consensus.mockResolvedValue({
      enabled: false, tiebreakModel: "deepseek-v4.1-flash", writerModel: "anthropic-claude-5.5-haiku", triage: true, triageModel: "openai-gpt-oss-120b",
    });
    f.store.claim.mockResolvedValueOnce([item({ body: "Can we move the call to 3pm?" })]);
    const triage = reply({ durable: false, reason: "scheduling" }, 2000, 100);
    const writer = reply({ updates: [], new_pages: [] }, 0, 0);
    const makeModel = vi.fn((name: string) => (name === "openai-gpt-oss-120b" ? triage : writer));
    const stats = await runTick("tick", { store: f.store, embed, makeModel, now: () => new Date("2026-11-22T12:00:00Z") });
    expect(makeModel).toHaveBeenCalledWith("anthropic-claude-5.5-haiku", "test-model-key", { maxOutputTokens: 16384 });
    expect(writer.complete).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      writer_model: "anthropic-claude-5.5-haiku", triage_model: "openai-gpt-oss-120b", no_change: 1, triage_no_change: 1,
      "tokens_in:openai-gpt-oss-120b": 2000, "tokens_out:openai-gpt-oss-120b": 100,
    });
    // gpt-oss-120b: 2000 x 0.10 + 100 x 0.70 per million.
    expect(stats?.["usd"]).toBeCloseTo(0.00027, 8);
  });

  it("keeps the consensus pipeline before 0069 is applied (no writer model in the settings)", async () => {
    const f = fakeStore();
    f.store.consensus.mockResolvedValue({ enabled: true, tiebreakModel: "deepseek-v4.1-flash" });
    const makeModel = vi.fn().mockReturnValue(reply({ updates: [], new_pages: [] }, 1, 1));
    const stats = await runTick("tick", { store: f.store, embed, makeModel, now: () => new Date() });
    expect(stats?.["consensus"]).toBe(true);
    expect(stats?.["writer_model"]).toBeUndefined();
    expect(makeModel).toHaveBeenCalledWith("deepseek-v4.1-flash", "test-model-key", expect.anything());
  });
});
