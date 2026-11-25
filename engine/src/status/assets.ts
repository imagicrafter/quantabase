import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

/**
 * GET /status/assets/:file. Serves exactly two files from engine/public/status/.
 * The name is looked up in an allowlist and never joined into a path, so there
 * is nothing for a hostile request to traverse. Cloudflare Access fronts the
 * whole /status path, so these sit behind the same sign-in as the page.
 */

const FILES = {
  "dashboard.css": "text/css; charset=utf-8",
  "dashboard.js": "text/javascript; charset=utf-8",
} as const;

type AssetName = keyof typeof FILES;

const isAsset = (name: string): name is AssetName =>
  Object.prototype.hasOwnProperty.call(FILES, name);

const DIR = fileURLToPath(new URL("../../public/status/", import.meta.url));
const cache = new Map<AssetName, Buffer>();

function read(name: AssetName): Buffer {
  const hit = cache.get(name);
  if (hit) return hit;
  const body = readFileSync(`${DIR}${name}`);
  cache.set(name, body);
  return body;
}

/**
 * Cache-busting version: a short hash of the two files themselves. It changes
 * exactly when the files change, and does not depend on a deploy variable.
 */
export function assetVersion(): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(FILES) as AssetName[]) hash.update(read(name));
  return hash.digest("hex").slice(0, 12);
}

export function statusAssets(c: Context) {
  const name = c.req.param("file") ?? "";
  if (!isAsset(name)) return c.text("Not found", 404);
  const version = c.req.query("v");
  const longLived = Boolean(version) && version !== "dev";
  c.header("Content-Type", FILES[name]);
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Cache-Control",
    longLived ? "public, max-age=31536000, immutable" : "no-cache",
  );
  return c.body(new Uint8Array(read(name)));
}
