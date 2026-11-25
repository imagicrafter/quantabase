import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeout, DB_TIMEOUT_MS } = await import("../src/supabase.js");

afterEach(() => vi.unstubAllGlobals());

describe("database calls have a deadline", () => {
  it("gives every call a signal, even when the caller passed none", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response("[]");
    }));
    await fetchWithTimeout("https://db.example.com/rest/v1/rpc/x", { method: "POST" });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(DB_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("keeps the caller's own signal working", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    ));
    const mine = new AbortController();
    const call = fetchWithTimeout("https://db.example.com/x", { signal: mine.signal });
    mine.abort(new Error("caller gave up"));
    await expect(call).rejects.toThrow("caller gave up");
  });
});
