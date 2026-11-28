import { db } from "../db.js";
import { logger } from "../log/logger.js";
import { runTwoStep, type TwoStepResult, type TwoStepSpec } from "../tools/admin/rpc.js";

/**
 * The app screens' calls into the database (migration 0054, plus the admin
 * functions of 0033). Each takes the signed-in email first; the database
 * resolves it to an active person and applies the rules. Log lines carry the
 * function and SQLSTATE only, never arguments (they hold page text and keys).
 */

/** The database refused on purpose (22023): the message is for the person. */
export class AppInputError extends Error {}
/** Not allowed (42501). */
export class AppDeniedError extends Error {}
/** Anything else. The page says "try again" without detail. */
export class AppStoreError extends Error {}
/**
 * The database has no such function (PostgREST PGRST202): the app was
 * updated and its new migrations were never applied. The page says
 * "Database update needed" and links to /setup/database.
 */
export class AppMissingFunctionError extends AppStoreError {}

/** PostgREST's "function not found in the schema cache". */
export const MISSING_FUNCTION = "PGRST202";

export type Row = Record<string, unknown>;

export type SaveResult = { readonly id: string; readonly content_hash: string; readonly changed: boolean };

export type DrawerQuery = {
  readonly drawer: string;
  readonly query: string | null;
  readonly topic: string | null;
  readonly sort: "title" | "key" | "updated";
  readonly desc: boolean;
  readonly offset: number;
  readonly limit: number;
};

