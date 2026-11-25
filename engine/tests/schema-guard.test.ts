import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Product code must not name the schema. It calls db() (src/db.ts), which
// reads KB_SCHEMA. Only kb-schema.ts may spell the default name out.
const SRC = join(import.meta.dirname, "..", "src");
const ALLOWED = new Set(["kb-schema.ts"]);
const HARD_CODED = [
  /\.schema\(\s*["'`]workspace["'`]\s*\)/,
  /["'`]workspace["'`]/,
  /["'`][^"'`\n]*\bworkspace\.[a-z_]/,
];

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

/** Lines of code only: block and line comments are documentation. */
function codeLines(text: string): readonly string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""));
}

function problems(text: string): readonly string[] {
  return codeLines(text).flatMap((line, index) =>
    HARD_CODED.some((pattern) => pattern.test(line))
      ? [`line ${index + 1}: ${line.trim()}`]
      : [],
  );
}

describe("the schema name is never hard-coded in src/", () => {
  it("sees each kind of hard-coding", () => {
    expect(problems('supabase.schema("workspace").rpc("x")')).toHaveLength(1);
    expect(problems("supabase\n  .schema('workspace')")).toHaveLength(1);
    expect(problems('const q = "select * from workspace.documents";')).toHaveLength(1);
    expect(problems('headers["Content-Profile"] = "workspace";')).toHaveLength(1);
  });

  it("allows comments and partial words", () => {
    expect(problems("// reads workspace.documents")).toEqual([]);
    expect(problems("/** workspace.engine_settings */\nconst a = 1;")).toEqual([]);
    expect(problems('const p = "/workspace/scripts"; const w = "workspace_root";')).toEqual([]);
  });

  it("finds nothing in the product code", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(30);
    const found = files
      .filter((path) => !ALLOWED.has(relative(SRC, path)))
      .flatMap((path) =>
        problems(readFileSync(path, "utf8")).map(
          (problem) => `${relative(SRC, path)} ${problem}`,
        ),
      );
    expect(found).toEqual([]);
  });
});
