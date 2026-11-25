import { afterEach, describe, expect, it, vi } from "vitest";

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v as string);
  return import("../src/env.js");
}

describe("the Updates screen's variables at boot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("QB_RELEASE_REPO defaults to the public repository when unset or empty", async () => {
    expect((await loadEnv({ QB_RELEASE_REPO: undefined })).env.QB_RELEASE_REPO).toBe("imagicrafter/quantabase");
    expect((await loadEnv({ QB_RELEASE_REPO: "" })).env.QB_RELEASE_REPO).toBe("imagicrafter/quantabase");
    expect((await loadEnv({ QB_RELEASE_REPO: "acme/qb-fork" })).env.QB_RELEASE_REPO).toBe("acme/qb-fork");
  });

  it.each(["https://evil.example/x", "acme", "acme/../x", "a/b/c"])("refuses QB_RELEASE_REPO %j", async (v) => {
    await expect(loadEnv({ QB_RELEASE_REPO: v })).rejects.toThrow(/QB_RELEASE_REPO/);
  });

  it("APP_ID is kept only as a UUID; a template or junk reads as unset", async () => {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    expect((await loadEnv({ APP_ID: id })).env.APP_ID).toBe(id);
    expect((await loadEnv({ APP_ID: "${APP_ID}" })).env.APP_ID).toBeUndefined();
    expect((await loadEnv({ APP_ID: "" })).env.APP_ID).toBeUndefined();
    expect((await loadEnv({ APP_ID: "nope" })).env.APP_ID).toBeUndefined();
  });
});
