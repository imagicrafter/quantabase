import { describe, it, expect, vi } from "vitest";
import { app } from "../../src/index.js";

// Guards an earlier production fix: BOTH protected-resource paths must
// return 200 with identical bodies. Without the /mcp-suffixed form, claude.ai 404s
// before token exchange.
//
// NOTE: env vars (EXPECTED_HOST, OAUTH_RESOURCE_URL, CF_ACCESS_TEAM_DOMAIN) are set
// in tests/setup.ts — env.ts parses them once at import time, so vi.stubEnv in
// beforeEach cannot override cached module constants.

describe("OAuth discovery routes", () => {
  it("bare protected-resource returns 200", async () => {
    const req = new Request(
      "http://engine.example.com/.well-known/oauth-protected-resource",
      {
        headers: { Host: "engine.example.com" },
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
  });

  it("path-suffixed protected-resource returns 200 with identical body", async () => {
    const req1 = new Request(
      "http://engine.example.com/.well-known/oauth-protected-resource",
      {
        headers: { Host: "engine.example.com" },
      },
    );
    const req2 = new Request(
      "http://engine.example.com/.well-known/oauth-protected-resource/mcp",
      {
        headers: { Host: "engine.example.com" },
      },
    );

    const [res1, res2] = await Promise.all([app.fetch(req1), app.fetch(req2)]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
    expect(body1).toEqual(body2);
  });

  it("protected-resource body contains resource and authorization_servers", async () => {
    const req = new Request(
      "http://engine.example.com/.well-known/oauth-protected-resource",
      {
        headers: { Host: "engine.example.com" },
      },
    );
    const res = await app.fetch(req);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["resource"]).toBe("https://engine.example.com/mcp");
    expect(Array.isArray(body["authorization_servers"])).toBe(true);
    expect((body["authorization_servers"] as string[])[0]).toBe(
      "https://test.cloudflareaccess.com",
    );
  });

  it("well-known routes carry CORS headers (permissive origin)", async () => {
    const req = new Request(
      "http://engine.example.com/.well-known/oauth-protected-resource",
      {
        headers: {
          Origin: "https://claude.ai",
          Host: "engine.example.com",
        },
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  it("AS metadata proxy returns 502 when Cloudflare Access is unreachable", async () => {
    // Stub fetch to simulate a network error on the proxy call
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED"));

    const req = new Request(
      "http://engine.example.com/.well-known/oauth-authorization-server",
      {
        headers: { Host: "engine.example.com" },
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(502);

    globalThis.fetch = originalFetch;
  });
});
