import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderVault, type BackupPage, type LogEntry } from "../../src/backup/render.js";

/**
 * The backup -> restore round trip, TypeScript half. Each fixture in
 * scripts/kbe/tests/fixtures (backup_roundtrip, backup_split) holds the pages
 * (pages.json) and the vault the nightly backup makes of them (vault/). This
 * test keeps vault/ exactly what renderVault writes today; the Python half
 * (scripts/kbe/tests/test_pages_import_backup.py, and
 * test_pages_import_split_backup.py for a page an import split into linked
 * parts) reads the same vault back with `kbe pages import --from-backup` and
 * checks it against pages.json.
 *
 * After a deliberate change to the renderer, rewrite the vault with
 *   UPDATE_BACKUP_FIXTURE=1 npx vitest run tests/backup/roundtrip-fixture.test.ts
 * and the Python test then says whether a restore still round-trips.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../../scripts/kbe/tests/fixtures");

type Fixture = { now: string; pages: BackupPage[]; log: LogEntry[] };

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function render(name: string): { fixture: Fixture; files: ReadonlyMap<string, string>; vault: string } {
  const dir = join(FIXTURES, name);
  const fixture = JSON.parse(readFileSync(join(dir, "pages.json"), "utf8")) as Fixture;
  const files = renderVault({ pages: fixture.pages, log: fixture.log, now: new Date(fixture.now), labels: {} });
  const vault = join(dir, "vault");
  if (process.env["UPDATE_BACKUP_FIXTURE"] === "1") {
    for (const [path, text] of files) {
      const full = join(vault, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  return { fixture, files, vault };
}

describe.each(["backup_roundtrip", "backup_split"])("the %s fixture", (name) => {
  const { files, vault } = render(name);

  it("is exactly what renderVault writes for pages.json", () => {
    const onDisk = filesUnder(vault).map((f) => relative(vault, f).split("\\").join("/")).sort();
    expect(onDisk).toEqual([...files.keys()].sort());
    for (const [path, text] of files) {
      expect(readFileSync(join(vault, path), "utf8"), path).toBe(text);
    }
  });
});

describe("the backup round-trip fixture", () => {
  const { fixture, files } = render("backup_roundtrip");

  it("covers two owners, a shared key and two pages with one title", () => {
    const owners = new Set(fixture.pages.map((p) => p.owner));
    expect(owners.size).toBe(2);
    expect(files.has("concepts/Idempotent Import (reader).md")).toBe(true);
    expect(files.has("meetings/Kickoff (owner).md")).toBe(true);
  });
});

describe("the split-parts fixture", () => {
  const { files } = render("backup_split");

  it("keeps each part's link lines, naming the file the backup gave the part", () => {
    const one = files.get("meetings/Long Call.md") ?? "";
    expect(one).toContain("> Continued in [[Long Call (part 2) (owner)|Long Call (part 2)]]");
    const three = files.get("meetings/Long Call (part 3).md") ?? "";
    expect(three).toContain("\n\n> Continued from [[Long Call (part 2) (owner)|Long Call (part 2)]]\n\nthe end, no newline\n");
  });
});