export type AppStore = {
  readonly whoami: (email: string) => Promise<Row | null>;
  readonly reviews: (email: string, status: string | null) => Promise<Row[]>;
  readonly review: (email: string, id: string) => Promise<Row | null>;
  readonly decide: (email: string, id: string, approve: boolean) => Promise<boolean>;
  readonly flagged: (email: string) => Promise<Row[]>;
  readonly release: (email: string, id: string) => Promise<boolean>;
  readonly discard: (email: string, id: string) => Promise<boolean>;
  readonly pages: (email: string, query: string | null) => Promise<Row[]>;
  readonly page: (email: string, id: string) => Promise<Row | null>;
  readonly savePage: (email: string, page: Row, expectedHash: string | null) => Promise<SaveResult>;
  readonly history: (email: string, pageId: string) => Promise<Row[]>;
  readonly version: (email: string, historyId: string) => Promise<Row | null>;
  readonly restore: (email: string, historyId: string, expectedHash: string) => Promise<SaveResult>;
  // the Knowledge screens (0058)
  readonly knowledgeTree: (email: string) => Promise<Row>;
  readonly drawerPages: (email: string, q: DrawerQuery) => Promise<Row>;
  readonly pageView: (email: string, id: string) => Promise<Row | null>;
  readonly pageLinks: (email: string, id: string) => Promise<Row | null>;
  readonly pin: (email: string, id: string, pin: boolean) => Promise<boolean>;
  readonly markReviewed: (email: string, id: string) => Promise<boolean>;
  // possible duplicates (0067): the person's own pairs; merge or keep apart
  readonly duplicates: (email: string) => Promise<Row[]>;
  readonly duplicate: (email: string, id: string) => Promise<Row | null>;
  readonly dismissDuplicate: (email: string, id: string) => Promise<boolean>;
  readonly mergePages: (email: string, id: string, keep: string, body: string, keepHash: string, dropHash: string) => Promise<Row>;
  // indexing (administrators, 0058)
  readonly indexing: (email: string) => Promise<Row>;
  /** Model cost this month and per item (0069); fails before 0069 is applied. */
  readonly curatorCost?: (email: string) => Promise<Row>;
  readonly reindexPage: (email: string, id: string) => Promise<boolean>;
  // the Pipeline and Ledger screens (0071): administrators read, the owner changes
  readonly pipeline?: (email: string) => Promise<Row>;
  readonly setPipeline?: (email: string, setting: string, value: string) => Promise<Row>;
  readonly ledger?: (email: string) => Promise<Row>;
  // tickets (0072, administrators): opened by the database, closed by a person
  readonly tickets?: (email: string, status: "open" | "closed" | null) => Promise<Row[]>;
  readonly ticket?: (email: string, ref: string) => Promise<Row | null>;
  readonly ticketNote?: (email: string, ref: string, body: string) => Promise<boolean>;
  readonly closeTicket?: (email: string, ref: string, note: string | null) => Promise<boolean>;
  // the Cataloguer and Index clerk cards (0075)
  /** The pages this administrator may see for a question, as their MCP search ranks them. */
  readonly indexSearch?: (email: string, query: string, embedding: readonly number[], count: number) => Promise<Row[]>;
  /** What a redo would queue: pages, the summary model, the observed cost (administrators). */
  readonly redoPreview?: (email: string) => Promise<Row>;
  /** Re-queue every live page for a new summary and index entry (the Engine owner only). */
  readonly redoSummaries?: (email: string) => Promise<number>;
  readonly rerunSummaries: (email: string) => Promise<number>;
  // settings (administrators)
  readonly templates: () => Promise<string[]>;
  readonly setTemplates: (email: string, names: readonly string[]) => Promise<string[]>;
  readonly topics: (email: string) => Promise<Row[]>;
  /** Make a topic (administrators only, checked in the database). True when new. */
  readonly addTopic: (email: string, topic: string, label: string, sensitive: boolean) => Promise<boolean>;
  /** For administrators: how many rules each person has. Never the rules. */
  readonly peopleRuleCounts: (email: string) => Promise<Row[]>;
  readonly people: (email: string) => Promise<Row[]>;
  /** The caller's own display name and name used on pages (administrators, 0077). */
  readonly myNames: (email: string) => Promise<Row>;
  /** Change the caller's OWN names (administrators, 0077). A null page name goes back to the default. */
  readonly setMyNames: (email: string, displayName: string, pageName: string | null) => Promise<Row>;
  // Sources (0063): every person's OWN source accounts and inclusion rules.
  readonly sourceAccounts: (email: string) => Promise<Row[]>;
  /** The caller's own items from one hand-sent source (claude-code): counts and last received. */
  readonly sourceSummary: (email: string, source: string) => Promise<Row>;
  readonly addSourceAccount: (email: string, source: string, account: string) => Promise<Row>;
  readonly sourceRules: (email: string, accountId: string) => Promise<Row>;
  /** Save the whole ordered list; a stale expectedVersion is refused. */
  readonly saveSourceRules: (email: string, accountId: string, rules: readonly unknown[], expectedVersion: number) => Promise<Row>;
  readonly previewSourceRules: (email: string, accountId: string, rules: readonly unknown[]) => Promise<Row>;
  readonly sourceRulesHistory: (email: string, accountId: string) => Promise<Row>;
  readonly recheckSource: (email: string, accountId: string) => Promise<Row>;
  readonly backfillSource: (email: string, accountId: string, since: string) => Promise<Row>;
  readonly requestSample: (email: string, accountId: string) => Promise<boolean>;
  /** Suggested contacts from the caller's own Gmail headers (0080); fails before 0080 is applied. */
  readonly mailContacts?: (email: string, accountId: string) => Promise<Row>;
  readonly recheckPages: (email: string) => Promise<Row[]>;
  readonly pageRecheckDone: (email: string, id: string) => Promise<boolean>;
  /** An admin change in two steps (0033): no code previews, a code applies. */
  readonly twoStep: (email: string, spec: TwoStepSpec) => Promise<TwoStepResult>;
  readonly setModelKey: (email: string, value: string) => Promise<void>;
  readonly timer: (email: string) => Promise<Row>;
  readonly setTimer: (email: string, host: string, enabled: boolean) => Promise<Row>;
  readonly testTimer: (email: string) => Promise<number | null>;
  readonly timerResult: (email: string, id: number) => Promise<Row | null>;
  /** Cron jobs, failed pokes, last tick received, the run holding the lease (0064). */
  readonly curatorHealth: (email: string) => Promise<Row>;
  readonly health: (email: string) => Promise<Row>;
  // backup (the Engine owner only; 0056)
  readonly backup: (email: string) => Promise<Row>;
  readonly setBackup: (email: string, repo: string | null, branch: string, enabled: boolean) => Promise<Row>;
  readonly requestBackup: (email: string) => Promise<Row>;
  readonly setBackupToken: (email: string, value: string) => Promise<void>;
};

async function rpc(fn: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const { data, error } = await db().rpc(fn, args).abortSignal(AbortSignal.timeout(15_000));
  if (error) {
    logger.warn({ fn, code: error.code }, "app RPC failed");
    if (error.code === "22023") throw new AppInputError(error.message.slice(0, 300));
    if (error.code === "42501") throw new AppDeniedError("not allowed");
    if (error.code === "40001") throw new AppInputError(error.message.slice(0, 300));
    if (error.code === MISSING_FUNCTION) throw new AppMissingFunctionError(fn);
    throw new AppStoreError("database error");
  }
  return data;
}

const list = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);
const obj = (data: unknown): Row | null =>
  data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;

function saved(data: unknown): SaveResult {
  const row = list(data)[0];
  if (!row) throw new AppStoreError("no result");
  return { id: String(row["id"]), content_hash: String(row["content_hash"]), changed: row["changed"] === true };
}

