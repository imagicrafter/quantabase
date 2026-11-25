import { db } from "../db.js";
import { McpAppError } from "../mcp/errors.js";
import { entitySchema, type EntitySchema } from "./templates.js";

/**
 * The templates this Engine uses, chosen on the Template setup screen and
 * stored in the database (engine_templates, migration 0054). Base is always
 * on and never listed. Cached for a minute; a database that cannot answer is
 * an error, never "no templates".
 */

const TTL_MS = 60_000;
let cached: { readonly at: number; readonly names: readonly string[] } | null = null;

async function readChosen(): Promise<readonly string[]> {
  const { data, error } = await db().rpc("engine_templates_get");
  if (error) throw new McpAppError("internal_error", "The Engine's templates could not be read");
  return Array.isArray(data) ? data.map(String) : [];
}

let reader: () => Promise<readonly string[]> = readChosen;

export async function chosenTemplates(): Promise<readonly string[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.names;
  const names = await reader();
  cached = { at: Date.now(), names };
  return names;
}

/** Base plus the chosen templates. Unknown names (a template file removed) are skipped. */
export async function chosenSchema(): Promise<EntitySchema> {
  const names = await chosenTemplates();
  const known = names.filter((n) => {
    try {
      entitySchema([n]);
      return true;
    } catch {
      return false;
    }
  });
  return entitySchema(known);
}

/** Tests only: replace the reader (and drop the cache); pass nothing to restore it. */
export function _setChosenTemplatesForTests(fn?: () => Promise<readonly string[]>): void {
  reader = fn ?? readChosen;
  cached = null;
}
