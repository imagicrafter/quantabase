import { z } from "zod";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { providerFor } from "../../sources/index.js";
import {
  firefliesFilter,
  gmailAfterTerm,
  gmailNewerThanTerm,
  gmailQuery,
  isRuleSource,
  parseRules,
  type Rule,
} from "../../sources/rules.js";
import { db } from "../../db.js";
import { logger } from "../../log/logger.js";
import { pageRpc, rowsOf } from "./rpc.js";

/**
 * The plan for one mechanical ingest run (Phase 10.10, stage 1).
 *
 * A scheduled task on the smallest model calls this first. For Gmail and
 * Fireflies it names ONE account of the caller's (gmail:<address>,
 * fireflies:<account>) and gets back the caller's inclusion rules for it and a
 * provider query NARROWED by them (docs/source-rules.md). The database keeps
 * only what the rules include, whatever the run hands over; the query only
 * saves work. It never returns source text.
 */

export const INGEST_SOURCES = ["gmail", "drive", "fireflies", "calendar"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

const FIRST_RUN_DAYS = 7;
const SAMPLE_DAYS = 7;
const MAX_ITEMS = 25;
const MAX_SAMPLE = 200;

export const getIngestPlanSchema = z
  .object({
    source: z.enum(INGEST_SOURCES),
    // The source account: the address of the Gmail or Fireflies account the run reads.
    account: z.string().trim().toLowerCase().email().max(254).optional(),
  })
  .strict()
  .refine((v) => !isRuleSource(v.source) || v.account !== undefined, {
    message: "account is required for gmail and fireflies: the address of the account this run reads",
    path: ["account"],
  });

type Scope = Readonly<Record<string, string>>;

function scopeFor(source: IngestSource): Scope {
  switch (source) {
    case "gmail":
      return {
        list:
          "Search Gmail MESSAGES with `query` (not threads). Oldest first. Skip messages labelled Spam, Trash or Draft. " +
          "If the search result lacks label ids or dates, read each listed message (or its thread) with the connector's get_message / get_thread to get them.",
        source_id: "the Gmail message id",
        title: "the message subject",
        body: "the one message: From, To, Cc, Date, then its text exactly as read",
        source_created_at: "the message date",
        provider:
          'for every message: {"message_id", "thread_id", "from", "to": [...], "cc": [...], "label_ids": [the label ids on the message, unchanged], "date"}',
      };
    case "drive":
      return {
        list: "List Google Drive files modified after `since`. Oldest first. Docs, Sheets, Slides, PDFs and text files only; skip folders, images and video.",
        source_id: "the Drive file id",
        title: "the file name",
        body: "the file's text exactly as read",
        source_created_at: "the file's modified time",
      };
    case "fireflies":
      return {
        list: "List Fireflies meetings dated after `since` that match `filter` (in one of filter.channel_ids, or with one of filter.participants). Oldest first.",
        source_id: "the Fireflies meeting (transcript) id",
        title: "the meeting title",
        body:
          "the participants line; then the Fireflies summary when there is one (overview, notes, action items, exactly as read); " +
          "then the full transcript exactly as read (speaker: text, one line each). Never the summary alone when a transcript exists",
        source_created_at: "the meeting date and time",
        provider:
          'for every meeting: {"meeting_id", "channel_ids": [the channel ids it is in], "participants": [their email addresses], "organizer_email", "date"}',
      };
    case "calendar":
      return {
        list: "List Google Calendar events on the primary calendar that start after `since` and before now. Oldest first. Skip declined events.",
        source_id: "the Calendar event id",
        title: "the event title",
        body: "start, end, attendees, location, then the description exactly as read",
        source_created_at: "the event start time",
      };
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

type Cursor = {
  readonly last_seen: string | null;
  readonly last_received_at: string | null;
  readonly items_received: number;
  readonly items_saved: number;
  readonly items_skipped?: number;
};

function sinceFrom(cursor: Cursor | null, backfillFrom: string | null): string {
  const fallback = new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString();
  return backfillFrom ?? isoOrNull(cursor?.last_seen) ?? isoOrNull(cursor?.last_received_at) ?? fallback;
}

const str = (v: unknown): string | null => (v != null ? String(v) : null);

async function tagPlan(source: IngestSource, sub: string) {
  const row = rowsOf(await pageRpc("source_cursor_get", sub, { p_source: source }, "The ingest plan could not be read"))[0];
  const cursor: Cursor | null = row
    ? {
        last_seen: str(row["last_seen_id"]),
        last_received_at: str(row["last_received_at"]),
        items_received: Number(row["items_received"] ?? 0),
        items_saved: Number(row["items_saved"] ?? 0),
      }
    : null;
  const since = sinceFrom(cursor, null);
  return {
    source,
    first_run: cursor === null,
    cursor,
    since,
    max_items: MAX_ITEMS,
    record_with: "record_source_item",
    cursor_rule: "Pass cursor = the item's source_created_at (date and time). Hand items over oldest first.",
    tags_rule:
      "Pass each item's tags exactly as scope.tags says, unchanged. Never pass topics: the Engine decides an item's topic.",
    scope: { ...scopeFor(source), tags: providerFor(source)?.howToRead ?? "This source has no tags. Do not pass tags." },
  };
}

function summary(rules: readonly Rule[]) {
  return rules.map((r) => ({
    kind: r.kind,
    name: r.name ?? "",
    topic: r.private ? "private (owner only)" : (r.topic ?? null),
    broken: r.broken === true,
  }));
}

/**
 * True when the caller's Fireflies account is fed by the Engine's own webhook
 * (0081): the scheduled ingest must then skip it, or every meeting would be
 * stored twice in two shapes. An Engine whose database predates 0081 (or any
 * error here) answers false: the run goes on as before.
 */
async function webhookConnected(source: string, account: string, sub: string): Promise<boolean> {
  if (source !== "fireflies") return false;
  const { data, error } = await db().rpc("source_webhook_connected", { p_oauth_subject: sub, p_source: source, p_account: account });
  if (error) {
    logger.warn({ fn: "source_webhook_connected", code: error.code }, "page RPC failed");
    return false;
  }
  return data === true;
}

export const WEBHOOK_SKIP =
  "This Fireflies account is fed by the Engine's own webhook: every finished meeting reaches the Engine by itself. " +
  "Do NOT list or hand over any meeting (skip Step 3). Do only what report_rule says, then report: ingest fireflies: handled by the Engine's webhook, skipped.";

async function rulesPlan(source: "gmail" | "fireflies", account: string, sub: string) {
  const viaWebhook = await webhookConnected(source, account, sub);
  const plan = (await pageRpc(
    "source_ingest_plan",
    sub,
    { p_source: source, p_account: account },
    "The ingest plan could not be read",
  )) as Record<string, unknown> | null;
  const p = plan ?? {};
  const rules = parseRules(p["rules"]);
  const raw = (p["cursor"] ?? {}) as Record<string, unknown>;
  const cursor: Cursor = {
    last_seen: str(raw["last_seen"]),
    last_received_at: str(raw["last_received_at"]),
    items_received: Number(raw["items_received"] ?? 0),
    items_saved: Number(raw["items_saved"] ?? 0),
    items_skipped: Number(raw["items_skipped"] ?? 0),
  };
  const firstRun = cursor.last_received_at === null;
  const backfill = p["backfill"] === true ? isoOrNull(p["backfill_from"]) : null;
  const since = sinceFrom(firstRun ? null : cursor, backfill);
  const query = source === "gmail" ? gmailQuery(rules, gmailAfterTerm(since)) : null;
  const fallbackQuery = source === "gmail" ? gmailQuery(rules, gmailNewerThanTerm(since, Date.now())) : null;
  const filter = source === "fireflies" ? firefliesFilter(rules) : null;
  const nothing = viaWebhook || (source === "gmail" ? query === null : filter === null);
  const sampleWanted = p["sample_requested"] === true;
  const what = source === "gmail" ? "labels" : "channels";

  return {
    source,
    account: String(p["account"] ?? account),
    first_run: firstRun,
    cursor,
    since,
    backfill: backfill !== null,
    max_items: MAX_ITEMS,
    rules_version: Number(p["version"] ?? 0),
    rules: summary(rules),
    nothing_to_record: nothing,
    ...(viaWebhook ? { handled_by_webhook: true, skip: true, skip_rule: WEBHOOK_SKIP } : {}),
    ...(source === "gmail"
      ? {
          query,
          fallback_query: fallbackQuery,
          fallback_rule:
            "If `query` listed 0 messages and `nothing_to_record` is false, search ONCE more with `fallback_query` (same rule terms, newer_than instead of after). " +
            "Say in the report which query listed the items.",
        }
      : { filter }),
    record_with: "record_source_item",
    record_rule:
      `Hand over each listed item with account = "${String(p["account"] ?? account)}" and provider = its metadata (scope.provider). ` +
      "Never pass topics or an owner: the Engine checks the item against the person's own rules, files it itself, and keeps nothing a rule does not include (status not_included). That is normal; carry on.",
    cursor_rule: "Pass cursor = the item's source_created_at (date and time). Hand items over oldest first.",
    report_with: "report_ingest_candidates",
    report_rule:
      `First, once per run: list the account's ${what} and call report_ingest_candidates with all of them and ${what}_complete: true. ` +
      (sampleWanted
        ? `This run must also send a metadata sample: list up to ${MAX_SAMPLE} items from the last ${SAMPLE_DAYS} days` +
          (source === "gmail" ? ` with the query "newer_than:${SAMPLE_DAYS}d" (no other filter)` : " (no other filter)") +
          ", and pass each one's provider metadata ONLY (no subject, no text) as candidates." +
          (source === "gmail"
            ? " The search result alone lacks label ids and dates: read each listed message's metadata with the connector's get_message (or get_thread) first."
            : "")
        : "No metadata sample is wanted this run."),
    sample_wanted: sampleWanted,
    scope: scopeFor(source),
  };
}

export const getIngestPlanTool: ToolSpec = {
  name: "get_ingest_plan",
  description:
    "Call first in an ingest run. For one source (gmail, drive, fireflies, calendar) and, for gmail and fireflies, ONE account (its email address): your cursor, the time to list from (since), the most items to hand over (max_items), and how to fill record_source_item. For gmail and fireflies it also returns your inclusion rules and a query narrowed by them; the Engine keeps only what your rules include. A Fireflies account the Engine's own webhook feeds comes back with handled_by_webhook: true and skip: true: hand over nothing for it. Stores no source text.",
  shape: { source: z.enum(INGEST_SOURCES), account: z.string().max(254).optional() },
  run: async (params, ctx) => {
    const { source, account } = getIngestPlanSchema.parse(params);
    if (isRuleSource(source)) return rulesPlan(source, account ?? "", ctx.sub);
    return tagPlan(source, ctx.sub);
  },
};

// ── report_ingest_candidates ────────────────────────────────────────────────

const labelIn = z.object({ id: z.string().trim().min(1).max(300), name: z.string().max(200).optional() }).strict();
const addrList = z.union([z.string().max(5000), z.array(z.string().max(500)).max(200)]);

/** Metadata only: no subject, no body. Anything else is refused. */
const candidateIn = z
  .object({
    message_id: z.string().max(300).optional(),
    thread_id: z.string().max(300).optional(),
    meeting_id: z.string().max(300).optional(),
    from: addrList.optional(),
    to: addrList.optional(),
    cc: addrList.optional(),
    participants: z.array(z.string().max(500)).max(200).optional(),
    organizer_email: z.string().max(254).optional(),
    label_ids: z.array(z.string().max(300)).max(200).optional(),
    channel_ids: z.array(z.string().max(300)).max(200).optional(),
    date: z.string().max(64).optional(),
  })
  .strict();

export const reportCandidatesSchema = z
  .object({
    source: z.enum(["gmail", "fireflies"]),
    account: z.string().trim().toLowerCase().email().max(254),
    labels: z.array(labelIn).max(500).optional(),
    labels_complete: z.boolean().optional(),
    channels: z.array(labelIn).max(500).optional(),
    channels_complete: z.boolean().optional(),
    candidates: z.array(candidateIn).max(500).optional(),
  })
  .strict();

/** Gmail's own labels: the database skips these on purpose (migration 0063); rules use only the person's labels. */
const GMAIL_SYSTEM_LABELS = new Set([
  "INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT",
  "CHAT", "SNOOZED", "SCHEDULED", "YELLOW_STAR", "OPENED", "MUTED",
]);

export const isGmailSystemLabel = (id: string): boolean => {
  const v = id.trim().toUpperCase();
  return GMAIL_SYSTEM_LABELS.has(v) || v.startsWith("CATEGORY_");
};

/** Counts for the reply, so "26 sent, 13 stored" is explained, not a mystery. */
function labelCounts(labels: readonly { id: string }[], stored: number) {
  const ids = [...new Set(labels.map((l) => l.id.trim()))];
  const system = ids.filter(isGmailSystemLabel).length;
  const own = ids.length - system;
  const skipped = system > 0 ? `${system} Gmail system labels (INBOX, SENT, UNREAD, CATEGORY_* and the like) were skipped on purpose: rules use only your own labels. ` : "";
  const stores =
    stored >= own
      ? `All ${own} of your own labels are stored.`
      : `Only ${stored} of your ${own} own labels were stored; check the missing ones have an id and a name under 200 characters.`;
  return { labels_sent: labels.length, system_labels_skipped: system, note: skipped + stores };
}

export const reportCandidatesTool: ToolSpec = {
  name: "report_ingest_candidates",
  description:
    "During an ingest run (get_ingest_plan says when): report ONE account's Gmail labels or Fireflies channels (id and name, all of them, with labels_complete/channels_complete true), and when asked a metadata-only sample of recent items (ids, from/to/cc, label or channel ids, participants, date; never a subject or text). Feeds your own rule builder and its dry-run. Stores no source text.",
  shape: reportCandidatesSchema.shape,
  run: async (params, ctx) => {
    const p = reportCandidatesSchema.parse(params);
    const labels = p.source === "gmail" ? p.labels : p.channels;
    const complete = p.source === "gmail" ? p.labels_complete : p.channels_complete;
    const data = (await pageRpc(
      "source_candidates_report",
      ctx.sub,
      {
        p_source: p.source,
        p_account: p.account,
        p_candidates: p.candidates ?? null,
        p_labels: labels ?? null,
        p_complete: complete === true,
      },
      "The report could not be recorded",
    )) as Record<string, unknown> | null;
    const stored = Number(data?.["labels"] ?? 0);
    const candidates = Number(data?.["candidates"] ?? 0);
    if (p.source !== "gmail" || labels === undefined) return { labels: stored, candidates };
    return { labels: stored, candidates, ...labelCounts(labels, stored) };
  },
};
