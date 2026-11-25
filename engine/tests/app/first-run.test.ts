import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { claimCookie, createBootCode, readCookie, CLAIM_COOKIE } from "../../src/app/boot-code.js";
import { createCsrf } from "../../src/app/csrf.js";
import { diffHtml, lineDiff } from "../../src/app/diff.js";
import { _setBootCodeForTests, bootCode, startFirstRun } from "../../src/app/first-run.js";
import { claimFormToken, firstRunGate, makeFirstRunRoutes, type FirstRunRouteDeps } from "../../src/app/first-run-routes.js";
import { _captureLogsForTests, logger } from "../../src/log/logger.js";
import type { EngineMode } from "../../src/setup/mode.js";
import { ANON_KEY, createFakeSupabase, FILES, JWT_SECRET, MGMT_TOKEN, REF } from "./fake-supabase.js";

const CODE = "first-run-code-AbCdEfGh0123456789_xyz";

describe("the first-run code", () => {
  it("claims once, then is spent", () => {
    const boot = createBootCode(CODE);
    expect(boot.peek()).toBe(CODE);
    const first = boot.claim(CODE);
    expect(first.ok).toBe(true);
    expect(boot.peek()).toBeUndefined();
    expect(boot.original()).toBe(CODE);
    const second = boot.claim(CODE);
    expect(second).toMatchObject({ ok: false, reason: "spent" });
  });

  it("locks one client after five wrong codes, even for the right one", () => {
    let now = 1_000;
    const boot = createBootCode(CODE, () => now);
    for (let i = 0; i < 4; i += 1) expect(boot.claim("wrong", "1.1.1.1")).toMatchObject({ reason: "wrong" });
    expect(boot.claim("wrong", "1.1.1.1")).toMatchObject({ reason: "locked" });
    expect(boot.claim(CODE, "1.1.1.1")).toMatchObject({ ok: false, reason: "locked" });
    now += 61 * 60 * 1000;
    expect(boot.claim(CODE, "1.1.1.1").ok).toBe(true);
  });

  it("a stranger's wrong codes do not lock the owner out", () => {
    const boot = createBootCode(CODE);
    for (let i = 0; i < 10; i += 1) boot.claim("wrong", "6.6.6.6");
    expect(boot.claim(CODE, "6.6.6.6")).toMatchObject({ reason: "locked" });
    expect(boot.claim(CODE, "2.2.2.2").ok).toBe(true);
  });

  it("a global ceiling locks everyone when many clients guess", () => {
    const boot = createBootCode(CODE);
    for (let i = 0; i < 100; i += 1) boot.claim("wrong", `10.0.${Math.floor(i / 4)}.${i % 4}`);
    expect(boot.claim(CODE, "2.2.2.2")).toMatchObject({ ok: false, reason: "locked" });
  });


  it("does nothing without a code", () => {
    expect(createBootCode(undefined).claim("anything")).toMatchObject({ ok: false, reason: "none" });
  });

  it("gives a session cookie that only this process accepts, until it expires", () => {
    let now = 1_000;
    const boot = createBootCode(CODE, () => now);
    const res = boot.claim(CODE);
    if (!res.ok) throw new Error("claim failed");
    expect(boot.session(res.cookie)).not.toBeNull();
    expect(boot.session(`${res.cookie}x`)).toBeNull();
    expect(boot.session(res.cookie.replace(/^./, "A"))).toBeNull();
    const other = createBootCode(CODE, () => now);
    other.claim(CODE);
    expect(other.session(res.cookie)).toBeNull();
    now += 3 * 60 * 60 * 1000;
    expect(boot.session(res.cookie)).toBeNull();
  });

  it("sets a strict, http-only cookie on /setup only", () => {
    const c = claimCookie("v", true);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\/setup/);
    expect(c).toMatch(/Secure/);
    expect(readCookie(`a=1; ${CLAIM_COOKIE}=xyz; b=2`, CLAIM_COOKIE)).toBe("xyz");
  });
});

