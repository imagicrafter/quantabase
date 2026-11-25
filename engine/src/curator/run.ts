import { entitySchema } from "../entities/templates.js";
import { DEFAULT_TUNING, type SummaryLength } from "./tuning.js";
import { logger } from "../log/logger.js";
import { alreadyHas, updatedPage, type Generated, type SourceRef } from "./apply.js";
import { curateItem, type CurateDeps } from "./curate.js";
import { extractJsonObject } from "./output.js";
import { DEFAULT_TRIAGE, doInference, outputLimit, type InferenceOptions, type ModelBackend } from "./model.js";
import { addUsage, emptyUsage, mergeUsage, usageStats, type Usage } from "./usage.js";
import { SUMMARY_SYSTEM, buildSummaryPrompt } from "./prompt.js";
import type { ApprovedReview, Store } from "./store.js";
import type { Patch } from "../entities/sections.js";
import { duplicateThresholds } from "./quality.js";
import { DeadlineError, HARD_CAP_MS, HEARTBEAT_MS, HOLDER, LEASE_SECONDS, withDeadline } from "./lease.js";

/**
 * One curator tick. In order:
 *   1. failed cron pokes since the last run (pg_cron says "succeeded" even
 *      when the HTTP call failed, so pg_net's response table is read)
 *   2. page history thinning
 *   3. the nightly GitHub backup, when one is due (backup/run.ts)
 *   4. when the curator is on and a model key is in the vault:
 *      approved reviews applied; new items curated (one claim in a tick,
 *      claims until none are left in batch mode); summaries and embeddings
 *      for pages marked "summary needed"
 * Only one run at a time, across instances (curator_run_start).
 */

export type TickMode = "tick" | "batch";

export type TickDeps = {
  readonly store: Store;
  readonly embed: (text: string) => Promise<number[]>;
  /** Builds the model backend; the default calls DigitalOcean. */
  readonly makeModel?: (model: string, key: string, opts?: InferenceOptions) => ModelBackend;
  readonly now?: () => Date;
  /** Milliseconds a run may spend before it stops starting new work. */
  readonly budgetMs?: number;
  /** The nightly GitHub backup (backup/run.ts); it decides itself whether one is due. */
  readonly backup?: () => Promise<string>;
  /** This process's id on the runs it starts (lease.ts). */
  readonly holder?: string;
  /** Milliseconds after which the run is recorded as failed, whatever it is waiting on. */
  readonly hardCapMs?: number;
  /** How often the run renews its lease. */
  readonly heartbeatMs?: number;
};

export type TickStats = Record<string, number | string | boolean | null>;

const BUDGET_MS: Record<TickMode, number> = { tick: 4 * 60_000, batch: 12 * 60_000 };
const SUMMARY_MIN = 20;
const SUMMARY_MAX = 800;

/** `over`: the budget is spent or the lease is lost. `lost`: the lease alone. */
type Clock = { readonly over: () => boolean; readonly lost: () => boolean };

function counter(): { stats: TickStats; add: (k: string, n?: number) => void } {
  const stats: TickStats = {};
  return { stats, add: (k, n = 1) => void (stats[k] = Number(stats[k] ?? 0) + n) };
}

async function applyReview(r: ApprovedReview, deps: TickDeps & { now: () => Date }): Promise<"applied" | "stale"> {
  const p = r.proposal;
  const ref = p["ref"] as SourceRef | undefined;
  if (!ref) return "stale";
  if (r.kind === "new_page") {
    await deps.store.savePage(r.item_id, p["page"] as Record<string, unknown>, null);
    return "applied";
  }
  const update = p["update"] as
    | { patches: Patch[]; fields: Record<string, string | number>; related?: readonly string[] }
    | undefined;
  const page = (await deps.store.candidates(r.item_id, [r.page_key], "", 1)).find((c) => c.key === r.page_key);
  if (!update || !page) return "stale";
  if (alreadyHas(page, r.item_id)) return "applied";
  const gen = (p["generated"] as Generated | undefined) ?? { by: "curator", model: "unknown", at: deps.now().toISOString() };
  // Patches are anchored by section, so they usually still apply to a page
  // that changed since; if not, the review goes stale for a person to redo.
  await deps.store.savePage(r.item_id, updatedPage(page, update, ref, gen), page.content_hash);
  return "applied";
}

