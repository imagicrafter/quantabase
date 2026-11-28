import { db } from "../db.js";
import { logger } from "../log/logger.js";
import { AppDeniedError, AppInputError, AppMissingFunctionError, AppStoreError, MISSING_FUNCTION, type Row } from "../app/store.js";
import type { MeetingItem } from "./body.js";

/**
 * The Fireflies webhook path's calls into the database (migration 0081):
 * the webhook itself and the background fetches. The owner's screen calls
 * (app_fireflies_*) are in app/fireflies-store.ts: only the app module names
 * app-only functions. Log lines carry the function and SQLSTATE only, never
 * arguments (they hold the API key, the signing secret and meeting text).
 */

export type DeliveryStatus = "done" | "failed" | "not_found";
export type BeginEvent = string;

export type FirefliesStore = {
  readonly lookup: (hookId: string) => Promise<{ readonly accountId: string; readonly secret: string } | null>;
  readonly seen: (accountId: string, event: string) => Promise<void>;
  readonly begin: (accountId: string, meetingId: string, event: BeginEvent, reprocessedAt: number | null) => Promise<"fetch" | "skip">;
  readonly end: (accountId: string, meetingId: string, event: BeginEvent, status: DeliveryStatus, reason: string | null, parts: number | null) => Promise<void>;
  readonly apiKey: (accountId: string) => Promise<string | null>;
  readonly record: (accountId: string, item: MeetingItem) => Promise<Row>;
};

export async function rpc(fn: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const { data, error } = await db().rpc(fn, args).abortSignal(AbortSignal.timeout(15_000));
  if (error) {
    logger.warn({ fn, code: error.code }, "fireflies RPC failed");
    if (error.code === "22023") throw new AppInputError(error.message.slice(0, 300));
    if (error.code === "42501") throw new AppDeniedError("not allowed");
    if (error.code === MISSING_FUNCTION) throw new AppMissingFunctionError(fn);
    throw new AppStoreError("database error");
  }
  return data;
}

export const obj = (data: unknown): Row =>
  data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : {};

export const liveFirefliesStore: FirefliesStore = {
  lookup: async (hookId) => {
    const row = obj(await rpc("fireflies_hook_lookup", { p_hook_id: hookId }));
    const accountId = row["account_id"];
    const secret = row["secret"];
    return typeof accountId === "string" && typeof secret === "string" && secret.length > 0 ? { accountId, secret } : null;
  },
  seen: async (accountId, event) => {
    await rpc("fireflies_hook_seen", { p_account_id: accountId, p_event: event });
  },
  begin: async (accountId, meetingId, event, reprocessedAt) =>
    (await rpc("fireflies_delivery_begin", {
      p_account_id: accountId, p_meeting_id: meetingId, p_event: event, p_reprocessed_at: reprocessedAt,
    })) === "skip" ? "skip" : "fetch",
  end: async (accountId, meetingId, event, status, reason, parts) => {
    await rpc("fireflies_delivery_end", {
      p_account_id: accountId, p_meeting_id: meetingId, p_event: event, p_status: status, p_reason: reason, p_parts: parts,
    });
  },
  apiKey: async (accountId) => {
    const data = await rpc("fireflies_hook_api_key", { p_account_id: accountId });
    return typeof data === "string" && data.length > 0 ? data : null;
  },
  record: async (accountId, item) => obj(await rpc("fireflies_hook_record", { p_account_id: accountId, p_item: item })),
};
