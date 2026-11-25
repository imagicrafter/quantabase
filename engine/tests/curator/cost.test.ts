import { describe, expect, it } from "vitest";
import { MODEL_PRICES, PRICES_AS_OF, PRICES_SOURCE, costOf } from "../../src/curator/prices.js";
import { addUsage, emptyUsage, mergeUsage, totalUsd, usageStats } from "../../src/curator/usage.js";

describe("price table", () => {
  it("names its source and date", () => {
    expect(PRICES_SOURCE).toMatch(/^https:\/\/docs\.digitalocean\.com\//);
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prices every model the curator may use", () => {
    for (const m of ["openai-gpt-oss-120b", "deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3", "anthropic-claude-sonnet-5.5", "anthropic-claude-5.5-haiku"]) {
      expect(MODEL_PRICES[m], m).toBeDefined();
    }
  });

  it("charges input, output, cache reads and cache writes at their own rates", () => {
    // Sonnet: 2.00 in, 10.00 out, 0.20 cache read, 2.50 cache write (per million).
    const usd = costOf("anthropic-claude-sonnet-5.5", { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
    expect(usd).toBeCloseTo(2 + 1 + 0.2 + 2.5, 6);
  });

  it("uses Haiku's long-context rate above 100k input tokens in one call", () => {
    expect(costOf("anthropic-claude-5.5-haiku", { input: 50_000, output: 0 })).toBeCloseTo(0.005, 6);
    expect(costOf("anthropic-claude-5.5-haiku", { input: 200_000, output: 0 })).toBeCloseTo(0.1, 6);
  });

  it("an unknown model costs null, never a guess", () => {
    expect(costOf("some-new-model", { input: 10, output: 10 })).toBeNull();
  });
});

describe("usage accounting", () => {
  it("adds calls per model without changing the original", () => {
    const a = emptyUsage();
    const b = addUsage(a, "openai-gpt-oss-120b", { inputTokens: 1000, outputTokens: 100, finish: "stop", text: "" });
    const c = addUsage(b, "anthropic-claude-sonnet-5.5", {
      inputTokens: 2000, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 0, finish: "stop", text: "",
    });
    expect(a).toEqual({});
    expect(c["openai-gpt-oss-120b"]).toMatchObject({ calls: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(c["anthropic-claude-sonnet-5.5"]!.usd).toBeCloseTo((2000 * 2 + 300 * 10 + 5000 * 0.2) / 1e6, 9);
    expect(totalUsd(c)).toBeCloseTo(c["openai-gpt-oss-120b"]!.usd! + c["anthropic-claude-sonnet-5.5"]!.usd!, 9);
  });

  it("merges two usages and flattens them into run stats", () => {
    const x = addUsage(emptyUsage(), "openai-gpt-oss-120b", { inputTokens: 10, outputTokens: 1, finish: "stop", text: "" });
    const m = mergeUsage(x, x);
    expect(m["openai-gpt-oss-120b"]).toMatchObject({ calls: 2, input: 20, output: 2 });
    const s = usageStats(m);
    expect(s["tokens_in:openai-gpt-oss-120b"]).toBe(20);
    expect(s["tokens_out:openai-gpt-oss-120b"]).toBe(2);
    expect(typeof s["usd"]).toBe("number");
  });
});
