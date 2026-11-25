/**
 * The release this service is: the `version` in engine/package.json, which a
 * test keeps equal to the repository's VERSION file.
 *
 * Read once at start. package.json sits one folder above both `src/` (tests,
 * `npm run dev`) and `dist/` (the built service).
 */
import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export const ENGINE_VERSION: string = readVersion();