async function applyReviews(deps: TickDeps & { now: () => Date }, add: (k: string) => void): Promise<void> {
  for (const r of await deps.store.approvedReviews(20)) {
    try {
      const result = await applyReview(r, deps);
      await deps.store.markReview(r.id, result);
      add(result === "applied" ? "reviews_applied" : "reviews_stale");
    } catch (err) {
      await deps.store.markReview(r.id, "stale", err instanceof Error ? err.message : "could not apply");
      add("reviews_stale");
    }
  }
}

/** Parse a summary reply; null when it is not a usable summary. */
export function parseSummary(text: string): string | null {
  try {
    const value = (JSON.parse(extractJsonObject(text)) as Record<string, unknown>)["summary"];
    if (typeof value !== "string") return null;
    const s = value.replace(/\s+/g, " ").trim();
    return s.length >= SUMMARY_MIN && s.length <= SUMMARY_MAX ? s : null;
  } catch {
    return null;
  }
}

/**
 * The Cataloguer and the Index clerk (0075): a summary for each queued page,
 * then its embedding, filed together. An unusable reply or a model error is a
 * Cataloguer failure (summary_failed); a good summary that cannot be embedded
 * or saved is an Index clerk failure (index_failed). Either way the page stays
 * queued for the next run. Their model cost is also kept apart (usd_summaries).
 */
async function writeSummaries(
  deps: TickDeps,
  model: ModelBackend,
  modelName: string,
  length: SummaryLength,
  clock: Clock,
  add: (k: string) => void,
): Promise<Usage> {
  let usage = emptyUsage();
  for (const page of await deps.store.summaryQueue(20)) {
    if (clock.over()) break;
    let summary: string | null;
    try {
      const reply = await model.complete(SUMMARY_SYSTEM, buildSummaryPrompt(page, length), 600);
      usage = addUsage(usage, modelName, reply);
      summary = parseSummary(reply.text);
    } catch {
      summary = null;
    }
    if (!summary) {
      add("summary_failed");
      continue;
    }
    try {
      const written = await deps.store.writeSummary(page.id, page.summary_queued_at, summary, await deps.embed(summary));
      add(written ? "summaries" : "summary_raced");
    } catch {
      add("index_failed");
    }
  }
  return usage;
}

/**
 * The Cataloguer's own cost keys, only when it called the model. No
 * usd_summaries when the model has no price: a 0 would pull the redo
 * estimate (cost per summary) down.
 */
function summaryStats(u: Usage, modelName: string): Record<string, number | string> {
  if (Object.keys(u).length === 0) return {};
  const priced = Object.values(u).every((m) => m.usd !== null);
  return { ...(priced ? { usd_summaries: usageStats(u)["usd"] ?? 0 } : {}), summary_model: modelName };
}

async function curateItems(
  deps: CurateDeps, mode: TickMode, batchSize: number, clock: Clock, add: (k: string, n?: number) => void, note: (u: Usage | undefined) => void,
) {
  // The budget is checked before each claim; a claimed batch is finished,
  // unless the run lost its lease (another run may now hold the curator).
  // Items left then keep their claim lease and are retried later.
  while (!clock.over()) {
    const items = await deps.store.claim(batchSize);
    for (const item of items) {
      if (clock.lost()) {
        add("deferred");
        continue;
      }
      try {
        const result = await curateItem(item, deps);
        add("items");
        add(result.outcome);
        add("queued_changes", result.queued);
        if (result.consensus) add(`consensus_${result.consensus}`);
        add("tokens", result.tokens ?? 0);
        note(result.usage);
        if (result.triaged) add("triage_no_change");
        if (result.escalated) add("escalated");
        if (result.dropped) add("reply_parts_dropped", result.dropped.length);
        if (result.repaired) add("reply_parts_repaired", result.repaired.length);
      } catch (err) {
        await deps.store.done(item.id, "failed", [], err instanceof Error ? err.message : "error").catch(() => undefined);
        add("items");
        add("failed");
      }
    }
    if (mode === "tick" || items.length === 0) return;
  }
}

