import { describe, it, expect } from "vitest";
import { app } from "../../src/index.js";

// Guards an earlier production fix: CORS on /mcp must be set BEFORE
// requireAuth so that:
//   (a) OPTIONS preflights are answered without auth
//   (b) 401 responses carry CORS headers + exposed WWW-Authenticate
//
// NOTE: env vars are set in tests/setup.ts — see comment in discovery.test.ts.

describe("CORS on /mcp", () => {
  it("OPTIONS /mcp answers with 2xx (preflight)", async () => {
    const req = new Request("http://engine.example.com/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://claude.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "Cf-Access-Jwt-Assertion, Content-Type",
        Host: "engine.example.com",
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Access-Control-Allow-Methods")).toMatch(/POST/);
    expect(res.headers.get("Access-Control-Allow-Headers")).toMatch(
      /Cf-Access-Jwt-Assertion/i,
    );
  });

  it("401 response carries Access-Control-Allow-Origin", async () => {
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
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  it("401 response exposes WWW-Authenticate in Access-Control-Expose-Headers", async () => {
    const req = new Request("http://engine.example.com/mcp", {
      method: "POST",
      headers: {
        Origin: "https://claude.ai",
        Host: "engine.example.com",
      },
      body: "{}",
    });

    const res = await app.fetch(req);
    const expose = res.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(expose).toMatch(/WWW-Authenticate/i);
    expect(expose).toMatch(/Mcp-Session-Id/i);
  });
});
