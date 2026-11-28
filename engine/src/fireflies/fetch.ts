import { logger } from "../log/logger.js";
import { AppInputError } from "../app/store.js";
import { meetingItems, TooLargeError } from "./body.js";
import { FirefliesError, LIST_PAGE, type FirefliesClient } from "./client.js";
import type { FirefliesStore } from "./store.js";

/**
 * Fetching meetings for a connected Fireflies account: one GraphQL call per
 * meeting, then each item (or part) through fireflies_hook_record, the same
 * database body record_source_item uses. Every fetch is begun and ended in
 * fireflies_deliveries, so a failure (or a process that stopped half way)
 * shows on the account page as a missed meeting instead of disappearing.
 *
 * Nothing here runs on a timer. The webhook starts one fetch per delivery;
 * the owner starts a retry of missed meetings or a one-time backfill.
 */

export type FetchDeps = {
  readonly store: FirefliesStore;
  readonly client: FirefliesClient;
  /** Wait between Fireflies calls in a backfill or retry (Fireflies rate-limits API keys). */
  readonly pause?: (ms: number) => Promise<void>;
};

export type FetchOutcome =
  | { readonly status: "skipped" }
  | { readonly status: "done"; readonly kept: number; readonly leftOut: number; readonly parts: number }
  | { readonly status: "not_found" }
  | { readonly status: "failed"; readonly reason: string };

const BACKFILL_MAX = 500;
const SPACING_MS = 1_500;

function reasonOf(err: unknown): string {
  if (err instanceof FirefliesError) return err.code === "unauthorized" ? "key_refused" : err.code;
  if (err instanceof TooLargeError) return "too_large";
  if (err instanceof AppInputError) return "store_refused";
  return "store_failed";
}

async function finish(deps: FetchDeps, accountId: string, meetingId: string, event: string, outcome: FetchOutcome): Promise<FetchOutcome> {
  if (outcome.status === "skipped") return outcome;
  const reason = outcome.status === "failed" ? outcome.reason : null;
  const parts = outcome.status === "done" ? outcome.parts : null;
  await deps.store.end(accountId, meetingId, event, outcome.status, reason, parts);
  logger.info({ status: outcome.status, ...(reason ? { reason } : {}), ...(parts ? { parts } : {}) }, "fireflies: meeting fetch finished");
  return outcome;
}

/** Fetch and store one meeting. Never throws for a Fireflies or storage failure: it is recorded instead. */
export async function fetchMeeting(
  deps: FetchDeps,
  accountId: string,
  meetingId: string,
  event: string,
  reprocessedAt: number | null,
  knownKey?: string,
): Promise<FetchOutcome> {
  if ((await deps.store.begin(accountId, meetingId, event, reprocessedAt)) === "skip") return { status: "skipped" };
  return fetchBegun(deps, accountId, meetingId, event, knownKey);
}

/** The rest of a fetch whose delivery row is already 'pending' (the webhook begins it before answering). */
export async function fetchBegun(
  deps: FetchDeps,
  accountId: string,
  meetingId: string,
  event: string,
  knownKey?: string,
): Promise<FetchOutcome> {
  let outcome: FetchOutcome;
  try {
    const key = knownKey ?? (await deps.store.apiKey(accountId));
    if (!key) {
      outcome = { status: "failed", reason: "no_key" };
    } else {
      const transcript = await deps.client.meeting(key, meetingId);
      const items = meetingItems({ ...transcript, id: meetingId });
      let kept = 0;
      for (const item of items) {
        const r = await deps.store.record(accountId, item);
        if (r["status"] !== "not_included") kept += 1;
      }
      outcome = { status: "done", kept, leftOut: items.length - kept, parts: items.length };
    }
  } catch (err) {
    outcome = err instanceof FirefliesError && err.code === "not_found" ? { status: "not_found" } : { status: "failed", reason: reasonOf(err) };
  }
  return finish(deps, accountId, meetingId, event, outcome);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type BatchResult = { readonly fetched: number; readonly skipped: number; readonly failed: number; readonly stoppedFor: string | null };

/** Fetch these meetings one after another; on a rate limit, mark the rest missed and stop. */
async function fetchAll(deps: FetchDeps, accountId: string, ids: readonly string[], event: string, key: string): Promise<BatchResult> {
  const pause = deps.pause ?? sleep;
  const counts = { fetched: 0, skipped: 0, failed: 0 };
  for (const [i, id] of ids.entries()) {
    const out = await fetchMeeting(deps, accountId, id, event, null, key);
    if (out.status === "skipped") counts.skipped += 1;
    else if (out.status === "failed") counts.failed += 1;
    else counts.fetched += 1;
    if (out.status === "failed" && (out.reason === "rate_limited" || out.reason === "key_refused")) {
      for (const rest of ids.slice(i + 1)) {
        if ((await deps.store.begin(accountId, rest, event, null)) === "fetch") {
          await deps.store.end(accountId, rest, event, "failed", out.reason, null);
          counts.failed += 1;
        }
      }
      return { ...counts, stoppedFor: out.reason };
    }
    if (out.status !== "skipped" && i < ids.length - 1) await pause(SPACING_MS);
  }
  return { ...counts, stoppedFor: null };
}

/** Fetch the account's missed meetings again, by id. */
export async function retryMissed(deps: FetchDeps, accountId: string, ids: readonly string[]): Promise<BatchResult> {
  const key = await deps.store.apiKey(accountId);
  if (!key) return { fetched: 0, skipped: 0, failed: ids.length, stoppedFor: "no_key" };
  return fetchAll(deps, accountId, ids, "retry", key);
}

/** The owner's one-time backfill: list the meetings since `fromIso` (50 a page), then fetch each one not already stored. */
export async function backfill(deps: FetchDeps, accountId: string, fromIso: string): Promise<BatchResult> {
  const key = await deps.store.apiKey(accountId);
  if (!key) return { fetched: 0, skipped: 0, failed: 0, stoppedFor: "no_key" };
  const ids: string[] = [];
  try {
    for (let skip = 0; skip < BACKFILL_MAX; skip += LIST_PAGE) {
      const page = await deps.client.listSince(key, fromIso, skip);
      ids.push(...page.map((m) => m.id));
      if (page.length < LIST_PAGE) break;
    }
  } catch (err) {
    logger.warn({ reason: reasonOf(err) }, "fireflies: backfill list failed");
    return { fetched: 0, skipped: 0, failed: 0, stoppedFor: reasonOf(err) };
  }
  // Oldest first, each once.
  const ordered = [...new Set(ids)].reverse();
  return fetchAll(deps, accountId, ordered, "backfill", key);
}

/**
 * One background job per account at a time (a retry or a backfill), in this
 * process. Returns false when one is already running for that account.
 */
export function createJobs() {
  const running = new Set<string>();
  return {
    start: (accountId: string, job: () => Promise<BatchResult>): boolean => {
      if (running.has(accountId)) return false;
      running.add(accountId);
      void job()
        .then((r) => logger.info({ ...r }, "fireflies: background fetch finished"))
        .catch((err: unknown) => logger.warn({ error: err instanceof Error ? err.name : "error" }, "fireflies: background fetch failed"))
        .finally(() => running.delete(accountId));
      return true;
    },
    isRunning: (accountId: string) => running.has(accountId),
  };
}

export type Jobs = ReturnType<typeof createJobs>;
