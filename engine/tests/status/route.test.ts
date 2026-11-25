import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { app } from "../../src/index.js";
import { McpAppError } from "../../src/mcp/errors.js";
import type { AccessSettings } from "../../src/config/settings.js";
import { fullStatusConfig } from "./fixtures/config.js";
import {
  ForbiddenError,
  makeStatusRoute,
  type StatusDeps,
} from "../../src/status/route.js";

const NOW = new Date("2026-11-06T20:00:00Z");
const ACCESS: AccessSettings = {
  teamDomain: "https://acme.cloudflareaccess.com",
  aud: "mcp-app-aud",
  statusAud: undefined,
  host: "engine.example.com",
  resourceUrl: "https://engine.example.com/mcp",
  source: "database",
};
const DATA = {
  generated_at: NOW.toISOString(),
  connectors: [],
  review_undecided: 0,
  people: [],
  snapshot: null,
  recent: [],
};

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    verify: async () => ({ email: "owner@example.com" }),
    readStatus: async () => DATA,
    config: async () => fullStatusConfig(),
    access: async () => ACCESS,
    now: () => NOW,
    ...over,
  };
}

function call(
  d: StatusDeps,
  headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": "x.y.z" },
) {
  const a = new Hono();
  a.get("/status", makeStatusRoute(d));
  return a.fetch(new Request("http://engine.example.com/status", { headers }));
}

describe("GET /status", () => {
  it("401 without an Access assertion", async () => {
    const res = await call(deps(), {});
    expect(res.status).toBe(401);
  });

  it("verifies against the /status app's AUD, not the MCP app's", async () => {
    let seen = "";
    await call(
      deps({
        verify: async (_a, aud) => {
          seen = aud;
          return { email: "owner@example.com" };
        },
      }),
    );
    expect(seen).toBe(fullStatusConfig().engine.connect.status_page_aud);
    expect(seen).not.toBe(process.env["CF_ACCESS_AUD"]);
    expect(seen).not.toBe(ACCESS.aud);
  });

  it("prefers the stored /status AUD over the config's, and checks the stored issuer", async () => {
    const seen: string[] = [];
    await call(
      deps({
        access: async () => ({ ...ACCESS, statusAud: "stored-status-aud" }),
        verify: async (_a, aud, issuer) => {
          seen.push(aud, issuer);
          return { email: "owner@example.com" };
        },
      }),
    );
    expect(seen).toEqual(["stored-status-aud", ACCESS.teamDomain]);
  });

  it("503 and no sign-in attempt when sign-in is not set up", async () => {
    let verified = false;
    const res = await call(
      deps({
        access: async () => null,
        verify: async () => {
          verified = true;
          return { email: "owner@example.com" };
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Sign-in not set up");
    expect(verified).toBe(false);
  });

  it("a plain not-configured page when no config has been applied", async () => {
    const res = await call(deps({ config: async () => null }));
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Engine not configured");
    expect(html).not.toContain("engine-data");
  });

  it("503 when no sign-in app is known for this page", async () => {
    const cfg = fullStatusConfig();
    const noAud = {
      ...cfg,
      engine: {
        ...cfg.engine,
        connect: { ...cfg.engine.connect, status_page_aud: undefined },
      },
    };
    const res = await call(deps({ config: async () => noAud }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Dashboard not configured");
  });

  it("503 when the page's sign-in app is the /mcp app (no second factor)", async () => {
    let verified = false;
    const res = await call(
      deps({
        access: async () => ({ ...ACCESS, statusAud: ACCESS.aud }),
        verify: async () => {
          verified = true;
          return { email: "owner@example.com" };
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(verified).toBe(false);
  });

  it("503 without detail when the settings cannot be read", async () => {
    const res = await call(
      deps({
        config: async () => {
          throw new Error("password=hunter2 connection refused");
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("hunter2");
  });

  it("draws the title from the applied config", async () => {
    const cfg = fullStatusConfig();
    const renamed = {
      ...cfg,
      dashboard: { ...cfg.dashboard, title: "Birch Lane Engine" },
    };
    const res = await call(deps({ config: async () => renamed }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Birch Lane Engine</title>");
    expect(html).not.toContain("<title>Acme");
  });

  it("401 when the assertion is rejected", async () => {
    const res = await call(
      deps({
        verify: async () => {
          throw new McpAppError("unauthenticated", "bad");
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("503 when Cloudflare cannot be reached", async () => {
    const res = await call(
      deps({
        verify: async () => {
          throw new McpAppError("internal_error", "jwks down");
        },
      }),
    );
    expect(res.status).toBe(503);
  });

  it("403 for a signed-in non-administrator", async () => {
    const res = await call(
      deps({
        readStatus: async () => {
          throw new ForbiddenError("no");
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("503 without database detail when readings fail", async () => {
    const res = await call(
      deps({
        readStatus: async () => {
          throw new Error("password=hunter2 connection refused");
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("hunter2");
  });

  it("200 for an administrator, with a strict CSP and no caching", async () => {
    const res = await call(deps());
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Acme&#39;s Knowledge Base Engine");
    expect(html).toContain('id="engine-data"');
    expect(html).toMatch(/\/status\/assets\/dashboard\.js\?v=[0-9a-f]{12}"/);
  });

  it("the real app rejects the starter domain (421) and asks for sign-in (401)", async () => {
    const wrongHost = await app.fetch(
      new Request("http://kb-engine-abc12.ondigitalocean.app/status", {
        headers: { Host: "kb-engine-abc12.ondigitalocean.app" },
      }),
    );
    expect(wrongHost.status).toBe(421);
    const noAuth = await app.fetch(
      new Request("http://engine.example.com/status", {
        headers: { Host: "engine.example.com" },
      }),
    );
    expect(noAuth.status).toBe(401);
  });

  describe("static assets", () => {
    const get = (path: string) =>
      app.fetch(
        new Request(`http://engine.example.com${path}`, {
          headers: { Host: "engine.example.com" },
        }),
      );

    it("serves the two allowed files with the right type and caching", async () => {
      const js = await get("/status/assets/dashboard.js?v=abc");
      expect(js.status).toBe(200);
      expect(js.headers.get("Content-Type")).toContain("text/javascript");
      expect(js.headers.get("Cache-Control")).toContain("immutable");
      expect(js.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const css = await get("/status/assets/dashboard.css");
      expect(css.status).toBe(200);
      expect(css.headers.get("Content-Type")).toContain("text/css");
      expect(css.headers.get("Cache-Control")).toBe("no-cache");
    });

    it("404 for any other name, including path tricks", async () => {
      for (const path of [
        "/status/assets/engine.yaml",
        "/status/assets/..%2f..%2fengine.yaml",
        "/status/assets/%2e%2e%2fpackage.json",
        "/status/assets/constructor",
        "/status/assets/__proto__",
      ]) {
        const res = await get(path);
        expect(res.status, path).toBe(404);
      }
    });

    it("assets also refuse the starter domain", async () => {
      const res = await app.fetch(
        new Request(
          "http://kb-engine-abc12.ondigitalocean.app/status/assets/dashboard.js",
          {
            headers: { Host: "kb-engine-abc12.ondigitalocean.app" },
          },
        ),
      );
      expect(res.status).toBe(421);
    });
  });
});
