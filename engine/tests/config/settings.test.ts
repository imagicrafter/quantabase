import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { missingAccessKeys } from "../../src/env.js";
import {
  SettingsUnavailableError,
  accessFromDatabase,
  accessFromEnv,
  createSettingsStore,
} from "../../src/config/settings.js";

const EXAMPLE = parse(
  readFileSync(
    new URL("../../../config/engine.example.yaml", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const STORED = {
  team_domain: "https://acme.cloudflareaccess.com",
  aud: "mcp-aud",
  status_aud: "status-aud",
  host: "engine.example.com",
  level: "owner",
};

const ENV = {
  CF_ACCESS_TEAM_DOMAIN: "https://env.cloudflareaccess.com",
  CF_ACCESS_AUD: "env-aud",
  OAUTH_RESOURCE_URL: "https://env.example.com/mcp",
  EXPECTED_HOST: "env.example.com",
};

describe("sign-in settings from the environment", () => {
  it("are used when all four variables are set", () => {
    expect(accessFromEnv(ENV)).toEqual({
      teamDomain: "https://env.cloudflareaccess.com",
      aud: "env-aud",
      statusAud: undefined,
      host: "env.example.com",
      resourceUrl: "https://env.example.com/mcp",
      source: "environment",
    });
  });

  it("are absent when none is set", () => {
    expect(accessFromEnv({})).toBeNull();
  });

  it("a partial set is named so boot can fail on it", () => {
    expect(missingAccessKeys({})).toEqual([]);
    expect(missingAccessKeys(ENV)).toEqual([]);
    expect(
      missingAccessKeys({ CF_ACCESS_AUD: "x", EXPECTED_HOST: "h" }),
    ).toEqual(["CF_ACCESS_TEAM_DOMAIN", "OAUTH_RESOURCE_URL"]);
  });
});

describe("sign-in settings from the database", () => {
  it("are read from the stored row", () => {
    expect(accessFromDatabase(STORED)).toEqual({
      teamDomain: "https://acme.cloudflareaccess.com",
      aud: "mcp-aud",
      statusAud: "status-aud",
      host: "engine.example.com",
      resourceUrl: "https://engine.example.com/mcp",
      source: "database",
      level: "owner",
    });
  });

  it("are absent when nothing is stored", () => {
    expect(accessFromDatabase(null)).toBeNull();
    expect(accessFromDatabase(undefined)).toBeNull();
  });

  it("are refused, not half-used, when the stored row is incomplete", () => {
    expect(accessFromDatabase({ ...STORED, aud: "" })).toBeNull();
    expect(accessFromDatabase({ aud: "only" })).toBeNull();
    expect(accessFromDatabase("https://acme.cloudflareaccess.com")).toBeNull();
  });

  it("refuse a team domain that is not a Cloudflare Access team domain", () => {
    for (const team_domain of [
      "https://keys.attacker.example",
      "http://acme.cloudflareaccess.com",
      "https://cloudflareaccess.com.attacker.example",
    ]) {
      expect(accessFromDatabase({ ...STORED, team_domain })).toBeNull();
    }
  });
});

describe("the settings store", () => {
  const row = { config: EXAMPLE, access: STORED, setup_state: "complete" };

  it("reads config and sign-in settings from the database", async () => {
    const store = createSettingsStore({
      read: async () => row,
      envAccess: null,
    });
    const settings = await store.get();
    expect(settings.config?.engine.name).toBe("Acme's Knowledge Base Engine");
    expect(settings.access?.source).toBe("database");
    expect(settings.setupState).toBe("complete");
  });

  it("caches the read for a minute, then reads again", async () => {
    let reads = 0;
    let clock = 0;
    const store = createSettingsStore({
      read: async () => {
        reads += 1;
        return row;
      },
      envAccess: null,
      now: () => clock,
    });
    await store.get();
    clock = 59_000;
    await store.get();
    await store.access();
    expect(reads).toBe(1);
    clock = 61_000;
    await store.get();
    expect(reads).toBe(2);
  });

  it("prefers the environment and then never asks the database for sign-in", async () => {
    let reads = 0;
    const store = createSettingsStore({
      read: async () => {
        reads += 1;
        return row;
      },
      envAccess: accessFromEnv(ENV),
    });
    expect((await store.access())?.aud).toBe("env-aud");
    expect(reads).toBe(0);
    expect((await store.get()).access?.aud).toBe("env-aud");
  });

  it("has no sign-in settings when neither source has them", async () => {
    const store = createSettingsStore({
      read: async () => ({ config: null, access: null, setup_state: "open" }),
      envAccess: null,
    });
    expect(await store.access()).toBeNull();
    expect((await store.get()).config).toBeNull();
  });

  it("treats an invalid stored config as not configured", async () => {
    const store = createSettingsStore({
      read: async () => ({ ...row, config: { version: 1 } }),
      envAccess: null,
    });
    expect((await store.get()).config).toBeNull();
  });

  it("throws, and does not cache, when the database cannot be read", async () => {
    let fail = true;
    const store = createSettingsStore({
      read: async () => {
        if (fail) throw new Error("connection refused");
        return row;
      },
      envAccess: null,
    });
    await expect(store.get()).rejects.toBeInstanceOf(SettingsUnavailableError);
    await expect(store.access()).rejects.toBeInstanceOf(
      SettingsUnavailableError,
    );
    fail = false;
    expect((await store.access())?.aud).toBe("mcp-aud");
  });
});
