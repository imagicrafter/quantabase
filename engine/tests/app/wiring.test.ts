import { describe, it, expect } from "vitest";
import { app } from "../../src/index.js";

/**
 * The real app, wired as it runs (sign-in settings come from the test
 * environment). Nothing here reaches a database: every request is refused
 * before one would be needed.
 */

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { host: "engine.example.com", ...headers } });

describe("the app screens are mounted behind sign-in", () => {
  it.each(["/app", "/app/reviews", "/app/flagged", "/app/pages"])("%s needs a sign-in", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'/);
  });

  it.each(["/setup/people", "/setup/template", "/setup/model", "/setup/timer", "/setup/backup", "/setup/health"])(
    "%s needs an administrator's sign-in",
    async (path) => {
      expect((await get(path)).status).toBe(401);
    },
  );

  it("refuses the platform's own hostname", async () => {
    const res = await app.request("/app", { headers: { host: "app-abc.ondigitalocean.app" } });
    expect(res.status).toBe(421);
  });

  it("serves the stylesheet under /app too", async () => {
    const res = await get("/app/assets/setup.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("a forged post to the owner screens is refused before anything else", async () => {
    const res = await app.request("/app/reviews/22222222-2222-4222-8222-222222222222/decide", {
      method: "POST",
      headers: { host: "engine.example.com", "content-type": "application/x-www-form-urlencoded" },
      body: "decision=yes",
    });
    expect(res.status).toBe(401);
  });
});
