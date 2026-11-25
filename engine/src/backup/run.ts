import { db } from "../db.js";
import { loadTemplates } from "../entities/templates.js";
import { allowOutboundHost } from "../http/outbound-allowlist.js";
import { logger } from "../log/logger.js";
import { GITHUB_API_HOST, GitHubError, pushFiles, type FetchLike } from "./github.js";
import { renderVault, type BackupPage, type LogEntry } from "./render.js";

/**
 * The nightly one-way backup, run from the curator tick (curator/run.ts).
 *
 *   1. backup_claim: due? (on, repo and token set, none in 20 hours, none
 *      running). Not due is the usual answer and costs one call.
 *   2. read every live page, a page of rows at a time, and the change log
 *   3. render the vault (render.ts) and commit it (github.ts)
 *   4. backup_finish with the result
 *
 * The token is read from the vault just before the push and is held in this
 * function only; it is never logged or stored anywhere else. Log lines and
 * the stored error carry the step and HTTP status only.
 */

export type BackupTarget = { readonly repo: string; readonly branch: string };

export type BackupStore = {
  readonly claim: () => Promise<BackupTarget | null>;
  readonly token: () => Promise<string | null>;
  readonly pages: (after: string | null, limit: number) => Promise<BackupPage[]>;
  readonly log: (limit: number) => Promise<LogEntry[]>;
  readonly finish: (ok: boolean, status: string | null, commit: string | null, files: number | null, error: string | null) => Promise<void>;
};

export type BackupDeps = {
  readonly store: BackupStore;
  readonly fetch: FetchLike;
  readonly now?: () => Date;
  readonly labels?: Readonly<Record<string, string>>;
  readonly allowHost?: (host: string) => void;
};

export type BackupOutcome = "not_due" | "done" | "unchanged" | "failed";

const PAGE_ROWS = 200;
const MAX_PAGES = 50_000;
const LOG_ROWS = 500;

async function allPages(store: BackupStore): Promise<BackupPage[]> {
  const out: BackupPage[] = [];
  let after: string | null = null;
  for (;;) {
    const batch = await store.pages(after, PAGE_ROWS);
    out.push(...batch);
    if (batch.length < PAGE_ROWS || out.length >= MAX_PAGES) return out;
    after = batch[batch.length - 1]?.id ?? null;
  }
}

/** Drawer labels from every template, first one wins. */
export function drawerLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const t of loadTemplates().values()) {
    for (const d of t.drawers) labels[d.id] ??= d.label;
  }
  return labels;
}

export async function runBackup(deps: BackupDeps): Promise<BackupOutcome> {
  const target = await deps.store.claim();
  if (!target) return "not_due";
  const now = (deps.now ?? (() => new Date()))();
  try {
    const token = await deps.store.token();
    if (!token) throw new Error("no GitHub token in the vault (kbe_backup_token)");
    const [pages, log] = await Promise.all([allPages(deps.store), deps.store.log(LOG_ROWS)]);
    const files = renderVault({ pages, log, now, labels: deps.labels ?? drawerLabels() });
    (deps.allowHost ?? allowOutboundHost)(GITHUB_API_HOST);
    const result = await pushFiles({
      token,
      repo: target.repo,
      branch: target.branch,
      files,
      message: `Engine backup ${now.toISOString().slice(0, 16).replace("T", " ")} UTC: ${pages.length} pages`,
      fetch: deps.fetch,
    });
    await deps.store.finish(true, result.status, result.commit, result.files, null);
    logger.info({ status: result.status, files: result.files }, "backup finished");
    return result.status;
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : err instanceof Error ? err.message : "backup failed";
    await deps.store.finish(false, null, null, null, message.slice(0, 300)).catch(() => undefined);
    logger.warn({ error: message.slice(0, 300) }, "backup failed");
    return "failed";
  }
}

// ── the live store (0056) ───────────────────────────────────────────────────

async function rpc(fn: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
  const { data, error } = await db().rpc(fn, args).abortSignal(AbortSignal.timeout(30_000));
  if (error) {
    logger.warn({ fn, code: error.code }, "backup RPC failed");
    throw new Error(`${fn} failed`);
  }
  return data;
}

const list = <T>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : []);

export const liveBackupStore: BackupStore = {
  claim: async () => {
    const data = (await rpc("backup_claim", { p_every_hours: 20 })) as Record<string, unknown> | null;
    return data && typeof data["repo"] === "string" ? { repo: data["repo"], branch: String(data["branch"] ?? "main") } : null;
  },
  token: async () => {
    const data = await rpc("backup_token");
    return typeof data === "string" && data !== "" ? data : null;
  },
  pages: async (after, limit) => list<BackupPage>(await rpc("backup_pages", { p_after: after, p_limit: limit })),
  log: async (limit) => list<LogEntry>(await rpc("backup_log", { p_limit: limit })),
  finish: async (ok, status, commit, files, error) => {
    await rpc("backup_finish", { p_ok: ok, p_status: status, p_commit: commit, p_files: files, p_error: error });
  },
};
