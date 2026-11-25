import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Approvals, releases and the app's settings writes happen only on the app
 * screens. No MCP tool may reach the functions behind them, and the
 * OAuth-subject versions (which an MCP tool could call) are gone (0054).
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const APP_ONLY = /["'`](app_[a-z_]+|curator_review_decide|source_item_release|curator_review_list)["'`]/;

describe("the MCP boundary", () => {
  it("no tool, MCP or curator module names an app-only database function", () => {
    const outside = files(SRC).filter((p) => !p.includes(join("src", "app") + "/"));
    const hits = outside.filter((p) => APP_ONLY.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the app module is the one place that calls them", () => {
    const store = readFileSync(join(SRC, "app", "store.ts"), "utf8");
    expect(store).toContain('"app_review_decide"');
    expect(store).toContain('"app_flagged_release"');
  });
});
