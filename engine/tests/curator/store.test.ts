import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  embedText: vi.fn(),
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { store, StoreError } = await import("../../src/curator/store.js");

const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => rpcMock.mockReset());

describe("curator store: the run lease (0064)", () => {
  it("starts a run with a holder and a lease", async () => {
    rpcMock.mockResolvedValueOnce(ok("run-1"));
    expect(await store.runStart("tick", "boot-a", 180)).toBe("run-1");
    expect(rpcMock).toHaveBeenCalledWith("curator_run_start", { p_mode: "tick", p_holder: "boot-a", p_lease_seconds: 180 });
  });

  it("falls back to the old start before 0064 is applied", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } });
    rpcMock.mockResolvedValueOnce(ok("run-2"));
    expect(await store.runStart("batch", "boot-a")).toBe("run-2");
    expect(rpcMock).toHaveBeenLastCalledWith("curator_run_start", { p_mode: "batch" });
  });

  it("does not fall back on other errors", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "down" } });
    await expect(store.runStart("tick", "boot-a")).rejects.toBeInstanceOf(StoreError);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("heartbeats, reclaims and records ticks", async () => {
    rpcMock.mockResolvedValueOnce(ok(false));
    expect(await store.heartbeat("run-1")).toBe(false);
    expect(rpcMock).toHaveBeenLastCalledWith("curator_run_heartbeat", { p_run: "run-1", p_lease_seconds: 180 });
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } });
    expect(await store.heartbeat("run-1")).toBe(true);
    rpcMock.mockResolvedValueOnce(ok(2));
    expect(await store.runReclaim("boot-b")).toBe(2);
    expect(rpcMock).toHaveBeenLastCalledWith("curator_run_reclaim", { p_holder: "boot-b" });
    rpcMock.mockResolvedValueOnce(ok(null));
    await store.tickSeen("busy");
    expect(rpcMock).toHaveBeenLastCalledWith("curator_tick_seen", { p_outcome: "busy" });
  });
});

describe("curator store: the 0053 functions and nothing else", () => {
  it("reads settings with safe defaults", async () => {
    rpcMock.mockResolvedValueOnce(ok([{ enabled: true, model: "deepseek-v4.1-flash", templates: ["consulting"], batch_size: 5, has_model_key: true }]));
    expect(await store.settings()).toEqual({ enabled: true, model: "deepseek-v4.1-flash", templates: ["consulting"], batchSize: 5, hasModelKey: true });
    rpcMock.mockResolvedValueOnce(ok([]));
    expect(await store.settings()).toEqual({ enabled: false, model: "openai-gpt-oss-120b", templates: [], batchSize: 10, hasModelKey: false });
    expect(rpcMock).toHaveBeenCalledWith("curator_settings_get", {});
  });

  it("passes the tick secret to the database to compare", async () => {
    rpcMock.mockResolvedValueOnce(ok(true));
    expect(await store.tickSecretOk("abc")).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("curator_tick_secret_ok", { p_secret: "abc" });
    rpcMock.mockResolvedValueOnce(ok(null));
    expect(await store.modelKey()).toBeNull();
  });

  it("maps claimed items and candidate pages", async () => {
    rpcMock.mockResolvedValueOnce(ok([{ id: "i1", owner_email: "o@x.com", source: "gmail", source_id: "t", version: 2, title: null,
      body: "b", topics: ["c"], metadata: null, source_created_at: null, received_at: "r", released: true }]));
    expect(await store.claim(3)).toEqual([{ id: "i1", owner_email: "o@x.com", source: "gmail", source_id: "t", version: 2, title: null,
      body: "b", topics: ["c"], metadata: {}, source_created_at: null, received_at: "r", released: true }]);
    expect(rpcMock).toHaveBeenLastCalledWith("curator_claim", { p_limit: 3, p_lease_seconds: 600 });

    rpcMock.mockResolvedValueOnce(ok([{ id: "p", drawer: "people", key: "a@b.com", title: "A", fields: { x: 1 }, sources: [{ item: "i" }],
      body: "#", content_hash: "h", matched_on: "key" }]));
    const [p] = await store.candidates("i1", ["a@b.com"], "q");
    expect(p).toMatchObject({ key: "a@b.com", aliases: [], topics: [], status: "unreviewed", sources: [{ item: "i" }], generated: null });
    expect(rpcMock).toHaveBeenLastCalledWith("curator_candidates", { p_item_id: "i1", p_keys: ["a@b.com"], p_query: "q", p_limit: 8 });
  });

  it("names the right function for every write", async () => {
    rpcMock.mockResolvedValue(ok([{ id: "p1", changed: true, created: false }]));
    await store.savePage("i1", { key: "k" }, "h");
    await store.flag("i1", "why");
    await store.done("i1", "applied", ["p1"]);
    await store.queueReview({ itemId: "i1", pageId: null, pageKey: "k", kind: "new_page", reasons: ["r"], proposal: {}, baseHash: null });
    await store.markReview("r1", "stale", "e");
    await store.runStart("batch");
    await store.runFinish("run", true, {});
    await store.ticketsSync();
    await store.lastRunAt();
    await store.pokeFailures("t");
    await store.pruneHistory();
    await store.approvedReviews();
    await store.summaryQueue();
    await store.writeSummary("p1", "t", "s", [0.1]);
    expect(rpcMock.mock.calls.map((c) => c[0])).toEqual([
      "curator_page_save", "curator_flag", "curator_item_done", "curator_review_add", "curator_review_mark",
      "curator_run_start", "curator_run_finish", "curator_tickets_sync", "curator_last_run_at", "curator_poke_failures", "page_history_prune",
      "curator_reviews_approved", "curator_summary_queue", "curator_summary_write",
    ]);
  });

  it("passes on a 22023 message and hides any other error", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "the page has changed since it was read" } });
    await expect(store.savePage("i", {}, null)).rejects.toMatchObject({ code: "22023", message: "the page has changed since it was read" });
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "internal detail with page text" } });
    const err = await store.claim(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as Error).message).toBe("curator_claim failed");
    rpcMock.mockResolvedValueOnce(ok([]));
    await expect(store.savePage("i", {}, null)).rejects.toThrow("could not be saved");
  });
});

describe("curator store: account people's page names (0077)", () => {
  it("maps page_name, and a row without one (0070) gives none", async () => {
    rpcMock.mockResolvedValueOnce(ok([
      { email: "ann@example.com", display_name: "Ann Example", page_name: "Ann" },
      { email: "pat@example.com", display_name: "Pat Reader" },
    ]));
    expect(await store.accountPeople()).toEqual([
      { email: "ann@example.com", name: "Ann Example", pageName: "Ann" },
      { email: "pat@example.com", name: "Pat Reader", pageName: null },
    ]);
  });
});
