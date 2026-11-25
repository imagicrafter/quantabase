import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  LEGACY_SENSOR_KINDS,
  LEGACY_SNAPSHOT_KEYS,
  currentSnapshotKey,
  normalizeSensor,
} from "../../src/config/legacy-names.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MAP_FILE = "engine/src/config/legacy-names.ts";
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);

function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });
}

/** Every earlier name, as a whole word. */
const OLD_NAMES = [
  ...Object.keys(LEGACY_SENSOR_KINDS),
  ...Object.keys(LEGACY_SNAPSHOT_KEYS),
];
const OLD_NAME = new RegExp(`\\b(${OLD_NAMES.join("|")})\\b`, "i");

describe("the compatibility map", () => {
  it("still reads every earlier name as today's", () => {
    for (const [old, now] of Object.entries(LEGACY_SENSOR_KINDS)) {
      expect(normalizeSensor(old)).toBe(now);
      expect(normalizeSensor(`${old}:a/b:c`)).toBe(`${now}:a/b:c`);
    }
    for (const [old, now] of Object.entries(LEGACY_SNAPSHOT_KEYS)) {
      expect(currentSnapshotKey(old)).toBe(now);
    }
  });

  it("leaves today's names and unknown names alone", () => {
    for (const name of ["agent_job:x/y", "workshop_jobs", "static", ""]) {
      expect(normalizeSensor(name)).toBe(name);
    }
    for (const key of ["workshop", "client_inboxes", "toString", "__proto__"]) {
      expect(currentSnapshotKey(key)).toBe(key);
    }
    expect(normalizeSensor("toString:x")).toBe("toString:x");
  });

  it("is the only place the earlier names are written", () => {
    const places = [
      "engine/src",
      "engine/tests",
      "engine/public",
      "engine/deploy",
      "config",
      "docs",
      "setup",
      "templates",
      ".claude",
    ];
    const hits = places
      .flatMap(filesUnder)
      .filter((file) => file !== MAP_FILE)
      .filter((file) => OLD_NAME.test(readFileSync(join(ROOT, file), "utf8")));
    expect(hits).toEqual([]);
  });
});
