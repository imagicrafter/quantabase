import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { CLAIM_COOKIE, createBootCode, type BootCode } from "../../src/app/boot-code.js";
import { _setBootCodeForTests, bootCode, startFirstRun } from "../../src/app/first-run.js";
import { firstRunGate, makeFirstRunRoutes, type FirstRunRouteDeps, type HeldVerdict } from "../../src/app/first-run-routes.js";
import type { EngineMode } from "../../src/setup/mode.js";
import { ANON_KEY, createFakeSupabase, FILES, JWT_SECRET, REF } from "./fake-supabase.js";

/**
 * 2026-11-20 cold start: a redeploy after the Database step but before sign-in
 * lost the in-memory claim, asked for a new code, and the sign-in step then
 * failed with "Setup code not accepted" (the database held the old code).
 */

const CODE = "first-run-code-AbCdEfGh0123456789_xyz";
const SECRET = "a-stable-jwt-secret-that-is-long-enough-0123456789";

function claimed(): { boot: BootCode; cookie: string } {
  const boot = createBootCode(CODE, Date.now, { cookieSecret: SECRET });
  const res = boot.claim(CODE);
  if (!res.ok) throw new Error("claim failed");
  return { boot, cookie: res.cookie };
}

describe("a claim across a restart (boot code)", () => {
  it("a resumed process reads the earlier cookie's code only with the same secret", () => {
    const { cookie } = claimed();
    const resumed = createBootCode(undefined, Date.now, { resumable: true, cookieSecret: SECRET });
    expect(resumed.resumable()).toBe(true);
    expect(resumed.cookieCode(cookie)).toBe(CODE);
    const stranger = createBootCode(undefined, Date.now, { resumable: true, cookieSecret: `${SECRET}-other` });
    expect(stranger.cookieCode(cookie)).toBeNull();
    expect(resumed.cookieCode(`${cookie}x`)).toBeNull();
  });

  it("adopts the confirmed code once; then the old cookie is a session again", () => {
    const { cookie } = claimed();
    const resumed = createBootCode(undefined, Date.now, { resumable: true, cookieSecret: SECRET });
    expect(resumed.session(cookie)).toBeNull();
    const fresh = resumed.adopt(CODE);
    expect(fresh).not.toBeNull();
    expect(resumed.resumable()).toBe(false);
    expect(resumed.original()).toBe(CODE);
    expect(resumed.peek()).toBeUndefined();
    expect(resumed.session(cookie)).not.toBeNull();
    expect(resumed.session(fresh ?? "")).not.toBeNull();
    expect(resumed.adopt(CODE)).toBeNull();
  });

  it("an expired cookie is not read", () => {
    let now = 1_000;
    const boot = createBootCode(CODE, () => now, { cookieSecret: SECRET });
    const res = boot.claim(CODE);
    if (!res.ok) throw new Error("claim failed");
    now += 3 * 60 * 60 * 1000;
    const resumed = createBootCode(undefined, () => now, { resumable: true, cookieSecret: SECRET });
    expect(resumed.cookieCode(res.cookie)).toBeNull();
  });

  it("a process that is not resumable never adopts", () => {
    expect(createBootCode(undefined).adopt(CODE)).toBeNull();
    expect(createBootCode(CODE).adopt("other")).toBeNull();
  });
});

