import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../src/version.js";

describe("the service version", () => {
  it("is the repository's VERSION file", () => {
    const written = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();
    expect(written).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    expect(ENGINE_VERSION).toBe(written);
  });
});
