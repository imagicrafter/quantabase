import { db } from "../db.js";
import type { StoredAccess } from "./apply.js";
import { parseLockState, type LockState } from "./setup-code.js";

/**
 * The setup page's calls into the database. Each is one SECURITY DEFINER
 * function (migrations 0029, 0033, 0034); the service holds no table grant.
 *
 * FAIL CLOSED: every function throws when the database does not give a clean
 * answer. Callers turn that into a 503; none of them guesses.
 */

const DB_TIMEOUT_MS = 10_000;

async function rpc(
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  // A timeout on every call: code checks run one at a time, so one call that
  // never returned would hold up every later one.
  const { data, error } = await db()
    .rpc(name, args)
    .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
  // Only the SQLSTATE is kept: a database message is not for a web page.
  if (error) throw new Error(`${name} failed (${error.code ?? "no code"})`);
  return data;
}

export async function attemptCheck(): Promise<LockState> {
  return parseLockState(await rpc("engine_setup_attempt_check"));
}

export async function attemptFail(): Promise<LockState> {
  return parseLockState(await rpc("engine_setup_attempt_fail"));
}

/**
 * What the database holds of a first-run claim after the Database screen ran
 * (migration 0057): whether the setup window is open with a stored code hash,
 * and the owner it named. Lets a restarted app keep the claim.
 */
export async function heldClaim(): Promise<{ held: boolean; owner: string | null }> {
  const raw = (await rpc("engine_setup_claim_held")) as Record<string, unknown> | null;
  const owner = typeof raw?.["owner"] === "string" ? (raw["owner"] as string) : null;
  return { held: raw?.["held"] === true, owner };
}

export async function codeValid(code: string): Promise<boolean> {
  return (await rpc("engine_setup_code_valid", { p_code: code })) === true;
}

/** Spend the code and store the sign-in settings. False when refused. */
export async function completeSetup(
  code: string,
  access: StoredAccess,
): Promise<boolean> {
  return (
    (await rpc("engine_setup_complete", { p_code: code, p_access: access })) ===
    true
  );
}

/** Asked fresh every time: an administrator who is removed loses the page at once. */
export async function isAdministrator(email: string): Promise<boolean> {
  return (await rpc("admin_is_administrator", { p_email: email })) === true;
}
