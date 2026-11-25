import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EngineConfigError,
  parseYaml,
  validateEngineConfigFile,
} from "../../src/config/engine-config.js";

/**
 * Both validators judge every file in config/fixtures the same way
 * (TypeScript half). The Python half is
 * scripts/knowledge/engine_config_fixtures_test.py. Adding a file to
 * config/fixtures/valid or /invalid adds a case to both.
 */
const FIXTURES = fileURLToPath(new URL("../../../config/fixtures/", import.meta.url));

function files(kind: "valid" | "invalid"): readonly string[] {
  return readdirSync(`${FIXTURES}${kind}`)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => `${kind}/${name}`);
}

function judge(path: string): void {
  validateEngineConfigFile(parseYaml(readFileSync(`${FIXTURES}${path}`, "utf8")));
}

describe("config fixtures shared with the Python validator", () => {
  it("holds a real corpus", () => {
    expect(files("valid").length).toBeGreaterThanOrEqual(6);
    expect(files("invalid").length).toBeGreaterThanOrEqual(30);
  });

  it.each(files("valid"))("accepts %s", (path) => {
    expect(() => judge(path)).not.toThrow();
  });

  it.each(files("invalid"))("refuses %s", (path) => {
    expect(() => judge(path)).toThrow(EngineConfigError);
  });

  it("accepts config/engine.example.yaml as a file", () => {
    const text = readFileSync(`${FIXTURES}../engine.example.yaml`, "utf8");
    expect(() => validateEngineConfigFile(parseYaml(text))).not.toThrow();
  });
});
