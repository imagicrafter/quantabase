import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  SCHEMA_PATH,
  buildConfigSchemaText,
} from "../../scripts/gen-config-schema.js";

describe("config/schema.json", () => {
  it("matches the zod schema (run `npm run gen:schema` if this fails)", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(buildConfigSchemaText());
  });

  it("describes the top-level sections", () => {
    const schema = JSON.parse(buildConfigSchemaText()) as {
      definitions: { EngineConfig: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(schema.definitions.EngineConfig.properties)).toEqual([
      "version",
      "engine",
      "domains",
      "tagging",
      "sources",
      "models",
      "dashboard",
      "support",
    ]);
  });
});
