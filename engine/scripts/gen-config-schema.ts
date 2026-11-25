/**
 * Generate config/schema.json from the zod schema, so editors and the setup
 * guide describe exactly what the Engine accepts.
 *
 *   npm run gen:schema
 *
 * tests/config/schema-json.test.ts fails when the committed file is stale.
 * Cross-field rules (unique topics, known default_domain, ...) are enforced
 * by the validators, not expressible here.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { EngineConfigJsonShape } from "../src/config/engine-config.js";

export const SCHEMA_PATH = fileURLToPath(
  new URL("../../config/schema.json", import.meta.url),
);

/** The exact text of config/schema.json. */
export function buildConfigSchemaText(): string {
  const schema = zodToJsonSchema(EngineConfigJsonShape, {
    name: "EngineConfig",
    $refStrategy: "none",
  });
  const titled = {
    title: "kb-engine config (.kb-engine/engine.yaml)",
    ...schema,
  };
  return `${JSON.stringify(titled, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SCHEMA_PATH, buildConfigSchemaText());
  process.stdout.write(`wrote ${SCHEMA_PATH}\n`);
}
