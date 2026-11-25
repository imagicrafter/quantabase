import { describe, it, expect } from "vitest";
import { app } from "../../src/index.js";

// The critical regression this suite guards: a 401 on /mcp must carry
// WWW-Authenticate with resource_metadata. Without it, a fresh MCP client
// cannot discover where to authenticate. This is the connector's first request.
//
// NOTE: env vars are set in tests/setup.ts — see comment in discovery.test.ts.

describe("requireAuth middleware", () => {
  it("returns 401 with WWW-Authenticate carrying resource_metadata for missing Cf-Access-Jwt-Assertion", async () => {
    const req = new Request("http://engine.example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "engine.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAuth).toMatch(/Bearer/);
    expect(wwwAuth).toMatch(/resource_metadata=/);
    expect(wwwAuth).toContain("engine.example.com");
  });

  it("returns 401 with WWW-Authenticate for a non-verifying Cf-Access-Jwt-Assertion", async () => {
    const req = new Request("http://engine.example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": "hello-this-is-not-a-jwt",
        Host: "engine.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    const res = await app.fetch(req);
    // Must be 401, never 200-with-zero-results. This guards decision 7.
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAuth).toMatch(/resource_metadata=/);
  });

  it("returns 401 for a request carrying only a bare Authorization bearer (no origin bypass)", async () => {
    const req = new Request("http://engine.example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hello-this-is-not-a-jwt",
        Host: "engine.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    const res = await app.fetch(req);
    // Authorization is no longer read at all — only Cf-Access-Jwt-Assertion
    // authenticates. A bare Authorization header must still 401.
    expect(res.status).toBe(401);
  });

  it("OPTIONS /mcp returns 200 (CORS preflight answered)", async () => {
    const req = new Request("http://engine.example.com/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://claude.ai",
        "Access-Control-Request-Method": "POST",
        Host: "engine.example.com",
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBeLessThan(300);
  });

  it("401 on /mcp carries CORS headers (browser can read WWW-Authenticate)", async () => {
    const req = new Request("http://engine.example.com/mcp", {
      method: "POST",
      headers: {
        Origin: "https://claude.ai",
        "Content-Type": "application/json",
        Host: "engine.example.com",
      },
      body: "{}",
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);
    // Browser must be able to read WWW-Authenticate — it's in exposeHeaders.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Access-Control-Expose-Headers")).toMatch(
      /WWW-Authenticate/i,
    );
  });
});
