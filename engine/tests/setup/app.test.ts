import { afterEach, describe, it, expect } from "vitest";
import { app } from "../../src/index.js";
import {
  _setSettingsStoreForTests,
  accessFromEnv,
  createSettingsStore,
} from "../../src/config/settings.js";
import { _resetRateLimitsForTests } from "../../src/http/rate-limit.js";
import { _setSetupDepsForTests } from "../../src/setup/defaults.js";
import { createFakeCloudflare, GOOD_TOKEN } from "./fake-cloudflare.js";
import { createFakeDb } from "./fake-db.js";
import { CHOICES, CODE, ENGINE_HOST, hidden, PLATFORM_HOST } from "./world.js";

// These run against the real app (src/index.ts): the real middleware order,
// the real setup-mode check, the real settings store. Only the database and
// Cloudflare are stand-ins.

let ip = 0;
/** A fresh client address per test, so the rate limiter starts clean. */
const freshIp = () => "198.51.100." + ((ip += 1) % 250);

function useEngine(
  options: { setupCode?: string | null; envAccess?: boolean } = {},
) {
  const clock = { now: Date.now() };
  const db = createFakeDb(CODE, clock);
  const cloudflare = createFakeCloudflare();
  _setSettingsStoreForTests(
    createSettingsStore({
      read: db.readPublic,
      envAccess: options.envAccess
        ? accessFromEnv({
            CF_ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
            CF_ACCESS_AUD: "test-aud-tag",
            OAUTH_RESOURCE_URL: "https://engine.example.com/mcp",
            EXPECTED_HOST: ENGINE_HOST,
          })
        : null,
    }),
  );
  _setSetupDepsForTests({
    setupCode:
      options.setupCode === null ? undefined : (options.setupCode ?? CODE),
    ownerEmail: async () => "owner@example.com",
    lockout: {
      attemptCheck: db.attemptCheck,
      attemptFail: db.attemptFail,
      codeValid: db.codeValid,
    },
    complete: db.complete,
    cloudflareFetch: cloudflare.fetch,
  });
  const address = freshIp();
  const get = (
    path: string,
    host: string,
    headers: Record<string, string> = {},
  ) =>
    app.fetch(
      new Request("http://" + host + path, {
        headers: { Host: host, "X-Forwarded-For": address, ...headers },
      }),
    );
  const post = (
    path: string,
    host: string,
    body: string,
    type = "application/x-www-form-urlencoded",
    headers: Record<string, string> = {},
  ) =>
    app.fetch(
      new Request("http://" + host + path, {
        method: "POST",
        headers: {
          Host: host,
          "Content-Type": type,
          "X-Forwarded-For": address,
          ...headers,
        },
        body,
      }),
    );
  const form = (fields: Record<string, string>) =>
    new URLSearchParams(fields).toString();
  return { db, cloudflare, get, post, form };
}

afterEach(() => {
  _setSettingsStoreForTests();
  _setSetupDepsForTests();
  _resetRateLimitsForTests();
});

const MCP_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "tools/list",
  id: 1,
});

