import { afterEach, describe, it, expect, vi } from "vitest";

// env.ts parses process.env once at import time, so each case resets modules
// and imports it again after setting SETUP_CODE.
async function setupCodeFrom(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv("SETUP_CODE", value);
  const { env } = await import("../../src/env.js");
  return env.SETUP_CODE;
}

describe("SETUP_CODE", () => {
  afterEach(() => vi.unstubAllEnvs());

  const good = "Abc-123_" + "x".repeat(32);

  it("is optional: unset, empty and blank all mean 'no setup code'", async () => {
    expect(await setupCodeFrom(undefined)).toBeUndefined();
    expect(await setupCodeFrom("")).toBeUndefined();
    expect(await setupCodeFrom("   ")).toBeUndefined();
  });

  it("accepts a long code of letters, digits, '-' and '_'", async () => {
    expect(await setupCodeFrom(good)).toBe(good);
  });

  it("drops space around the code, so a pasted line break cannot lock the owner out", async () => {
    expect(await setupCodeFrom("  " + good + "\n")).toBe(good);
  });

  it.each([
    ["too short", "short-code"],
    ["31 characters", "a".repeat(31)],
    ["a quote in it", '"' + "a".repeat(40)],
    ["a backslash in it", "a".repeat(20) + "\\" + "a".repeat(20)],
    ["a space inside", "a".repeat(20) + " " + "a".repeat(20)],
    ["too long", "a".repeat(257)],
  ])("refuses to start with a code that has %s", async (_what, value) => {
    await expect(setupCodeFrom(value)).rejects.toThrow(/SETUP_CODE/);
  });

  it("does not print the bad code in the error", async () => {
    const bad = '"' + "secret-ish-value-that-is-wrong".repeat(2);
    await expect(setupCodeFrom(bad)).rejects.not.toThrow(/secret-ish/);
  });
});
