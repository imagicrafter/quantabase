import { db } from "../../db.js";
import { logger } from "../../log/logger.js";
import { mapDbError } from "../db-error.js";

const NOT_ACTIVE = "Your account is not active on this Engine";

/**
 * Call one page function. The signed-in subject is always the first argument
 * and always comes from the session, never from a tool argument; the
 * database resolves it to an active person and applies the access rule.
 * Errors raised on purpose (22023, 42501) are passed on; anything else is
 * hidden behind `fallback`. The log line holds the function and error code
 * only, never arguments (they hold page and mail text).
 */
export async function pageRpc(
  fn: string,
  sub: string,
  args: Readonly<Record<string, unknown>>,
  fallback: string,
): Promise<unknown> {
  const { data, error } = await db().rpc(fn, { p_oauth_subject: sub, ...args });
  if (error) {
    logger.warn({ fn, code: error.code }, "page RPC failed");
    throw mapDbError(error, NOT_ACTIVE, fallback);
  }
  return data;
}

export function rowsOf(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}
