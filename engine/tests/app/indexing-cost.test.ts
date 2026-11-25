import { describe, expect, it } from "vitest";
import { costRows, modelLine } from "../../src/app/indexing-routes.js";

describe("Indexing: model cost", () => {
  it("shows the cost this month and per item", () => {
    const html = costRows({ usd: 4.2, items: 210, per_item_usd: 0.02, runs_without_cost: 0 });
    expect(html).toContain("Model cost this month");
    expect(html).toContain("$4.20 for 210 items");
    expect(html).toContain("$0.0200");
    expect(html).not.toContain("earlier runs");
  });

  it("says when older runs recorded no cost, and when nothing is known yet", () => {
    expect(costRows({ usd: 0, items: 0, per_item_usd: null, runs_without_cost: 3 })).toMatch(/3 earlier runs recorded no cost.*no items yet/s);
    expect(costRows(null)).toContain("database update 0069");
  });

  it("names the writer and triage when consensus is off, else the primary model", () => {
    const cur = { model: "openai-gpt-oss-120b" };
    expect(modelLine(cur, { consensus: false, writer_model: "anthropic-claude-sonnet-5.5", triage: true, triage_model: "openai-gpt-oss-120b" }))
      .toBe("anthropic-claude-sonnet-5.5 (one writer; triage openai-gpt-oss-120b)");
    expect(modelLine(cur, { consensus: false, writer_model: "anthropic-claude-5.5-haiku", triage: false })).toBe("anthropic-claude-5.5-haiku (one writer; no triage)");
    expect(modelLine(cur, { consensus: true, writer_model: "anthropic-claude-sonnet-5.5" })).toBe("openai-gpt-oss-120b");
    expect(modelLine(cur, {})).toBe("openai-gpt-oss-120b");
  });
});
