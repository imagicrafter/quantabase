import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { findRepoDir, migrationsStep, repoSqlFiles } from "../../src/app/db-setup.js";
import type { Mgmt } from "../../src/app/mgmt.js";

/**
 * A migration whose comments were reworded after it was applied (listed in
 * supabase/migrations/reworded.json) still matches the checksum an Engine
 * recorded for its earlier text. Any other change still stops the update.
 */
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function mgmtWith(recorded: Record<string, string>): { mgmt: Mgmt; ran: string[] } {
  const ran: string[] = [];
  const sql = async (query: string) => {
    if (/select filename, checksum from/.test(query)) {
      return Object.entries(recorded).map(([filename, checksum]) => ({ filename, checksum }));
    }
    ran.push(query);
    return [];
  };
  return { mgmt: { sql } as unknown as Mgmt, ran };
}

const step = (mgmt: Mgmt, files: ReturnType<typeof filesOf>) =>
  migrationsStep({ mgmt, files } as unknown as Parameters<typeof migrationsStep>[0]);

function filesOf(list: Array<{ name: string; sql: string; earlier?: string[] }>) {
  return { migrations: () => list, embedSource: () => "" };
}

describe("reworded migrations", () => {
  it("accept the checksum of the earlier text", async () => {
    const { mgmt, ran } = mgmtWith({ "0001_a.sql": sha("-- old\nselect 1;\n") });
    const result = await step(mgmt, filesOf([{ name: "0001_a.sql", sql: "-- new\nselect 1;\n", earlier: [sha("-- old\nselect 1;\n")] }]));
    expect(result.status).toBe("unchanged");
    expect(ran.filter((q) => q.includes("0001_a.sql"))).toEqual([]);
  });

  it("still stop on any other change", async () => {
    const { mgmt } = mgmtWith({ "0001_a.sql": sha("-- other\n") });
    const result = await step(mgmt, filesOf([{ name: "0001_a.sql", sql: "-- new\n", earlier: [sha("-- old\n")] }]));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/different contents/);
  });

  it("are read from the repository's reworded.json", () => {
    const files = repoSqlFiles(findRepoDir() as string).migrations();
    const reworded = files.filter((f) => (f.earlier ?? []).length > 0);
    expect(reworded.length).toBeGreaterThan(0);
    for (const f of reworded) {
      expect(f.earlier).not.toContain(sha(f.sql));
      for (const c of f.earlier ?? []) expect(c).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
