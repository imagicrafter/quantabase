import { createHash } from "node:crypto";
import type { StoredAccess } from "../../src/setup/apply.js";
import type { LockState } from "../../src/setup/setup-code.js";

/**
 * An in-memory stand-in for the single engine_settings row and the functions
 * of migrations 0029 and 0034, with the same rules: five wrong codes inside
 * 15 minutes lock setup for an hour; the code works once.
 * (The real functions are tested in supabase/tests/setup_lockout_test.sql.)
 */

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 60 * 1000;

const sha = (code: string) =>
  createHash("sha256").update(code, "utf8").digest("hex");

export type FakeDb = ReturnType<typeof createFakeDb>;

export function createFakeDb(code: string | null, clock: { now: number }) {
  const row = {
    config: null as unknown,
    access: null as StoredAccess | null,
    setup_state: "open" as "open" | "complete",
    code_hash: code ? sha(code) : null,
    failed_at: [] as number[],
    locked_until: 0,
    code_ok_at: 0,
  };
  const calls = { check: 0, fail: 0, valid: 0, complete: 0 };

  const state = (): LockState => {
    const locked = row.locked_until > clock.now;
    return {
      locked,
      retry_after_seconds: locked
        ? Math.ceil((row.locked_until - clock.now) / 1000)
        : 0,
    };
  };
  const recordFailure = (): LockState => {
    if (row.locked_until > clock.now) return state();
    const recent = [
      ...row.failed_at.filter((t) => t > clock.now - WINDOW_MS),
      clock.now,
    ];
    if (recent.length >= 5) {
      row.failed_at = [];
      row.locked_until = clock.now + LOCK_MS;
    } else {
      row.failed_at = recent;
    }
    return state();
  };
  const open = () => row.setup_state === "open" && row.code_hash !== null;
  const locked = () => row.locked_until > clock.now;
  const usable = () => open() && !locked();
  /** A right code was checked in the last 10 minutes: a setup is under way. */
  const underWay = () => row.code_ok_at > clock.now - 10 * 60 * 1000;

  return {
    row,
    calls,
    attemptCheck: async (): Promise<LockState> => {
      calls.check += 1;
      return state();
    },
    attemptFail: async (): Promise<LockState> => {
      calls.fail += 1;
      return recordFailure();
    },
    codeValid: async (given: string): Promise<boolean> => {
      calls.valid += 1;
      if (!usable()) return false;
      if (sha(given) !== row.code_hash) {
        recordFailure();
        return false;
      }
      row.code_ok_at = clock.now;
      return true;
    },
    complete: async (given: string, access: StoredAccess): Promise<boolean> => {
      calls.complete += 1;
      if (!open()) return false;
      if (locked() && !underWay()) return false;
      if (sha(given) !== row.code_hash) {
        recordFailure();
        return false;
      }
      row.access = access;
      row.setup_state = "complete";
      row.code_hash = null;
      row.failed_at = [];
      row.locked_until = 0;
      row.code_ok_at = 0;
      return true;
    },
    reopen: (next: string) => {
      row.setup_state = "open";
      row.code_hash = sha(next);
      row.failed_at = [];
      row.locked_until = 0;
      row.code_ok_at = 0;
    },
    /** What workspace.engine_settings_public() returns. */
    readPublic: async () => ({
      config: row.config,
      access: row.access,
      setup_state: row.setup_state,
    }),
  };
}
