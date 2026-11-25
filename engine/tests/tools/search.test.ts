import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { search, searchSchema } from "../../src/tools/search.js";

describe("search tool schema", () => {
  it("rejects empty query", () => {
    expect(() => searchSchema.parse({ query: "" })).toThrow();
  });

  it("rejects query over 1000 chars", () => {
    expect(() => searchSchema.parse({ query: "a".repeat(1001) })).toThrow();
  });

  it("clamps match_count to 1-50", () => {
    expect(() =>
      searchSchema.parse({ query: "test", match_count: 0 }),
    ).toThrow();
    expect(() =>
      searchSchema.parse({ query: "test", match_count: 51 }),
    ).toThrow();
    expect(
      searchSchema.parse({ query: "test", match_count: 50 }).match_count,
    ).toBe(50);
  });

  it("defaults match_count to 10", () => {
    expect(searchSchema.parse({ query: "test" }).match_count).toBe(10);
  });

  it("defaults require_approved to false", () => {
    expect(searchSchema.parse({ query: "test" }).require_approved).toBe(false);
  });
});

describe("search tool result shape", () => {
  beforeEach(() => {
    vi.mock("../../src/supabase.js", () => ({
      embedText: vi.fn().mockResolvedValue(Array(384).fill(0.1)),
      supabase: {
        schema: () => ({
          rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty results with no error for unknown sub", async () => {
    const result = await search(
      { query: "test", match_count: 5, require_approved: false },
      "user_unknown",
    );
    expect(result.results).toEqual([]);
  });
});
