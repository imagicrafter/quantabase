import type { MeetingItem } from "../../src/fireflies/body.js";
import type { FirefliesClient, ListedMeeting, Transcript } from "../../src/fireflies/client.js";
import { FirefliesError } from "../../src/fireflies/client.js";
import type { DeliveryStatus } from "../../src/fireflies/store.js";
import type { FirefliesScreenStore } from "../../src/app/fireflies-store.js";

/** Synthetic values only. */
export const HOOK = "hookAAAAhookAAAAhookAAAAhookAAAA";
export const SECRET = "test".repeat(8);
export const ACCOUNT = "55555555-5555-4555-8555-555555555555";
export const API_KEY = "ff-synthetic-key-0000000000000000LAST";

type Delivery = { status: "pending" | DeliveryStatus; events: string[]; reason: string | null; parts: number | null; reprocessed: number | null };

/**
 * An in-memory FirefliesStore that follows migration 0081's rules: the begin
 * skip logic, and a record path that keeps only meetings with someone from
 * acme.example (the owner's one include rule), versioned by text.
 */
export function createFakeFirefliesStore() {
  const deliveries = new Map<string, Delivery>();
  const items = new Map<string, string[]>();
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  let seen = 0;
  let key: string | null = API_KEY;
  let lookupFails = false;

  const store: FirefliesScreenStore = {
    connect: async (...args) => {
      rec("connect", ...args);
      return { account_id: ACCOUNT, account: args[1], new: true };
    },
    get: async (...args) => {
      rec("get", ...args);
      return { connected: true, fireflies_email: "ann@meet.example", key_last4: "LAST", hook_id: HOOK, secret: SECRET, first_delivery_at: seen > 0 ? "2026-11-20T10:00:00Z" : null, missed: 0, done: 0 };
    },
    missed: async (...args) => {
      rec("missed", ...args);
      return [...deliveries.entries()].filter(([, d]) => d.status === "failed").map(([id]) => id);
    },
    disconnect: async (...args) => {
      rec("disconnect", ...args);
      return true;
    },
    lookup: async (hookId) => {
      rec("lookup", hookId);
      if (lookupFails) throw new Error("db down");
      return hookId === HOOK ? { accountId: ACCOUNT, secret: SECRET } : null;
    },
    seen: async (...args) => {
      rec("seen", ...args);
      seen += 1;
    },
    begin: async (accountId, meetingId, event, reprocessedAt) => {
      rec("begin", accountId, meetingId, event, reprocessedAt);
      const d = deliveries.get(meetingId);
      if (d?.status === "pending" && event !== "retry") return "skip";
      if (d?.status === "done") {
        if (event === "backfill") return "skip";
        if (event !== "retry" && d.events.includes(event) && (reprocessedAt === null || reprocessedAt <= (d.reprocessed ?? 0))) return "skip";
      }
      deliveries.set(meetingId, {
        status: "pending", events: d?.events ?? [], reason: null, parts: d?.parts ?? null,
        reprocessed: Math.max(d?.reprocessed ?? 0, reprocessedAt ?? 0) || null,
      });
      return "fetch";
    },
    end: async (accountId, meetingId, event, status, reason, parts) => {
      rec("end", accountId, meetingId, event, status, reason, parts);
      const d = deliveries.get(meetingId);
      if (!d) return;
      deliveries.set(meetingId, {
        ...d, status, reason: status === "done" ? null : reason,
        parts: status === "done" ? parts : d.parts,
        events: status === "done" && !d.events.includes(event) ? [...d.events, event] : d.events,
      });
    },
    apiKey: async (accountId) => {
      rec("apiKey", accountId);
      return key;
    },
    record: async (accountId, item: MeetingItem) => {
      rec("record", accountId, item);
      if (!item.provider.participants.some((p) => p.endsWith("@acme.example"))) return { id: null, version: null, status: "not_included" };
      const versions = items.get(item.source_id) ?? [];
      if (versions.includes(item.body)) return { id: "i", version: versions.indexOf(item.body) + 1, status: "unchanged" };
      items.set(item.source_id, [...versions, item.body]);
      return { id: "i", version: versions.length + 1, status: versions.length === 0 ? "new" : "new_version" };
    },
  };
  return {
    store, calls, deliveries, items,
    setKey: (k: string | null) => { key = k; },
    failLookup: () => { lookupFails = true; },
  };
}

export function transcript(id: string, over: Partial<Transcript> = {}): Transcript {
  return {
    id,
    title: "Weekly sync",
    date: Date.parse("2026-11-20T10:00:00Z"),
    organizer_email: "ann@meet.example",
    participants: ["pat@acme.example", "ann@meet.example"],
    meeting_attendees: [{ displayName: "Pat", email: "pat@acme.example" }],
    sentences: [
      { speaker_name: "Pat", text: "Hello." },
      { speaker_name: "Ann", text: "The budget is 40 units." },
    ],
    summary: { overview: "A short sync.", action_items: "Pat sends the plan." },
    channels: [{ id: "chan-1", title: "Clients" }],
    ...over,
  };
}

/** A FirefliesClient that serves these meetings, and records every call (with the key it was given). */
export function createFakeClient(meetings: Readonly<Record<string, Transcript>>, over: Partial<FirefliesClient> = {}) {
  const calls: Array<{ fn: string; key: string; arg?: unknown }> = [];
  const client: FirefliesClient = {
    whoami: async (key) => {
      calls.push({ fn: "whoami", key });
      if (key !== API_KEY) throw new FirefliesError("unauthorized");
      return { email: "ann@meet.example", name: "Ann" };
    },
    meeting: async (key, id) => {
      calls.push({ fn: "meeting", key, arg: id });
      const m = meetings[id];
      if (!m) throw new FirefliesError("not_found");
      return m;
    },
    listSince: async (key, from, skip): Promise<readonly ListedMeeting[]> => {
      calls.push({ fn: "listSince", key, arg: { from, skip } });
      return skip === 0 ? Object.values(meetings).map((m) => ({ id: m.id, date: m.date ?? null })).reverse() : [];
    },
    ...over,
  };
  return { client, calls };
}
