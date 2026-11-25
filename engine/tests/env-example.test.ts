import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENV_KEYS } from "../src/env.js";

/**
 * engine/.env.example must name every variable the service reads, and hold
 * no real value. A line may be on (`KEY=value`) or off (`# KEY=value`).
 */
const LINE = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;

type Entry = {
  readonly key: string;
  readonly on: boolean;
  readonly value: string;
};

const entries: readonly Entry[] = readFileSync(
  new URL("../.env.example", import.meta.url),
  "utf8",
)
  .split("\n")
  .flatMap((line) => {
    const match = LINE.exec(line.trim());
    return match
      ? [{ key: match[2]!, on: !match[1], value: match[3]!.trim() }]
      : [];
  });

const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_JWT_SECRET",
  "EMBED_TOKEN",
];
/** Values that are plainly not secrets and may be written out. */
const PLAIN =
  /^(|\d+|development|production|test|info|example\.com,example\.org)$/;

describe("engine/.env.example", () => {
  it("lists every variable the service reads", () => {
    const listed = new Set(entries.map((e) => e.key));
    expect(ENV_KEYS.filter((key) => !listed.has(key))).toEqual([]);
  });

  it("lists nothing the service does not read", () => {
    expect(
      entries.map((e) => e.key).filter((k) => !ENV_KEYS.includes(k)),
    ).toEqual([]);
  });

  it("lists each variable once", () => {
    const keys = entries.map((e) => e.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it("turns on only the required variables, so a copied file has no stray optional value", () => {
    expect(
      entries
        .filter((e) => e.on)
        .map((e) => e.key)
        .sort(),
    ).toEqual([...REQUIRED].sort());
  });

  it("holds placeholders only: every value is empty, plain, or has a <placeholder>", () => {
    const real = entries.filter(
      (e) => !PLAIN.test(e.value) && !/<[^<>]+>/.test(e.value),
    );
    expect(real).toEqual([]);
  });
});
