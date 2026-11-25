import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderVault, type BackupPage, type LogEntry } from "../../src/backup/render.js";

/**
 * The backup -> restore round trip, TypeScript half. The fixture in
 * scripts/kbe/tests/fixtures/backup_roundtrip holds the pages (pages.json)
 * and the vault the nightly backup makes of them (vault/). This test keeps
 * vault/ exactly what renderVault writes today; the Python half
 * (scripts/kbe/tests/test_pages_import_backup.py) reads the same vault back
 * with `kbe pages import --from-backup` and checks it against pages.json.
 *
 * After a deliberate change to the renderer, rewrite the vault with
 *   UPDATE_BACKUP_FIXTURE=1 npx vitest run tests/backup/roundtrip-fixture.test.ts
 * and the Python test then says whether a restore still round-trips.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../../../scripts/kbe/tests/fixtures/backup_roundtrip");
const VAULT = join(FIXTURE, "vault");

type Fixture = { now: string; pages: BackupPage[]; log: LogEntry[] };

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("the backup round-trip fixture", () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURE, "pages.json"), "utf8")) as Fixture;
  const files = renderVault({ pages: fixture.pages, log: fixture.log, now: new Date(fixture.now), labels: {} });

  if (process.env["UPDATE_BACKUP_FIXTURE"] === "1") {
    for (const [path, text] of files) {
      const full = join(VAULT, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }

  it("is exactly what renderVault writes for pages.json", () => {
    const onDisk = filesUnder(VAULT).map((f) => relative(VAULT, f).split("\\").join("/")).sort();
    expect(onDisk).toEqual([...files.keys()].sort());
    for (const [path, text] of files) {
      expect(readFileSync(join(VAULT, path), "utf8"), path).toBe(text);
    }
  });

  it("covers two owners, a shared key and two pages with one title", () => {
    const owners = new Set(fixture.pages.map((p) => p.owner));
    expect(owners.size).toBe(2);
    expect(files.has("concepts/Idempotent Import (reader).md")).toBe(true);
    expect(files.has("meetings/Kickoff (owner).md")).toBe(true);
  });
});
