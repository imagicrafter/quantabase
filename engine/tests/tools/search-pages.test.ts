import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  embedText: vi.fn().mockResolvedValue(Array(384).fill(0.1)),
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { search } = await import("../../src/tools/search.js");

const page = (o: Record<string, unknown>) => ({
  id: "p",
  owner_handle: "ann",
  is_own: false,
  drawer: "organisations",
  key: "acme.com",
  title: "Acme",
  description: "A client",
  distillation: null,
  fields: {},
  updated_at: "t",
  score: 0.1,
  ...o,
});

function respond(byFn: Record<string, unknown>) {
  rpcMock.mockImplementation(async (fn: string) => {
    const v = byFn[fn];
    return v instanceof Error ? { data: null, error: { code: "XX000", message: v.message } } : { data: v ?? [], error: null };
  });
}

beforeEach(() => rpcMock.mockReset());

describe("search with pages", () => {
  it("adds one entry per key, own page first, plus one-step related pages", async () => {
    respond({
      documents_search_by_oauth_subject: [],
      resolved_domain_count_for_oauth_subject: 1,
      pages_search_by_oauth_subject: [
        page({ id: "e1", owner_handle: "eve" }),
        page({ id: "a1", is_own: true }),
        page({ id: "b1", key: "bob@acme.com", drawer: "people", title: "Bob" }),
      ],
      page_related: [
        { from_key: "acme.com", direction: "in", reason: "wikilink", id: "d1", owner_handle: "eve", is_own: false, drawer: "deals", key: "deal:a", title: "Deal", description: null, updated_at: "t" },
      ],
    });
    const out = await search({ query: "acme", match_count: 10, require_approved: false }, "sub-ann");
    expect(out.entities?.map((e) => e.key)).toEqual(["acme.com", "bob@acme.com"]);
    expect(out.entities?.[0]!.pages.map((p) => p.id)).toEqual(["a1", "e1"]);
    expect(out.related?.map((r) => r.key)).toEqual(["deal:a"]);
    const relatedCall = rpcMock.mock.calls.find((c) => c[0] === "page_related")!;
    expect(relatedCall[1].p_keys).toEqual(["acme.com", "bob@acme.com"]);
    expect(relatedCall[1].p_oauth_subject).toBe("sub-ann");
  });

  it("a page search failure leaves document results intact", async () => {
    respond({
      documents_search_by_oauth_subject: [
        { id: "d", title: "Doc", source: "wiki", domains: ["x"], tier: 1, review_status: "approved", fused_score: 1 },
      ],
      pages_search_by_oauth_subject: new Error("boom"),
    });
    const out = await search({ query: "acme", match_count: 10, require_approved: false }, "sub-ann");
    expect(out.results).toHaveLength(1);
    expect(out.entities ?? []).toEqual([]);
  });
});