async function curatorWork(deps: TickDeps & { now: () => Date }, mode: TickMode, clock: Clock, stats: TickStats, add: (k: string, n?: number) => void) {
  const settings = await deps.store.settings();
  stats["enabled"] = settings.enabled;
  stats["model"] = settings.model;
  if (!settings.enabled) return;
  const key = settings.hasModelKey ? await deps.store.modelKey() : null;
  if (!key) {
    stats["error"] = "no model key in the vault (kbe_model_key)";
    return;
  }
  // The Pipeline screen's choices (0071), read first: the budget rule may switch the writer.
  const tuning = await (deps.store.pipeline?.() ?? Promise.resolve(DEFAULT_TUNING)).catch((err: unknown) => {
    logger.warn({ error: err instanceof Error ? err.message : "error" }, "curator: pipeline settings not read; defaults used");
    return DEFAULT_TUNING;
  });
  if (tuning.paused) {
    stats["paused"] = true;
    return;
  }
  const consensus = await deps.store.consensus().catch(() => ({
    enabled: false, tiebreakModel: "", strongModel: undefined as string | undefined, maxOutputTokens: {} as Record<string, number>,
  }));
  // Each model asks for its own output limit (model.ts), which
  // curator_settings.max_output_tokens may override per model (0068).
  const make = (name: string) =>
    (deps.makeModel ?? doInference)(name, key, { maxOutputTokens: outputLimit(name, consensus.maxOutputTokens ?? {}) });
  const model = make(settings.model);
  const schema = entitySchema(settings.templates);
  stats["consensus"] = consensus.enabled;
  const spend = { usage: emptyUsage() };
  const note = (u: Usage | undefined) => void (spend.usage = mergeUsage(spend.usage, u ?? emptyUsage()));
  await applyReviews(deps, add);
  // The owner and account users never get a person page (0070); a failed read leaves only the item's owner.
  const people = await (deps.store.accountPeople?.() ?? Promise.resolve([])).catch((err: unknown) => {
    logger.warn({ error: err instanceof Error ? err.message : "error" }, "curator: account people not read");
    return [];
  });
  const curate = { ...curateDeps(deps, settings.model, model, schema, consensus, make, stats), people, tuning };
  await curateItems(curate, mode, settings.batchSize, clock, add, note);
  const summaries = await writeSummaries(deps, model, settings.model, tuning.summaryLength ?? "standard", clock, add);
  note(summaries);
  Object.assign(stats, usageStats(spend.usage), summaryStats(summaries, settings.model));
  await scanDuplicates(deps, schema, stats);
}

type ModelSettings = Awaited<ReturnType<Store["consensus"]>>;

/**
 * How items are decided. Consensus off and 0069 applied (a writer model is
 * set): one writer, after triage when it is on. Otherwise the consensus
 * pipeline, with the strong model, exactly as before.
 */
function curateDeps(
  deps: TickDeps & { now: () => Date }, primary: string, model: ModelBackend, schema: ReturnType<typeof entitySchema>,
  s: ModelSettings, make: (name: string) => ModelBackend, stats: TickStats,
): CurateDeps {
  const base = { store: deps.store, schema, now: deps.now, embed: deps.embed };
  if (!s.enabled && s.writerModel) {
    stats["writer_model"] = s.writerModel;
    stats["triage_model"] = s.triage === false ? null : s.triageModel ?? DEFAULT_TRIAGE;
    const triageName = s.triageModel ?? DEFAULT_TRIAGE;
    return {
      ...base, model: make(s.writerModel), modelName: s.writerModel,
      writer: s.triage === false ? {} : { triage: { model: make(triageName), name: triageName } },
    };
  }
  stats["strong_model"] = s.strongModel ?? null;
  return {
    ...base, model, modelName: primary,
    ...(s.enabled ? { consensus: { tiebreak: make(s.tiebreakModel), tiebreakName: s.tiebreakModel } } : {}),
    ...(s.strongModel ? { strong: { model: make(s.strongModel), name: s.strongModel } } : {}),
  };
}

