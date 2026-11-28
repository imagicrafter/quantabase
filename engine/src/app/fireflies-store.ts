import { liveFirefliesStore, obj, rpc, type FirefliesStore } from "../fireflies/store.js";
import type { Row } from "./store.js";

/**
 * The owner's Fireflies webhook screen's calls (migration 0081). Each takes
 * the signed-in email; the database works on the caller's OWN account only
 * and refuses anyone else's, administrators included. The API key goes in
 * once (connect) and never comes back: only its last 4 characters do.
 */
export type FirefliesAppStore = {
  readonly connect: (email: string, firefliesEmail: string, apiKey: string, hookId: string, secret: string) => Promise<Row>;
  readonly get: (email: string, accountId: string) => Promise<Row>;
  readonly missed: (email: string, accountId: string) => Promise<readonly string[]>;
  readonly disconnect: (email: string, accountId: string) => Promise<boolean>;
};

/** What the screens use: their own calls, plus the hook calls a retry or backfill makes. */
export type FirefliesScreenStore = FirefliesAppStore & FirefliesStore;

export const liveFirefliesAppStore: FirefliesScreenStore = {
  ...liveFirefliesStore,
  connect: async (email, firefliesEmail, apiKey, hookId, secret) =>
    obj(await rpc("app_fireflies_connect", {
      p_email: email, p_fireflies_email: firefliesEmail, p_api_key: apiKey, p_hook_id: hookId, p_secret: secret,
    })),
  get: async (email, accountId) => obj(await rpc("app_fireflies_get", { p_email: email, p_account_id: accountId })),
  missed: async (email, accountId) => {
    const data = await rpc("app_fireflies_missed", { p_email: email, p_account_id: accountId });
    return Array.isArray(data) ? data.map(String) : [];
  },
  disconnect: async (email, accountId) =>
    (await rpc("app_fireflies_disconnect", { p_email: email, p_account_id: accountId })) === true,
};
