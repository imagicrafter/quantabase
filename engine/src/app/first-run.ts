import { env } from "../env.js";
import { allowOutboundHost } from "../http/outbound-allowlist.js";
import { addLogSecret, logger } from "../log/logger.js";
import type { EngineMode } from "../setup/mode.js";
import { createBootCode, newCode, type BootCode } from "./boot-code.js";
import { heldClaim } from "../setup/db.js";

/**
 * The process-wide first-run code (see boot-code.ts).
 *
 * Made at boot only when the Engine is not set up AND no SETUP_CODE was
 * deployed (an operator who ran `kbe access init` keeps that route). It is
 * written to stdout once, as the only line that may ever hold it; the logger
 * scrubs it from every other line.
 */

export const SUPABASE_API_HOST = "api.supabase.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";

let current: BootCode = createBootCode(undefined);

export function bootCode(): BootCode {
  return current;
}

/** Tests only: replace the process-wide code. */
export function _setBootCodeForTests(code: BootCode | undefined): void {
  current = code ?? createBootCode(undefined);
}

export type FirstRunDeps = {
  readonly mode: () => Promise<EngineMode>;
  readonly setupCodeFromEnv: string | undefined;
  readonly write: (line: string) => void;
  readonly makeCode?: () => string;
  /** Stable secret for the claim cookie, so a claim outlives a restart. */
  readonly cookieSecret?: string;
  /**
   * What the database holds of an earlier claim: whether its setup window is
   * open with a stored code hash (the Database screen ran), and the owner.
   * Absent or failing means nothing is held.
   */
  readonly heldClaim?: () => Promise<{ readonly held: boolean; readonly owner: string | null }>;
};

async function held(deps: FirstRunDeps): Promise<{ held: boolean; owner: string | null }> {
  if (!deps.heldClaim) return { held: false, owner: null };
  try {
    const h = await deps.heldClaim();
    return { held: h.held === true, owner: h.owner ?? null };
  } catch {
    return { held: false, owner: null };
  }
}

/** Decide at boot whether to make a first-run code. Returns true when one was made. */
export async function startFirstRun(deps: FirstRunDeps): Promise<boolean> {
  if (deps.setupCodeFromEnv) return false;
  let mode: EngineMode;
  try {
    mode = await deps.mode();
  } catch (err) {
    // FAIL CLOSED: a database that cannot be read is not a new Engine.
    logger.error({ err: err instanceof Error ? err.message : "unknown" }, "first run: settings unreadable; no setup code made");
    return false;
  }
  if (mode.kind !== "setup") return false;
  allowOutboundHost(SUPABASE_API_HOST);
  allowOutboundHost(CLOUDFLARE_API_HOST);
  if (!mode.databaseMissing) {
    const earlier = await held(deps);
    if (earlier.held) {
      // The database holds the claim: keep the original code (no new one).
      current = createBootCode(undefined, Date.now, { resumable: true, cookieSecret: deps.cookieSecret });
      if (earlier.owner) current.setOwner(earlier.owner);
      deps.write(
        `${JSON.stringify({
          level: 30,
          time: Date.now(),
          service: "kb-engine",
          msg: "FIRST RUN resumed: the database holds this Engine's claim. Your open setup page keeps working; otherwise open /setup?code= with the code from the first FIRST RUN line.",
        })}\n`,
      );
      return false;
    }
  }
  const code = (deps.makeCode ?? newCode)();
  addLogSecret(code);
  current = createBootCode(code, Date.now, { cookieSecret: deps.cookieSecret });
  deps.write(
    `${JSON.stringify({
      level: 40,
      time: Date.now(),
      service: "kb-engine",
      msg: `FIRST RUN: open https://<this app's address>/setup?code=${code} to claim this Engine. The code works once.`,
    })}\n`,
  );
  return true;
}

export const liveFirstRunDeps = (mode: () => Promise<EngineMode>): FirstRunDeps => ({
  mode,
  setupCodeFromEnv: env.SETUP_CODE,
  write: (line) => process.stdout.write(line),
  cookieSecret: env.SUPABASE_JWT_SECRET,
  heldClaim,
});