/**
 * The nightly look-alike check (0067 decides whether it is due): pairs go on
 * the owner's "Possible duplicates" list; nothing is merged here.
 */
async function scanDuplicates(deps: TickDeps, schema: ReturnType<typeof entitySchema>, stats: TickStats): Promise<void> {
  const t = duplicateThresholds(schema);
  try {
    const n = await deps.store.duplicatesScan(t.fallback, t.byDrawer);
    if (n >= 0) stats["duplicates_found"] = n;
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : "error" }, "curator: duplicate scan failed");
    stats["duplicates_scan"] = "failed";
  }
}

async function chores(deps: TickDeps & { now: () => Date }, mode: TickMode, clock: Clock, stats: TickStats, add: (k: string, n?: number) => void) {
  const since = (await deps.store.lastRunAt()) ?? new Date(deps.now().getTime() - 3_600_000).toISOString();
  const pokes = await deps.store.pokeFailures(since);
  stats["poke_failures"] = pokes.failed;
  if (pokes.failed > 0) {
    stats["last_poke_error"] = pokes.lastError;
    logger.warn({ failed: pokes.failed, last_error: pokes.lastError }, "curator: cron pokes failed since the last run");
  }
  stats["history_pruned"] = await deps.store.pruneHistory();
  if (deps.backup) stats["backup"] = await deps.backup().catch(() => "failed");
  await curatorWork(deps, mode, clock, stats, add);
}

/** Renew the lease every interval; `lost()` turns true once the run was reclaimed. */
function keepLease(deps: TickDeps, run: string): { stop: () => void; lost: () => boolean } {
  let lost = false;
  const timer = setInterval(() => {
    deps.store
      .heartbeat(run, LEASE_SECONDS)
      .then((held) => {
        if (!held && !lost) {
          lost = true;
          logger.warn({ run }, "curator run lost its lease; it stops starting new work");
        }
      })
      .catch((err: unknown) => logger.warn({ error: err instanceof Error ? err.message : "error" }, "curator heartbeat failed"));
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), lost: () => lost };
}

/** Run one tick now. Returns null when another run holds the lease. */
export async function runTick(mode: TickMode, deps: TickDeps): Promise<TickStats | null> {
  const now = deps.now ?? (() => new Date());
  const run = await deps.store.runStart(mode, deps.holder ?? HOLDER, LEASE_SECONDS);
  if (!run) {
    logger.info({ mode }, "curator run skipped: another run holds the lease");
    return null;
  }
  logger.info({ mode, run }, "curator run started");
  const lease = keepLease(deps, run);
  const full = { ...deps, now };
  const until = Date.now() + (deps.budgetMs ?? BUDGET_MS[mode]);
  const clock: Clock = { over: () => Date.now() > until || lease.lost(), lost: lease.lost };
  const { stats, add } = counter();
  try {
    await withDeadline(chores(full, mode, clock, stats, add), deps.hardCapMs ?? HARD_CAP_MS, "curator run");
    await deps.store.runFinish(run, true, stats);
    logger.info({ mode, ...stats }, "curator run finished");
    return stats;
  } catch (err) {
    stats["error"] = err instanceof Error ? err.message : "run failed";
    await deps.store.runFinish(run, false, stats).catch(() => undefined);
    logger.error({ mode, error: stats["error"], timed_out: err instanceof DeadlineError }, "curator run failed");
    return stats;
  } finally {
    lease.stop();
    await syncTickets(deps.store);
  }
}

/** The ticket checks after every run (0072). Never fails a run; an older database just lacks the function. */
async function syncTickets(store: Store): Promise<void> {
  try {
    await store.ticketsSync();
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : "failed" }, "curator: ticket checks failed");
  }
}
