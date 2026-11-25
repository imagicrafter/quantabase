import { afterEach, describe, expect, it, vi } from "vitest";

async function loadEnv(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("KB_SCHEMA", undefined as unknown as string);
  else vi.stubEnv("KB_SCHEMA", value);
  return import("../src/env.js");
}

describe("KB_SCHEMA at boot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to workspace when unset or empty", async () => {
    expect((await loadEnv(undefined)).env.KB_SCHEMA).toBe("workspace");
    expect((await loadEnv("")).env.KB_SCHEMA).toBe("workspace");
  });

  it("uses the name it is given", async () => {
    expect((await loadEnv("kb_acme")).env.KB_SCHEMA).toBe("kb_acme");
  });

  it.each(["public", "pg_catalog", "Kb-Acme", "auth", "kb acme"])(
    "refuses to boot with %j instead of falling back",
    async (name) => {
      await expect(loadEnv(name)).rejects.toThrow(/KB_SCHEMA/);
    },
  );
});