describe("making the code at boot", () => {
  afterEach(() => _setBootCodeForTests(undefined));

  const setupMode = async (): Promise<EngineMode> => ({ kind: "setup", databaseMissing: true });

  it("makes and writes one code for a new Engine, then keeps it out of every other log line", async () => {
    const lines: string[] = [];
    const made = await startFirstRun({ mode: setupMode, setupCodeFromEnv: undefined, write: (l) => lines.push(l), makeCode: () => CODE });
    expect(made).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`/setup?code=${CODE}`);
    expect(bootCode().original()).toBe(CODE);
    const logs = _captureLogsForTests();
    try {
      logger.info({ note: `leaked ${CODE}` }, `also ${CODE}`);
      expect(logs.lines().join("\n")).not.toContain(CODE);
    } finally {
      logs.stop();
    }
  });

  it("makes none when SETUP_CODE was deployed, when set up, or when the database cannot say", async () => {
    const write = () => {
      throw new Error("must not write");
    };
    expect(await startFirstRun({ mode: setupMode, setupCodeFromEnv: "deployed-code", write })).toBe(false);
    const ready = async (): Promise<EngineMode> => ({ kind: "ready", access: {} as never, setupOpen: false });
    expect(await startFirstRun({ mode: ready, setupCodeFromEnv: undefined, write })).toBe(false);
    const broken = async (): Promise<EngineMode> => {
      throw new Error("db down");
    };
    expect(await startFirstRun({ mode: broken, setupCodeFromEnv: undefined, write })).toBe(false);
    expect(bootCode().original()).toBeUndefined();
  });
});

describe("forms and diffs", () => {
  it("form tokens are tied to the person, the form and the hour", () => {
    let now = 0;
    const csrf = createCsrf("x".repeat(40), () => now);
    const t = csrf.token("a@b.com", "model");
    expect(csrf.check("a@b.com", "model", t)).toBe(true);
    expect(csrf.check("A@B.com", "model", t)).toBe(true);
    expect(csrf.check("c@b.com", "model", t)).toBe(false);
    expect(csrf.check("a@b.com", "timer", t)).toBe(false);
    expect(csrf.check("a@b.com", "model", undefined)).toBe(false);
    now += 90 * 60 * 1000;
    expect(csrf.check("a@b.com", "model", t)).toBe(true);
    now += 2 * 60 * 60 * 1000;
    expect(csrf.check("a@b.com", "model", t)).toBe(false);
  });

  it("diffs lines and escapes them", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "x" }, { kind: "same", text: "c" },
    ]);
    expect(diffHtml(lineDiff("<a>", "<b>"))).toContain("- &lt;a&gt;");
    expect(diffHtml(lineDiff("same", "same"))).toMatch(/No change/);
  });
});

// ── the claim and Database screens over HTTP ────────────────────────────────

function world(over: Partial<FirstRunRouteDeps> = {}) {
  const boot = createBootCode(CODE);
  const fake = createFakeSupabase();
  const mode = { current: { kind: "setup", databaseMissing: true } as EngineMode };
  const seen = { ready: 0 };
  const deps: FirstRunRouteDeps = {
    boot: () => boot,
    envCode: undefined,
    mode: async () => mode.current,
    projectRef: REF,
    kbSchema: "workspace",
    jwtSecret: JWT_SECRET,
    anonKey: ANON_KEY,
    files: () => FILES,
    fetch: fake.fetch,
    onDatabaseReady: () => {
      seen.ready += 1;
      mode.current = { kind: "setup" };
    },
    ...over,
  };
  const app = new Hono();
  app.use("/setup", firstRunGate(() => deps));
  app.use("/setup/*", firstRunGate(() => deps));
  app.route("/setup", makeFirstRunRoutes(() => deps));
  // Stand-ins for the existing Cloudflare screen.
  app.get("/setup", (c) => c.text("CLOUDFLARE FORM"));
  app.post("/setup/preview", (c) => c.text("PREVIEW"));
  let cookie = "";
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { host: "app-abc.ondigitalocean.app", ...(cookie ? { cookie: `${CLAIM_COOKIE}=${cookie}` } : {}), ...(init.headers as Record<string, string>) },
    });
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    req(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  return {
    deps, fake, mode, seen, boot, req, post,
    setCookie: (v: string) => {
      cookie = v;
    },
    claim: async () => {
      const res = await req(`/setup?code=${CODE}`);
      cookie = /kbe_claim=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
      return res;
    },
    cookie: () => cookie,
  };
}

