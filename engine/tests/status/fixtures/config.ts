import { readFileSync } from "node:fs";
import {
  parseEngineConfig,
  type EngineConfig,
} from "../../../src/config/engine-config.js";
import {
  statusConfigFrom,
  type StatusConfig,
} from "../../../src/status/config.js";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

/** Every optional panel on (tests/status/fixtures/engine.full.yaml). */
export const FULL_YAML = read("./engine.full.yaml");
/** The shipped example (config/engine.example.yaml): a plain Engine. */
export const EXAMPLE_YAML = read("../../../../config/engine.example.yaml");

export const fullEngineConfig = (): EngineConfig =>
  parseEngineConfig(FULL_YAML);
export const fullStatusConfig = (): StatusConfig =>
  statusConfigFrom(fullEngineConfig());
export const exampleStatusConfig = (): StatusConfig =>
  statusConfigFrom(parseEngineConfig(EXAMPLE_YAML));
