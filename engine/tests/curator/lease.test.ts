import { describe, expect, it, vi } from "vitest";
import { DeadlineError, HOLDER, reclaimAtBoot, withDeadline } from "../../src/curator/lease.js";
import { runTick } from "../../src/curator/run.js";
import { fakeStore, item, modelSaying } from "./fixtures.js";

const embed = vi.fn().mockResolvedValue(Array(384).fill(0.01));
const NOW = () => new Date("2026-11-21T22:19:00Z");

describe("withDeadline", () => {
  it("passes a result through", async () => {
    expect(await withDeadline(Promise.resolve(7), 1000, "x")).toBe(7);
  });

  it("rejects with DeadlineError when the work never settles", async () => {
    const never = new Promise<number>(() => undefined);
    await expect(withDeadline(never, 10, "curator run")).rejects.toBeInstanceOf(DeadlineError);
  });
});

describe("reclaimAtBoot", () => {
  it("closes runs of an earlier process with this process's holder", async () => {
    const runReclaim = vi.fn().mockResolvedValue(1);
    expect(await reclaimAtBoot({ runReclaim })).toBe(1);
    expect(runReclaim).toHaveBeenCalledWith(HOLDER);
    expect(HOLDER).toMatch(/^svc-[0-9a-f-]{36}$/);
  });

  it("never throws (an Engine still in setup has no curator)", async () => {
    expect(await reclaimAtBoot({ runReclaim: vi.fn().mockRejectedValue(new Error("no function")) }, "h")).toBe(0);
  });
});

describe("runTick: lease and deadline", () => {
  it("starts with this process's holder and a lease", async () => {
    const f = fakeStore();
    f.store.settings.mockResolvedValueOnce({ enabled: false, model: "m", templates: [], batchSize: 10, hasModelKey: false });
    await runTick("tick", { store: f.store, embed, now: NOW, holder: "boot-a" });
    expect(f.store.runStart).toHaveBeenCalledWith("tick", "boot-a", 180);
  });

  it("records a run that hangs as failed at the hard deadline", async () => {
    const f = fakeStore();
    f.store.pruneHistory.mockReturnValueOnce(new Promise(() => undefined));
    const stats = await runTick("tick", { store: f.store, embed, now: NOW, hardCapMs: 20 });
    expect(stats?.["error"]).toMatch(/did not finish/);
    expect(f.store.runFinish).toHaveBeenCalledWith("run-1", false, expect.objectContaining({ error: expect.stringMatching(/did not finish/) }));
  });

  it("renews its lease while it works", async () => {
    const f = fakeStore();
    let release: () => void = () => undefined;
    f.store.pruneHistory.mockReturnValueOnce(new Promise((r) => (release = () => r(0))));
    const done = runTick("tick", { store: f.store, embed, now: NOW, heartbeatMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    release();
    await done;
    expect(f.store.heartbeat).toHaveBeenCalledWith("run-1", 180);
    const calls = f.store.heartbeat.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(f.store.heartbeat.mock.calls.length).toBe(calls);
  });

  it("stops curating items once the lease is lost", async () => {
    const f = fakeStore();
    f.store.heartbeat.mockResolvedValue(false);
    const model = modelSaying({ updates: [], new_pages: [] });
    let firstDone: () => void = () => undefined;
    const slow = {
      complete: vi.fn(async (...args: Parameters<typeof model.complete>) => {
        await new Promise<void>((r) => (firstDone = r));
        return model.complete(...args);
      }),
    };
    f.store.claim.mockResolvedValueOnce([item({ id: "i1" }), item({ id: "i2" })]);
    const run = runTick("tick", { store: f.store, embed, now: NOW, makeModel: () => slow, heartbeatMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    firstDone();
    const stats = await run;
    expect(stats?.["deferred"]).toBe(1);
    expect(slow.complete.mock.calls.length).toBeGreaterThan(0);
  });
});
