import { randomUUID } from "node:crypto";
import { logger } from "../log/logger.js";

/**
 * How a curator run holds the curator (migration 0064).
 *
 * A run takes a short database lease (curator_run_start) and renews it every
 * minute (curator_run_heartbeat). A service that dies or restarts stops
 * renewing, so its run is reclaimed within LEASE_SECONDS instead of blocking
 * every later tick. A run also has a hard deadline in the process: when it
 * passes, the run is recorded as failed and the in-process guard is released,
 * even if some call inside it never returned.
 */

/** This process's id on the runs it starts. A new one on every boot. */
export const HOLDER = `svc-${randomUUID()}`;
export const LEASE_SECONDS = 180;
export const HEARTBEAT_MS = 60_000;
/** Below the database's 30-minute cap, above the batch budget (12 minutes). */
export const HARD_CAP_MS = 20 * 60_000;

export class DeadlineError extends Error {}

/** Settle with `work`, or reject with DeadlineError after `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${what} did not finish in ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export type ReclaimStore = { readonly runReclaim: (holder: string) => Promise<number> };

/** On boot: close runs an earlier process left "running". Never throws. */
export async function reclaimAtBoot(store: ReclaimStore, holder: string = HOLDER): Promise<number> {
  try {
    const n = await store.runReclaim(holder);
    if (n > 0) logger.warn({ reclaimed: n }, "curator: closed runs left running by an earlier service");
    return n;
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : "error" }, "curator: could not reclaim stale runs at boot");
    return 0;
  }
}
