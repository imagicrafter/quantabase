import { db } from "../../db.js";
import { logger } from "../../log/logger.js";

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;

type Entry = { readonly value: boolean; readonly at: number };

let cache: ReadonlyMap<string, Entry> = new Map();

/** For tests. */
export function clearAdminCache(): void {
  cache = new Map();
}

/**
 * Whether to LIST the admin tools for this caller. This is not a guard: every
 * admin function re-checks the caller in the database. It only keeps tools a
 * person cannot use out of their tool list.
 *
 * FAIL CLOSED: if the answer cannot be read, the tools are not listed. The
 * answer is remembered for a minute, so a change of role shows up in the
 * tool list within a minute (and in the database guard at once).
 */
export async function isAdministrator(
  email: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let data: unknown;
  try {
    const res = await db()
      .rpc("admin_is_administrator", { p_email: email });
    if (res.error) {
      logger.warn({ code: res.error.code }, "admin_is_administrator failed");
      return false;
    }
    data = res.data;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "admin_is_administrator unavailable",
    );
    return false;
  }

  const value = data === true;
  const kept = cache.size >= MAX_ENTRIES ? [] : [...cache];
  cache = new Map([...kept, [key, { value, at: now }]]);
  return value;
}
