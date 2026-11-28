import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

/**
 * GET /setup/assets/:file. Serves the setup page's stylesheet (and the copy-button script) from
 * engine/public/setup/. The name is looked up in an allowlist and never
 * joined into a path, so there is nothing for a hostile request to traverse.
 * The file holds nothing private: it is served in setup mode with no sign-in.
 */

const FILES = {
  "setup.css": "text/css; charset=utf-8",
  // The copy buttons on the rule screen (no data, no inline script).
  "copy.js": "text/javascript; charset=utf-8",
} as const;
type AssetName = keyof typeof FILES;

const isAsset = (name: string): name is AssetName =>
  Object.prototype.hasOwnProperty.call(FILES, name);

const DIR = fileURLToPath(new URL("../../public/setup/", import.meta.url));
const cache = new Map<AssetName, Buffer>();

function read(name: AssetName): Buffer {
  const hit = cache.get(name);
  if (hit) return hit;
  const body = readFileSync(`${DIR}${name}`);
  cache.set(name, body);
  return body;
}

/** Changes exactly when the stylesheet changes. */
export function setupAssetVersion(): string {
  return createHash("sha256")
    .update(read("setup.css"))
    .digest("hex")
    .slice(0, 12);
}

export function setupAssets(c: Context) {
  const name = c.req.param("file") ?? "";
  if (!isAsset(name)) return c.text("Not found", 404);
  c.header("Content-Type", FILES[name]);
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Cache-Control",
    c.req.query("v") ? "public, max-age=31536000, immutable" : "no-cache",
  );
  return c.body(new Uint8Array(read(name)));
}