describe("a claim across a restart (boot)", () => {
  afterEach(() => _setBootCodeForTests(undefined));
  const dbReady = async (): Promise<EngineMode> => ({ kind: "setup" });

  it("keeps the database's claim: no new code, owner restored", async () => {
    const lines: string[] = [];
    const made = await startFirstRun({
      mode: dbReady,
      setupCodeFromEnv: undefined,
      write: (l) => lines.push(l),
      makeCode: () => "must-not-be-made",
      cookieSecret: SECRET,
      heldClaim: async () => ({ held: true, owner: "o@example.com" }),
    });
    expect(made).toBe(false);
    expect(lines.join("")).not.toContain("must-not-be-made");
    expect(lines.join("")).toMatch(/FIRST RUN resumed/);
    expect(bootCode().resumable()).toBe(true);
    expect(bootCode().claimedOwner()).toBe("o@example.com");
  });

  it("makes a new code when the database holds no claim, or cannot say", async () => {
    for (const heldClaim of [
      async () => ({ held: false, owner: null }),
      async () => {
        throw new Error("missing function");
      },
    ]) {
      const made = await startFirstRun({
        mode: dbReady, setupCodeFromEnv: undefined, write: () => undefined, makeCode: () => CODE, cookieSecret: SECRET, heldClaim,
      });
      expect(made).toBe(true);
      expect(bootCode().original()).toBe(CODE);
    }
  });

  it("an empty database always gets a new code", async () => {
    const made = await startFirstRun({
      mode: async () => ({ kind: "setup", databaseMissing: true }),
      setupCodeFromEnv: undefined, write: () => undefined, makeCode: () => CODE,
      heldClaim: async () => ({ held: true, owner: null }),
    });
    expect(made).toBe(true);
  });
});

function resumedWorld(verdict: (code: string) => HeldVerdict) {
  const boot = createBootCode(undefined, Date.now, { resumable: true, cookieSecret: SECRET });
  const fake = createFakeSupabase();
  const asked: string[] = [];
  const deps: FirstRunRouteDeps = {
    boot: () => boot,
    envCode: undefined,
    mode: async () => ({ kind: "setup" }),
    projectRef: REF,
    kbSchema: "workspace",
    jwtSecret: JWT_SECRET,
    anonKey: ANON_KEY,
    files: () => FILES,
    fetch: fake.fetch,
    onDatabaseReady: () => undefined,
    confirmHeld: async (code) => {
      asked.push(code);
      return verdict(code);
    },
  };
  const app = new Hono();
  app.use("/setup", firstRunGate(() => deps));
  app.use("/setup/*", firstRunGate(() => deps));
  app.route("/setup", makeFirstRunRoutes(() => deps));
  app.get("/setup", (c) => c.text("CLOUDFLARE FORM"));
  const req = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { host: "app-abc.ondigitalocean.app", ...(cookie ? { cookie: `${CLAIM_COOKIE}=${cookie}` } : {}), ...headers } });
  return { boot, req, asked };
}

const right = (code: string): HeldVerdict => (code === CODE ? { ok: true } : { ok: false, locked: false, retryAfterSeconds: 0 });

describe("a claim across a restart (over HTTP)", () => {
  it("the open setup page keeps working with the cookie from before the restart", async () => {
    const { cookie } = claimed();
    const w = resumedWorld(right);
    const res = await w.req("/setup", cookie);
    expect(await res.text()).toBe("CLOUDFLARE FORM");
    expect(w.asked).toEqual([CODE]);
    expect(w.boot.original()).toBe(CODE);
  });

  it("the original code from the log claims again; no new code is needed", async () => {
    const w = resumedWorld(right);
    const res = await w.req(`/setup?code=${CODE}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/kbe_claim=.+HttpOnly; SameSite=Strict/);
    expect(w.boot.original()).toBe(CODE);
  });

  it("a wrong code is refused, and a database lock answers 429", async () => {
    expect((await resumedWorld(right).req("/setup?code=nope")).status).toBe(401);
    const locked = resumedWorld(() => ({ ok: false, locked: true, retryAfterSeconds: 3600 }));
    const res = await locked.req(`/setup?code=${CODE}`);
    expect(res.status).toBe(429);
    expect(locked.boot.resumable()).toBe(true);
  });

  it("without a cookie or code it shows the claim page, which says the code is kept", async () => {
    const html = await (await resumedWorld(right).req("/setup")).text();
    expect(html).toMatch(/Claim this Engine/);
    expect(html).toMatch(/a restart keeps the same code/);
  });
});
