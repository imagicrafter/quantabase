import { describe, expect, it, vi } from "vitest";
import { TICK_HEADER, makeTickRoute } from "../../src/curator/route.js";

const SECRET = "s".repeat(40);

function route(over: Partial<Parameters<typeof makeTickRoute>[0]> = {}) {
  const checkSecret = vi.fn(async (s: string) => s === SECRET);
  let release: () => void = () => undefined;
  const start = vi.fn(() => new Promise<void>((r) => (release = r)));
  const app = makeTickRoute({ checkSecret, start, ...over });
  const post = (headers: Record<string, string> = { [TICK_HEADER]: SECRET }, body = "{}") =>
    app.request("/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { app, checkSecret, start, post, release: () => release() };
}

describe("POST /internal/curator/tick", () => {
  it("refuses a missing, short or wrong secret with no detail", async () => {
    const r = route();
    expect((await r.post({})).status).toBe(401);
    expect((await r.post({ [TICK_HEADER]: "short" })).status).toBe(401);
    expect(r.checkSecret).not.toHaveBeenCalled();
    const wrong = await r.post({ [TICK_HEADER]: "w".repeat(40) });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
    expect(r.start).not.toHaveBeenCalled();
  });

  it("answers 503 when the secret cannot be checked", async () => {
    const r = route({ checkSecret: vi.fn().mockRejectedValue(new Error("db")) });
    expect((await r.post()).status).toBe(503);
  });

  it("starts a run and answers at once; a second poke is busy", async () => {
    const r = route();
    const first = await r.post();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ started: true, mode: "tick" });
    const second = await r.post();
    expect(await second.json()).toEqual({ busy: true });
    expect(r.start).toHaveBeenCalledTimes(1);
    r.release();
    await new Promise((res) => setTimeout(res, 0));
    expect((await r.post(undefined, '{"mode":"batch"}')).status).toBe(202);
    expect(r.start).toHaveBeenLastCalledWith("batch");
  });

  it("refuses an unknown body", async () => {
    const r = route();
    expect((await r.post(undefined, '{"mode":"everything"}')).status).toBe(400);
    expect((await r.post(undefined, '{"mode":"tick","owner":"x"}')).status).toBe(400);
  });

  it("writes one log line for every poke: accepted, busy or rejected", async () => {
    const { logger } = await import("../../src/log/logger.js");
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    const r = route();
    await r.post({});
    await r.post({ [TICK_HEADER]: "w".repeat(40) });
    await r.post();
    await r.post();
    const msgs = [...info.mock.calls, ...warn.mock.calls].map((c) => c[1]);
    expect(msgs.filter((m) => m === "curator tick rejected")).toHaveLength(2);
    expect(msgs.filter((m) => m === "curator tick accepted")).toHaveLength(1);
    expect(msgs.filter((m) => m === "curator tick busy")).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("w".repeat(40));
    info.mockRestore();
    warn.mockRestore();
  });

  it("records each poke that carried the right secret, and a skipped run", async () => {
    const seen = vi.fn().mockResolvedValue(undefined);
    const r = route({ seen });
    await r.post({});
    expect(seen).not.toHaveBeenCalled();
    await r.post();
    await r.post();
    expect(seen.mock.calls.map((c) => c[0])).toEqual(["started", "busy"]);

    const skipped = vi.fn().mockResolvedValue(undefined);
    const s = route({ seen: skipped, start: vi.fn().mockResolvedValue(null) });
    await s.post();
    await new Promise((res) => setTimeout(res, 0));
    expect(skipped.mock.calls.map((c) => c[0])).toEqual(["started", "skipped"]);
  });

  it("a failing record never fails the poke", async () => {
    const r = route({ seen: vi.fn().mockRejectedValue(new Error("db")) });
    expect((await r.post()).status).toBe(202);
  });

  it("logs a run that throws and frees the guard", async () => {
    const seen = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockRejectedValue(new Error("boom"));
    const r = route({ start, seen });
    expect((await r.post()).status).toBe(202);
    await new Promise((res) => setTimeout(res, 0));
    expect(seen).toHaveBeenLastCalledWith("failed");
    expect((await r.post()).status).toBe(202);
  });

  it("reclaims an in-process guard that is older than the run's hard deadline", async () => {
    let t = 0;
    const r = route({ staleMs: 1000, clock: () => t });
    expect((await r.post()).status).toBe(202);
    t = 500;
    expect(await (await r.post()).json()).toEqual({ busy: true });
    t = 1500;
    expect((await r.post()).status).toBe(202);
    expect(r.start).toHaveBeenCalledTimes(2);
  });

  it("is mounted in the app before any sign-in check", async () => {
    vi.resetModules();
    const { app } = await import("../../src/index.js");
    const res = await app.request("/internal/curator/tick", {
      method: "POST",
      headers: { host: "engine.example.com", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
