import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The one-time setup code.
 *
 * Two checks, in this order:
 *   1. here, in constant time, against the SETUP_CODE the service was started
 *      with; a wrong code is counted in the database;
 *   2. in the database, against the hash it stores (engine_setup_code_valid,
 *      and again in engine_setup_complete).
 *
 * The count lives in the database so a restart does not reset it: five wrong
 * codes inside 15 minutes lock setup for an hour (migration 0034).
 *
 * FAIL CLOSED: if the database cannot say whether setup is locked, this
 * throws and the caller answers 503. A code is never accepted on a guess.
 */

/** Longest code this will look at. Anything longer is simply wrong. */
const MAX_CODE_CHARS = 512;

const LockState = z.object({
  locked: z.boolean(),
  retry_after_seconds: z.number().int().nonnegative(),
});
export type LockState = z.infer<typeof LockState>;

/** Validate what the lockout functions return. Throws on anything else. */
export function parseLockState(raw: unknown): LockState {
  return LockState.parse(raw);
}

export type SetupCodeDeps = {
  /** SETUP_CODE from the environment, or undefined when it is not set. */
  readonly expected: string | undefined;
  readonly attemptCheck: () => Promise<LockState>;
  readonly attemptFail: () => Promise<LockState>;
  /** The database's own check of the code against its stored hash. */
  readonly codeValid: (code: string) => Promise<boolean>;
};

export type SetupCodeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * not_configured: the service has no SETUP_CODE.
       * locked: too many wrong codes; nothing is accepted for now.
       * wrong: not the code.
       * closed: the code matches the service's, but the database will not take
       *   it (the window is closed, or it holds a different code).
       */
      readonly reason: "not_configured" | "locked" | "wrong" | "closed";
      readonly retryAfterSeconds: number;
    };

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/** Compare two strings without the time taken depending on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

// One code check at a time in this process. Without this, a burst of parallel
// requests could all read "not locked" before any of them recorded a failure.
let queue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

const refuse = (
  reason: "not_configured" | "locked" | "wrong" | "closed",
  retryAfterSeconds = 0,
): SetupCodeResult => ({ ok: false, reason, retryAfterSeconds });

async function check(
  deps: SetupCodeDeps,
  submitted: unknown,
): Promise<SetupCodeResult> {
  const expected = deps.expected;
  if (!expected) return refuse("not_configured");

  const before = await deps.attemptCheck();
  if (before.locked) return refuse("locked", before.retry_after_seconds);

  const code = typeof submitted === "string" ? submitted.trim() : "";
  const plausible = code.length > 0 && code.length <= MAX_CODE_CHARS;
  // Always run the comparison, so a blank or oversized code takes as long.
  const matches = constantTimeEqual(plausible ? code : "", expected);
  if (!plausible || !matches) {
    const after = await deps.attemptFail();
    return after.locked
      ? refuse("locked", after.retry_after_seconds)
      : refuse("wrong");
  }

  return (await deps.codeValid(code)) ? { ok: true } : refuse("closed");
}

/** Check a submitted setup code. Throws if the database cannot be asked. */
export function verifySetupCode(
  deps: SetupCodeDeps,
  submitted: unknown,
): Promise<SetupCodeResult> {
  return oneAtATime(() => check(deps, submitted));
}
