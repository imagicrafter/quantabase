import { describe, expect, it, vi } from "vitest";
import { abStats, parseAbArgs } from "../../src/eval/ab-args.js";
import { runAbDetailed } from "../../src/eval/ab.js";
import { entitySchema } from "../../src/entities/templates.js";
import { addUsage, emptyUsage } from "../../src/curator/usage.js";

const base = ["--items", "i", "--pages", "p", "--out", "o"];

describe("harness flags for the single writer", () => {
  it("--writer-model turns on the single writer with triage on by default", () => {
    const a = parseAbArgs([...base, "--writer-model", "anthropic-claude-5.5-haiku"]);
    expect(a).toMatchObject({ writerModel: "anthropic-claude-5.5-haiku", triage: true, triageModel: "openai-gpt-oss-120b" });
  });

  it("--triage off and --triage-model", () => {
    expect(parseAbArgs([...base, "--writer-model", "w", "--triage", "off"]).triage).toBe(false);
    expect(parseAbArgs([...base, "--writer-model", "w", "--triage-model", "deepseek-v4.1-flash"]).triageModel).toBe("deepseek-v4.1-flash");
    expect(() => parseAbArgs([...base, "--triage", "maybe"])).toThrow(/--triage/);
  });

  it("no --writer-model keeps the old run (no writer)", () => {
    expect(parseAbArgs(base).writerModel).toBeUndefined();
  });

  it("stats add up USD and tokens per model", () => {
    const u1 = addUsage(emptyUsage(), "openai-gpt-oss-120b", { inputTokens: 1_000_000, outputTokens: 0 });
    const u2 = addUsage(emptyUsage(), "anthropic-claude-sonnet-5.5", { inputTokens: 0, outputTokens: 100_000 });
    const s = abStats([
      { id: "a", outcome: "no_change", pages: [], queued: 0, usage: u1, triaged: true },
      { id: "b", outcome: "applied", pages: [], queued: 0, usage: u2 },
    ]);
    expect(s.usd).toBeCloseTo(0.1 + 1.0, 6);
    expect(s.usd_per_item).toBeCloseTo(0.55, 6);
    expect(s.triage_no_change).toBe(1);
    expect(s.by_model["openai-gpt-oss-120b"]).toMatchObject({ input: 1_000_000 });
  });
});

describe("runAbDetailed with the writer", () => {
  it("passes triage to the curator and records each item's cost", async () => {
    const triage = { complete: vi.fn().mockResolvedValue({ text: '{"durable": false, "reason": "thanks only"}', finish: "stop", inputTokens: 500, outputTokens: 20 }) };
    const writer = { complete: vi.fn() };
    const { results } = await runAbDetailed([{ id: "e1", title: "Thanks", body: "Thanks!" }], [], {
      schema: entitySchema(["consulting"]), model: writer, modelName: "anthropic-claude-sonnet-5.5",
      writer: { triage: { model: triage, name: "openai-gpt-oss-120b" } },
    });
    expect(writer.complete).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ outcome: "no_change", triaged: true });
    expect(results[0]!.usd).toBeGreaterThan(0);
  });
});
