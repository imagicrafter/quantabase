import { afterEach, describe, it, expect } from "vitest";
import { app } from "../../src/index.js";
import {
  _setSettingsStoreForTests,
  createSettingsStore,
} from "../../src/config/settings.js";

// FAIL CLOSED. The sign-in variables are optional now, so an Engine can boot
// with none. These tests pin what that must mean: with no sign-in settings in
// the environment AND none in the database, every protected route refuses. It
// must never fall through to "no check configured, so let it in".

const STORED = {
  team_domain: "https://acme.cloudflareaccess.com",
  aud: "stored-aud",
  host: "stored.example.com",
};

function useDatabaseOnly(read: () => Promise<unknown>) {
  _setSettingsStoreForTests(createSettingsStore({ read, envAccess: null }));
}

const get = (
  path: string,
  host: string,
  headers: Record<string, string> = {},
) =>
  app.fetch(
    new Request(`http://${host}${path}`, {
      headers: { Host: host, ...headers },
    }),
  );

const postMcp = (host: string, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://${host}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: host, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    }),
  );

afterEach(() => _setSettingsStoreForTests());

describe("an Engine with no sign-in settings anywhere", () => {
  const nothing = async () => ({
    config: null,
    access: null,
    setup_state: "open",
  });

  it("refuses /mcp with 503, with or without an assertion", async () => {
    useDatabaseOnly(nothing);
    for (const headers of [{}, { "Cf-Access-Jwt-Assertion": "a.b.c" }]) {
      const res = await postMcp("engine.example.com", headers);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("setup not complete");
    }
  });

  it("refuses /mcp on localhost too", async () => {
    useDatabaseOnly(nothing);
    expect((await postMcp("localhost")).status).toBe(503);
  });

  it("refuses /status and its assets with 503", async () => {
    useDatabaseOnly(nothing);
    expect((await get("/status", "engine.example.com")).status).toBe(503);
    expect(
      (await get("/status/assets/dashboard.js", "engine.example.com")).status,
    ).toBe(503);
  });

  it("serves no discovery documents", async () => {
    useDatabaseOnly(nothing);
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect((await get(path, "engine.example.com")).status, path).toBe(503);
    }
  });

  it("still answers the health check", async () => {
    useDatabaseOnly(nothing);
    expect((await get("/health", "anything.example")).status).toBe(200);
  });
});

describe("an Engine whose settings cannot be read", () => {
  it("refuses with 503 and leaks no detail", async () => {
    useDatabaseOnly(async () => {
      throw new Error("password=hunter2 connection refused");
    });
    const res = await postMcp("engine.example.com", {
      "Cf-Access-Jwt-Assertion": "a.b.c",
    });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("hunter2");
  });
});

describe("an Engine whose stored sign-in settings are not trustworthy", () => {
  it("is treated as not set up when the team domain is not Cloudflare's", async () => {
    useDatabaseOnly(async () => ({
      access: { ...STORED, team_domain: "https://keys.attacker.example" },
    }));
    expect((await postMcp("stored.example.com")).status).toBe(503);
  });
});

describe("an Engine that takes its sign-in settings from the database", () => {
  const stored = async () => ({ config: null, access: STORED });

  it("answers only to the stored host", async () => {
    useDatabaseOnly(stored);
    expect((await postMcp("engine.example.com")).status).toBe(421);
    expect((await postMcp("app-1234.ondigitalocean.app")).status).toBe(421);
  });

  it("asks for sign-in (401) and points at the stored resource", async () => {
    useDatabaseOnly(stored);
    const res = await postMcp("stored.example.com");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://stored.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("rejects an assertion that does not verify (401, never 200)", async () => {
    useDatabaseOnly(stored);
    const res = await postMcp("stored.example.com", {
      "Cf-Access-Jwt-Assertion": "not-a-jwt",
    });
    expect(res.status).toBe(401);
  });

  it("serves the discovery document from the stored settings", async () => {
    useDatabaseOnly(stored);
    const res = await get(
      "/.well-known/oauth-protected-resource",
      "stored.example.com",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://stored.example.com/mcp",
      authorization_servers: ["https://acme.cloudflareaccess.com"],
      bearer_methods_supported: ["header"],
    });
  });
});