describe("setup mode: no sign-in settings anywhere", () => {
  it("answers only /health and /setup", async () => {
    const engine = useEngine();
    expect((await engine.get("/health", "anything.example")).status).toBe(200);
    const setup = await engine.get("/setup", PLATFORM_HOST);
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain('action="/setup/preview"');
    expect(
      (await engine.get("/setup/assets/setup.css", PLATFORM_HOST)).status,
    ).toBe(200);
  });

  it.each([
    "/mcp",
    "/status",
    "/status/assets/dashboard.js",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/",
    "/setupx",
    "/setup-old",
    "/anything/else",
  ])("answers %s with a plain 503", async (path) => {
    const engine = useEngine();
    for (const host of [PLATFORM_HOST, ENGINE_HOST, "localhost"]) {
      const res = await engine.get(path, host, {
        "Cf-Access-Jwt-Assertion": "a.b.c",
      });
      expect(res.status, host + path).toBe(503);
      expect(await res.text()).toBe("setup not complete");
    }
  });

  it("refuses POST /mcp with 503, with or without an assertion", async () => {
    const engine = useEngine();
    for (const headers of [{}, { "Cf-Access-Jwt-Assertion": "a.b.c" }]) {
      const res = await engine.post(
        "/mcp",
        PLATFORM_HOST,
        MCP_BODY,
        "application/json",
        headers,
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("setup not complete");
    }
  });

  it("serves the setup page on whatever hostname the request arrived on", async () => {
    const engine = useEngine();
    for (const host of [
      PLATFORM_HOST,
      "another-name.example.net",
      "localhost",
    ]) {
      expect((await engine.get("/setup", host)).status, host).toBe(200);
    }
  });

  it("answers /setup with 503 when the app has no setup code", async () => {
    const engine = useEngine({ setupCode: null });
    const res = await engine.get("/setup", PLATFORM_HOST);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("<form");
    const post = await engine.post(
      "/setup/preview",
      PLATFORM_HOST,
      engine.form({ ...CHOICES, code: CODE }),
    );
    expect(post.status).toBe(503);
  });

  it("serves the stylesheet and nothing else from /setup/assets", async () => {
    const engine = useEngine();
    const css = await engine.get("/setup/assets/setup.css", PLATFORM_HOST);
    expect(css.headers.get("Content-Type")).toContain("text/css");
    for (const name of [
      "setup.js",
      "..%2f..%2fpackage.json",
      "../setup.css",
      ".env",
    ]) {
      const res = await engine.get("/setup/assets/" + name, PLATFORM_HOST);
      expect(res.status, name).toBe(404);
    }
  });

  it("limits the size of a form post", async () => {
    const engine = useEngine();
    const res = await engine.post(
      "/setup/preview",
      PLATFORM_HOST,
      engine.form({ ...CHOICES, code: CODE, emails: "x".repeat(40_000) }),
    );
    expect(res.status).toBe(413);
    expect(engine.db.calls.check).toBe(0);
  });

  it("rate-limits the setup routes before any code is checked", async () => {
    const engine = useEngine();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await engine.post(
        "/setup/preview",
        PLATFORM_HOST,
        engine.form({ ...CHOICES, code: "guess-" + i }),
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
    expect(engine.db.calls.check).toBeLessThanOrEqual(20);
  });

  it("caps form posts across all clients, whatever address they claim", async () => {
    const engine = useEngine();
    const statuses: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      const res = await app.fetch(
        new Request("http://" + PLATFORM_HOST + "/setup/preview", {
          method: "POST",
          headers: {
            Host: PLATFORM_HOST,
            "Content-Type": "application/x-www-form-urlencoded",
            // A different claimed address every time.
            "X-Forwarded-For": "203.0.113." + i,
          },
          body: engine.form({ ...CHOICES, code: "guess-" + i }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10);
    // The page itself (a GET) still opens.
    expect((await engine.get("/setup", PLATFORM_HOST)).status).toBe(200);
  });

  it("sends the security headers on the setup page", async () => {
    const engine = useEngine();
    const res = await engine.get("/setup", PLATFORM_HOST);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    // ...and every other route keeps the stricter default.
    expect(
      (await engine.get("/health", PLATFORM_HOST)).headers.get(
        "Referrer-Policy",
      ),
    ).toBe("no-referrer");
  });
});

describe("stored sign-in settings that are present but unusable", () => {
  // Not "not set up": a damaged row must not reopen the setup page.
  it.each([
    {
      team_domain: "https://keys.attacker.example",
      aud: "x",
      host: "h.example.com",
    },
    { aud: "only-an-aud" },
    "not-an-object",
    {},
  ])("answer 503 everywhere, the setup page included: %j", async (access) => {
    const engine = useEngine();
    _setSettingsStoreForTests(
      createSettingsStore({
        read: async () => ({ config: null, access, setup_state: "open" }),
        envAccess: null,
      }),
    );
    for (const path of [
      "/setup",
      "/mcp",
      "/status",
      "/setup/assets/setup.css",
    ]) {
      const res = await engine.get(path, PLATFORM_HOST);
      expect(res.status, path).toBe(503);
      expect(await res.text()).not.toContain("<form");
    }
    const post = await engine.post(
      "/setup/preview",
      PLATFORM_HOST,
      engine.form({ ...CHOICES, code: CODE }),
    );
    expect(post.status).toBe(503);
    expect(engine.db.calls.check).toBe(0);
    expect((await engine.get("/health", PLATFORM_HOST)).status).toBe(200);
  });
});

describe("a deployment that sets the sign-in variables", () => {
  it("is never in setup mode, even with setup_state 'open' and nothing stored", async () => {
    const engine = useEngine({ envAccess: true });
    expect(engine.db.row.setup_state).toBe("open");
    expect(engine.db.row.access).toBeNull();

    // /mcp asks for sign-in exactly as before.
    const mcp = await engine.post(
      "/mcp",
      ENGINE_HOST,
      MCP_BODY,
      "application/json",
    );
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://engine.example.com/.well-known/oauth-protected-resource"',
    );
    // The host check is in force.
    expect(
      (await engine.post("/mcp", PLATFORM_HOST, MCP_BODY, "application/json"))
        .status,
    ).toBe(421);
    // Discovery is served.
    const meta = await engine.get(
      "/.well-known/oauth-protected-resource",
      ENGINE_HOST,
    );
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      resource: "https://engine.example.com/mcp",
    });
  });

  it("does not read the database to decide", async () => {
    const engine = useEngine({ envAccess: true });
    let reads = 0;
    _setSettingsStoreForTests(
      createSettingsStore({
        read: async () => {
          reads += 1;
          throw new Error("database down");
        },
        envAccess: accessFromEnv({
          CF_ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
          CF_ACCESS_AUD: "test-aud-tag",
          OAUTH_RESOURCE_URL: "https://engine.example.com/mcp",
          EXPECTED_HOST: ENGINE_HOST,
        }),
      }),
    );
    expect(
      (await engine.post("/mcp", ENGINE_HOST, MCP_BODY, "application/json"))
        .status,
    ).toBe(401);
    expect(reads).toBe(0);
  });

  it("does not offer the setup form: not on the platform hostname, not without sign-in", async () => {
    const engine = useEngine({ envAccess: true });
    expect((await engine.get("/setup", PLATFORM_HOST)).status).toBe(421);
    const res = await engine.get("/setup", ENGINE_HOST);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("<form");
    const post = await engine.post(
      "/setup/preview",
      ENGINE_HOST,
      engine.form({ ...CHOICES, code: CODE }),
    );
    expect(post.status).toBe(401);
    expect(engine.db.calls.check).toBe(0);
  });
});

describe("the full round trip", () => {
  it("setup mode -> apply -> the Engine leaves setup mode -> /mcp demands a valid assertion", async () => {
    const engine = useEngine();

    // 1. Setup mode: nothing but /health and /setup.
    const before = await engine.post(
      "/mcp",
      PLATFORM_HOST,
      MCP_BODY,
      "application/json",
    );
    expect(before.status).toBe(503);
    expect(await before.text()).toBe("setup not complete");

    // 2. Preview, then apply, on the platform hostname.
    const preview = await engine.post(
      "/setup/preview",
      PLATFORM_HOST,
      engine.form({ ...CHOICES, code: CODE }),
    );
    expect(preview.status).toBe(200);
    const html = await preview.text();
    const apply = await engine.post(
      "/setup/apply",
      PLATFORM_HOST,
      engine.form({
        inputs: hidden(html, "inputs"),
        sig: hidden(html, "sig"),
        code: CODE,
        cf_token: GOOD_TOKEN,
      }),
    );
    expect(apply.status).toBe(200);
    expect(await apply.text()).toContain("https://engine.example.com/mcp");

    // 3. What was stored is exactly what the sign-in check reads.
    const [engineApp, adminApp] = engine.cloudflare.state.apps;
    expect(engine.db.row.access).toEqual({
      team_domain: "https://acme.cloudflareaccess.com",
      aud: engineApp?.["aud"],
      status_aud: adminApp?.["aud"],
      host: ENGINE_HOST,
      resource_url: "https://engine.example.com/mcp",
      level: "people",
      session: "8760h",
    });

    // 4. No restart: the very next request is out of setup mode.
    //    The platform hostname is no longer answered...
    const onPlatform = await engine.post(
      "/mcp",
      PLATFORM_HOST,
      MCP_BODY,
      "application/json",
    );
    expect(onPlatform.status).toBe(421);
    expect((await engine.get("/setup", PLATFORM_HOST)).status).toBe(421);

    //    ...and on the new hostname /mcp demands an assertion.
    const noAssertion = await engine.post(
      "/mcp",
      ENGINE_HOST,
      MCP_BODY,
      "application/json",
    );
    expect(noAssertion.status).toBe(401);
    expect(noAssertion.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://engine.example.com/.well-known/oauth-protected-resource"',
    );
    const badAssertion = await engine.post(
      "/mcp",
      ENGINE_HOST,
      MCP_BODY,
      "application/json",
      {
        "Cf-Access-Jwt-Assertion": "not-a-jwt",
      },
    );
    expect(badAssertion.status).toBe(401);

    // 5. Discovery now names the team domain that was read back.
    const meta = await engine.get(
      "/.well-known/oauth-protected-resource",
      ENGINE_HOST,
    );
    expect(await meta.json()).toEqual({
      resource: "https://engine.example.com/mcp",
      authorization_servers: ["https://acme.cloudflareaccess.com"],
      bearer_methods_supported: ["header"],
    });

    // 6. /status and /setup are now behind sign-in.
    expect((await engine.get("/status", ENGINE_HOST)).status).toBe(401);
    const setup = await engine.get("/setup", ENGINE_HOST);
    expect(setup.status).toBe(401);
    expect(await setup.text()).not.toContain("<form");

    // 7. The code is spent.
    const replay = await engine.post(
      "/setup/preview",
      ENGINE_HOST,
      engine.form({ ...CHOICES, code: CODE }),
    );
    expect(replay.status).toBe(401);
  });

  it("a failed apply leaves the Engine in setup mode", async () => {
    const engine = useEngine();
    engine.cloudflare.failOn({
      method: "POST",
      path: /\/access\/apps$/,
      status: 500,
    });
    const preview = await engine.post(
      "/setup/preview",
      PLATFORM_HOST,
      engine.form({ ...CHOICES, code: CODE }),
    );
    const html = await preview.text();
    const apply = await engine.post(
      "/setup/apply",
      PLATFORM_HOST,
      engine.form({
        inputs: hidden(html, "inputs"),
        sig: hidden(html, "sig"),
        code: CODE,
        cf_token: GOOD_TOKEN,
      }),
    );
    expect(apply.status).toBe(422);
    const mcp = await engine.post(
      "/mcp",
      PLATFORM_HOST,
      MCP_BODY,
      "application/json",
    );
    expect(mcp.status).toBe(503);
    expect(await mcp.text()).toBe("setup not complete");
    expect((await engine.get("/setup", PLATFORM_HOST)).status).toBe(200);
  });
});
