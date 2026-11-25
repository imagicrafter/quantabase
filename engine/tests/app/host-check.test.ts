import { describe, it, expect } from "vitest";
import { checkHostReaches } from "../../src/app/host-check.js";

/**
 * 2026-11-20 cold start: the new hostname answered DigitalOcean's "not found"
 * because the app listed no domains. The Health screen asks the hostname for
 * the curator tick path (the one path Cloudflare sign-in lets through) with no
 * secret: this app answers 401 with its own JSON; anything else is not us.
 */

const ours = () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }), { status: 401, headers: { "content-type": "application/json" } });

describe("does the hostname reach this app", () => {
  it("yes when the app's own refusal comes back; sends no secret and follows no redirect", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const r = await checkHostReaches("engine.example.com", async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return ours();
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://engine.example.com/internal/curator/tick");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(JSON.stringify(calls[0]?.init.headers ?? {})).not.toMatch(/x-kbe-tick/i);
  });

  it("no, naming DigitalOcean, when the edge answers 404", async () => {
    const r = await checkHostReaches("engine.example.com", async () => new Response("not found", { status: 404 }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/404/);
    expect(r.detail).toMatch(/DigitalOcean/);
  });

  it("no when Cloudflare sign-in stops it, when a 401 is not ours, or when the network fails", async () => {
    expect((await checkHostReaches("engine.example.com", async () => new Response("", { status: 302 }))).detail).toMatch(/sign-in/i);
    expect((await checkHostReaches("engine.example.com", async () => new Response("nope", { status: 401 }))).ok).toBe(false);
    const down = await checkHostReaches("engine.example.com", async () => {
      throw new Error("ENOTFOUND engine.example.com");
    });
    expect(down.ok).toBe(false);
    expect(down.detail).toMatch(/could not be reached/);
  });

  it("refuses to call anything but a plain hostname", async () => {
    let called = false;
    const r = await checkHostReaches("evil.example.com/x?", async () => {
      called = true;
      return ours();
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});