/** The applied migration file names (0059), for the service itself. */
export async function migrationsApplied(): Promise<readonly string[]> {
  const data = await rpc("engine_migrations_applied", {});
  return Array.isArray(data) ? data.map(String) : [];
}

export const liveStore: AppStore = {
  whoami: async (email) => obj(await rpc("app_whoami", { p_email: email })),
  reviews: async (email, status) => list(await rpc("app_review_list", { p_email: email, p_status: status })),
  review: async (email, id) => obj(await rpc("app_review_get", { p_email: email, p_id: id })),
  decide: async (email, id, approve) =>
    (await rpc("app_review_decide", { p_email: email, p_id: id, p_approve: approve })) === true,
  flagged: async (email) => list(await rpc("app_flagged_list", { p_email: email })),
  release: async (email, id) => (await rpc("app_flagged_release", { p_email: email, p_id: id })) === true,
  discard: async (email, id) => (await rpc("app_flagged_discard", { p_email: email, p_id: id })) === true,
  pages: async (email, query) => list(await rpc("app_pages_list", { p_email: email, p_query: query, p_limit: 500 })),
  page: async (email, id) => obj(await rpc("app_page_get", { p_email: email, p_id: id })),
  savePage: async (email, page, expectedHash) =>
    saved(await rpc("app_page_save", { p_email: email, p_page: page, p_expected_hash: expectedHash })),
  history: async (email, pageId) => list(await rpc("app_page_history", { p_email: email, p_page_id: pageId })),
  version: async (email, historyId) => obj(await rpc("app_page_version", { p_email: email, p_history_id: historyId })),
  restore: async (email, historyId, expectedHash) =>
    saved(await rpc("app_page_restore", { p_email: email, p_history_id: historyId, p_expected_hash: expectedHash })),
  knowledgeTree: async (email) => obj(await rpc("app_knowledge_tree", { p_email: email })) ?? {},
  drawerPages: async (email, q) =>
    obj(
      await rpc("app_drawer_pages", {
        p_email: email, p_drawer: q.drawer, p_query: q.query, p_topic: q.topic,
        p_sort: q.sort, p_desc: q.desc, p_offset: q.offset, p_limit: q.limit,
      }),
    ) ?? {},
  pageView: async (email, id) => obj(await rpc("app_page_view", { p_email: email, p_id: id })),
  pageLinks: async (email, id) => obj(await rpc("app_page_links", { p_email: email, p_id: id })),
  pin: async (email, id, pin) => (await rpc("app_page_pin", { p_email: email, p_id: id, p_pin: pin })) === true,
  markReviewed: async (email, id) => (await rpc("app_page_mark_reviewed", { p_email: email, p_id: id })) === true,
  duplicates: async (email) => list(await rpc("app_duplicates_list", { p_email: email })),
  duplicate: async (email, id) => obj(await rpc("app_duplicate_get", { p_email: email, p_id: id })),
  dismissDuplicate: async (email, id) => (await rpc("app_duplicate_dismiss", { p_email: email, p_id: id })) === true,
  mergePages: async (email, id, keep, body, keepHash, dropHash) =>
    obj(await rpc("app_page_merge", {
      p_email: email, p_id: id, p_keep: keep, p_body: body, p_keep_hash: keepHash, p_drop_hash: dropHash,
    })) ?? {},
  indexing: async (email) => obj(await rpc("app_indexing", { p_email: email })) ?? {},
  curatorCost: async (email) => obj(await rpc("app_curator_cost", { p_email: email })) ?? {},
  pipeline: async (email) => obj(await rpc("app_pipeline_get", { p_email: email })) ?? {},
  setPipeline: async (email, setting, value) =>
    obj(await rpc("app_pipeline_set", { p_email: email, p_setting: setting, p_value: value })) ?? {},
  ledger: async (email) => obj(await rpc("app_ledger", { p_email: email })) ?? {},
  tickets: async (email, status) => list(await rpc("app_tickets_list", { p_email: email, p_status: status })),
  ticket: async (email, ref) => obj(await rpc("app_ticket_get", { p_email: email, p_ref: ref })),
  ticketNote: async (email, ref, body) => (await rpc("app_ticket_note", { p_email: email, p_ref: ref, p_body: body })) === true,
  closeTicket: async (email, ref, note) =>
    (await rpc("app_ticket_close", { p_email: email, p_ref: ref, p_note: note })) === true,
  indexSearch: async (email, query, embedding, count) =>
    list(await rpc("app_index_search", { p_email: email, query_text: query, query_embedding: embedding, match_count: count })),
  redoPreview: async (email) => obj(await rpc("app_summaries_redo_preview", { p_email: email })) ?? {},
  redoSummaries: async (email) => {
    const data = await rpc("app_summaries_redo", { p_email: email });
    return typeof data === "number" ? data : 0;
  },
  reindexPage: async (email, id) => (await rpc("app_page_reindex", { p_email: email, p_id: id })) === true,
  rerunSummaries: async (email) => {
    const data = await rpc("app_summaries_rerun", { p_email: email });
    return typeof data === "number" ? data : 0;
  },
  templates: async () => {
    const data = await rpc("engine_templates_get", {});
    return Array.isArray(data) ? data.map(String) : [];
  },
  setTemplates: async (email, names) => {
    const data = await rpc("app_templates_set", { p_email: email, p_names: names });
    return Array.isArray(data) ? data.map(String) : [];
  },
  topics: async (email) => list(await rpc("app_topics_list", { p_email: email })),
  addTopic: async (email, topic, label, sensitive) =>
    (await rpc("app_topic_add", { p_email: email, p_topic: topic, p_label: label, p_sensitive: sensitive })) === true,
  peopleRuleCounts: async (email) => list(await rpc("app_people_rule_counts", { p_email: email })),
  sourceAccounts: async (email) => list(await rpc("app_source_accounts_list", { p_email: email })),
  sourceSummary: async (email, source) => obj(await rpc("app_source_summary", { p_email: email, p_source: source })) ?? {},
  addSourceAccount: async (email, source, account) =>
    obj(await rpc("app_source_account_add", { p_email: email, p_source: source, p_account: account })) ?? {},
  sourceRules: async (email, id) => obj(await rpc("app_source_rules_get", { p_email: email, p_account_id: id })) ?? {},
  saveSourceRules: async (email, id, rules, expected) =>
    obj(await rpc("app_source_rules_save", { p_email: email, p_account_id: id, p_rules: rules, p_expected_version: expected })) ?? {},
  previewSourceRules: async (email, id, rules) =>
    obj(await rpc("app_source_rules_preview", { p_email: email, p_account_id: id, p_rules: rules })) ?? {},
  sourceRulesHistory: async (email, id) =>
    obj(await rpc("app_source_rules_history", { p_email: email, p_account_id: id })) ?? {},
  recheckSource: async (email, id) => obj(await rpc("app_source_recheck", { p_email: email, p_account_id: id })) ?? {},
  backfillSource: async (email, id, since) =>
    obj(await rpc("app_source_backfill", { p_email: email, p_account_id: id, p_since: since })) ?? {},
  requestSample: async (email, id) =>
    (await rpc("app_source_sample_request", { p_email: email, p_account_id: id })) === true,
  mailContacts: async (email, id) => obj(await rpc("app_source_contacts_get", { p_email: email, p_account_id: id })) ?? {},
  recheckPages: async (email) => list(await rpc("app_pages_recheck_list", { p_email: email })),
  pageRecheckDone: async (email, id) => (await rpc("app_page_recheck_done", { p_email: email, p_id: id })) === true,
  people: async (email) => list(await rpc("admin_people_list", { p_email: email })),
  myNames: async (email) => obj(await rpc("app_my_names", { p_email: email })) ?? {},
  setMyNames: async (email, displayName, pageName) =>
    obj(await rpc("app_my_names_set", { p_email: email, p_display_name: displayName, p_page_name: pageName ?? "" })) ?? {},
  twoStep: (email, spec) => runTwoStep(spec, email),
  setModelKey: async (email, value) => {
    await rpc("app_secret_set", { p_email: email, p_name: "kbe_model_key", p_value: value });
  },
  timer: async (email) => obj(await rpc("app_timer_get", { p_email: email })) ?? {},
  setTimer: async (email, host, enabled) =>
    obj(await rpc("app_timer_set", { p_email: email, p_host: host, p_enabled: enabled })) ?? {},
  testTimer: async (email) => {
    const data = await rpc("app_timer_test", { p_email: email });
    return typeof data === "number" ? data : null;
  },
  timerResult: async (email, id) => obj(await rpc("app_timer_result", { p_email: email, p_request: id })),
  curatorHealth: async (email) => obj(await rpc("app_curator_health", { p_email: email })) ?? {},
  health: async (email) => obj(await rpc("app_health", { p_email: email })) ?? {},
  backup: async (email) => obj(await rpc("app_backup_get", { p_email: email })) ?? {},
  setBackup: async (email, repo, branch, enabled) =>
    obj(await rpc("app_backup_set", { p_email: email, p_repo: repo, p_branch: branch, p_enabled: enabled })) ?? {},
  requestBackup: async (email) => obj(await rpc("app_backup_request", { p_email: email })) ?? {},
  setBackupToken: async (email, value) => {
    await rpc("app_secret_set", { p_email: email, p_name: "kbe_backup_token", p_value: value });
  },
};