describe("claiming over HTTP", () => {
  it("shows the claim page, not the Cloudflare form, before a claim", async () => {
    const w = world();
    const html = await (await w.req("/setup")).text();
    expect(html).toMatch(/Claim this Engine/);
    expect(html).not.toContain(CODE);
    expect((await w.post("/setup/preview", {})).status).toBe(401);
    expect((await w.req("/setup/database")).status).toBe(200);
    expect(await (await w.req("/setup/database")).text()).toMatch(/Claim this Engine/);
  });

  it("claims with /setup?code=, sets the cookie, and takes the code off the address", async () => {
    const w = world();
    const res = await w.claim();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/database");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    expect(w.cookie()).not.toBe("");
    // Spent: a second claim, even with the right code, is refused.
    w.setCookie("");
    expect((await w.req(`/setup?code=${CODE}`)).status).toBe(409);
  });

  it("the first-run Database screen links the token page and the project", async () => {
    const w = world();
    await w.claim();
    const html = await (await w.req("/setup/database")).text();
    expect(html).toContain('href="https://supabase.com/dashboard/account/tokens"');
    expect(html).toContain(`href="https://supabase.com/dashboard/project/${REF}"`);
  });

  it("refuses a wrong code and counts it", async () => {
    const w = world();
    expect((await w.req("/setup?code=nope")).status).toBe(401);
    // Five wrong codes from one address lock that address only.
    for (let i = 0; i < 5; i += 1) await w.req("/setup?code=nope", { headers: { "cf-connecting-ip": "6.6.6.6" } });
    expect((await w.req(`/setup?code=${CODE}`, { headers: { "cf-connecting-ip": "6.6.6.6" } })).status).toBe(429);
    expect((await w.post("/setup/claim", { code: "nope" })).status).toBe(401);
    expect((await w.post("/setup/claim", { code: CODE }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await w.post("/setup/claim", { code: CODE })).status).toBe(303);
  });

  it("sends a claimed person to the Database screen while the database is empty, then lets the sign-in screen run", async () => {
    const w = world();
    await w.claim();
    const before = await w.req("/setup");
    expect(before.status).toBe(303);
    expect(before.headers.get("location")).toBe("/setup/database");
    w.mode.current = { kind: "setup" };
    expect(await (await w.req("/setup")).text()).toBe("CLOUDFLARE FORM");
  });

  it("stays out of the way when SETUP_CODE was deployed or the Engine is set up", async () => {
    const w = world({ envCode: "deployed" });
    expect(await (await w.req("/setup")).text()).toBe("CLOUDFLARE FORM");
    const ready = world();
    ready.mode.current = { kind: "ready", access: {} as never, setupOpen: false };
    expect(await (await ready.req("/setup")).text()).toBe("CLOUDFLARE FORM");
  });

  it("closes the claim and Database screens once the Engine is set up", async () => {
    const w = world();
    await w.claim();
    w.mode.current = { kind: "ready", access: {} as never, setupOpen: false };
    expect((await w.req("/setup/database")).status).toBe(404);
    expect((await w.post("/setup/claim", { code: CODE })).status).toBe(404);
    expect((await w.post("/setup/database", { owner_email: "o@example.com", ref: REF, access_token: MGMT_TOKEN })).status).toBe(404);
    expect(w.fake.state.requests).toHaveLength(0);
  });
});

describe("the Database screen over HTTP", () => {
  async function formToken(w: ReturnType<typeof world>) {
    const html = await (await w.req("/setup/database")).text();
    return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  }

  it("sets up the project, never shows the token, and records the owner", async () => {
    const w = world();
    await w.claim();
    const csrf = await formToken(w);
    expect(csrf).toBe(claimFormToken(w.cookie(), "database"));
    const logs = _captureLogsForTests();
    let html = "";
    try {
      const res = await w.post("/setup/database", { csrf, owner_email: "Owner@Example.com", ref: REF, access_token: MGMT_TOKEN });
      html = await res.text();
      expect(res.status).toBe(200);
      expect(logs.lines().join("\n")).not.toContain(MGMT_TOKEN);
    } finally {
      logs.stop();
    }
    expect(html).toMatch(/Database is ready/);
    expect(html).not.toContain(MGMT_TOKEN);
    expect(w.boot.claimedOwner()).toBe("owner@example.com");
    expect(w.seen.ready).toBe(1);
    expect(w.fake.state.principals.admins).toEqual(["owner@example.com"]);
  });

  it("refuses another project's ref, a bad email, a missing form token, and a post without a claim", async () => {
    const w = world();
    await w.claim();
    const csrf = await formToken(w);
    const other = await w.post("/setup/database", { csrf, owner_email: "o@example.com", ref: "zzzzzzzzzzzzzzzzzzzz", access_token: MGMT_TOKEN });
    expect(other.status).toBe(400);
    expect(await other.text()).toMatch(/not the project this app is deployed with/);
    expect((await w.post("/setup/database", { csrf, owner_email: "nope", ref: REF, access_token: MGMT_TOKEN })).status).toBe(400);
    expect((await w.post("/setup/database", { owner_email: "o@example.com", ref: REF, access_token: MGMT_TOKEN })).status).toBe(403);
    w.setCookie("");
    expect((await w.post("/setup/database", { csrf, owner_email: "o@example.com", ref: REF, access_token: MGMT_TOKEN })).status).toBe(401);
    expect(w.fake.state.requests).toHaveLength(0);
  });

  it("shows which step failed and keeps the claim", async () => {
    const w = world({ jwtSecret: "wrong-secret-for-this-project-000000" });
    await w.claim();
    const csrf = await formToken(w);
    const res = await w.post("/setup/database", { csrf, owner_email: "o@example.com", ref: REF, access_token: MGMT_TOKEN });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toMatch(/SUPABASE_JWT_SECRET is not this project/);
    expect(html).not.toContain(MGMT_TOKEN);
    expect(w.seen.ready).toBe(0);
  });

  it("shows a done state when opened again after it succeeded, with a way to run it again", async () => {
    const w = world();
    await w.claim();
    const csrf = await formToken(w);
    const logs = _captureLogsForTests();
    try {
      await w.post("/setup/database", { csrf, owner_email: "o@example.com", ref: REF, access_token: MGMT_TOKEN });
      // Each step's time is in the log line, and the total.
      const line = logs.lines().find((l) => l.includes("database setup finished")) ?? "";
      expect(line).toMatch(/"total_ms":\d+/);
      expect(line).toMatch(/migrations:(done|unchanged):\d+ms/);
    } finally {
      logs.stop();
    }
    w.mode.current = { kind: "setup" };
    const again = await w.req("/setup/database");
    expect(again.status).toBe(200);
    const html = await again.text();
    expect(html).toMatch(/The database is set up/);
    expect(html).toMatch(/Check the Supabase project/);
    expect(html).toContain('href="/setup"');
    expect(html).toContain('href="/setup/database?again=1"');
    expect(html).not.toContain('name="access_token"');
    const form = await (await w.req("/setup/database?again=1")).text();
    expect(form).toContain('name="access_token"');
  });

  it("says plainly when the app was built without the SQL files", async () => {
    const w = world({ files: () => null });
    await w.claim();
    const csrf = await formToken(w);
    const res = await w.post("/setup/database", { csrf, owner_email: "o@example.com", ref: REF, access_token: MGMT_TOKEN });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/kbe db migrate/);
  });

  it("asks what pages should call you, and stores it with the owner", async () => {
    const w = world();
    await w.claim();
    const html = await (await w.req("/setup/database")).text();
    expect(html).toContain("What should your pages call you?");
    expect(html).toMatch(/name="owner_name"[^>]*maxlength="60"/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const res = await w.post("/setup/database", { csrf, owner_email: "ann@example.com", owner_name: "  Ann ", ref: REF, access_token: MGMT_TOKEN });
    expect(res.status).toBe(200);
    expect(w.fake.state.principals.names.get("ann@example.com")).toEqual({ display: "Ann", page: "Ann" });
  });

  it("refuses a name that is too long or has a line break, and keeps what was typed", async () => {
    const w = world();
    await w.claim();
    const csrf = await formToken(w);
    for (const bad of ["a".repeat(61), "Ann\nRULES"]) {
      const res = await w.post("/setup/database", { csrf, owner_email: "ann@example.com", owner_name: bad, ref: REF, access_token: MGMT_TOKEN });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toMatch(/1 to 60 characters/);
      expect(text).toMatch(/value="ann(?:@|&#64;)example.com"/);
    }
    expect(w.fake.state.requests).toHaveLength(0);
  });
});
