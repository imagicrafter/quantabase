import { logger } from "../log/logger.js";
import type { EngineMode } from "../setup/mode.js";
import {
  migrationsStep,
  projectStep,
  runSteps,
  schemaStep,
  SCHEMA,
  type CoreInputs,
  type SqlFiles,
  type StepReport,
  type StepStatus,
} from "./db-setup.js";
import { esc } from "./html.js";
import type { FetchLike, Mgmt } from "./mgmt.js";
import { AppMissingFunctionError } from "./store.js";

/**
 * Keeping a set-up Engine's database in step with the app (the Database
 * screen after sign-in, /setup/database).
 *
 * An app update can ship new migrations. Until they are applied, the screens
 * that call the new functions fail with PostgREST's PGRST202 ("function not
 * found"). This module:
 *
 *   - works out which shipped migration files the database has not applied
 *     (engine_migrations_applied, migration 0059; before 0059 is applied, the
 *     newest applied name from app_health, or at least 0059 itself)
 *   - draws the "Database update needed: N pending" banner
 *   - applies only the pending files and re-exposes the schema, with the
 *     first-run Database screen's own steps (db-setup.ts)
 *   - logs the pending files at boot
 *
 * The Supabase access token is the person's, typed into the form, used for
 * one request and never stored, logged or shown (mgmt.ts).
 */

/** The migration that adds engine_migrations_applied(). */
export const LIST_MIGRATION = "0059_migrations_applied.sql";

export type DatabaseDeps = {
  readonly projectRef: string | null;
  readonly kbSchema: string;
  /** The repository's SQL files shipped with the app; null when absent. */
  readonly files: () => SqlFiles | null;
  readonly fetch: FetchLike;
  /** The applied file names (engine_migrations_applied). */
  readonly applied: () => Promise<readonly string[]>;
};

export type MigrationState = {
  /** False when it could not be worked out: no banner, the screen says so. */
  readonly known: boolean;
  /** False when the applied list is an estimate (the list function is missing). */
  readonly exact: boolean;
  readonly shipped: number;
  readonly applied: number;
  readonly pending: readonly string[];
};

const UNKNOWN: MigrationState = { known: false, exact: false, shipped: 0, applied: 0, pending: [] };

function shippedNames(deps: DatabaseDeps): string[] | null {
  try {
    const files = deps.files();
    return files ? files.migrations().map((f) => f.name) : null;
  } catch {
    return null;
  }
}

/**
 * Pending = shipped files not applied. `newestApplied`, when given, is used
 * only if the list function itself is missing (a database from before 0059).
 */
export async function migrationState(
  deps: DatabaseDeps,
  newestApplied?: () => Promise<string | null>,
): Promise<MigrationState> {
  const shipped = shippedNames(deps);
  if (!shipped) return UNKNOWN;
  try {
    const done = new Set(await deps.applied());
    const pending = shipped.filter((n) => !done.has(n));
    return { known: true, exact: true, shipped: shipped.length, applied: shipped.length - pending.length, pending };
  } catch (err) {
    if (!(err instanceof AppMissingFunctionError)) return UNKNOWN;
  }
  let newest: string | null = null;
  try {
    newest = newestApplied ? await newestApplied() : null;
  } catch {
    newest = null;
  }
  const pending = newest
    ? shipped.filter((n) => n > newest)
    : shipped.filter((n) => n >= LIST_MIGRATION);
  return { known: true, exact: false, shipped: shipped.length, applied: shipped.length - pending.length, pending };
}

/**
 * The state for an administrator's screen: the fallback reads the newest
 * applied name from app_health (0054). Unknown when the app has no database deps.
 */
export function adminMigrationState(
  deps: DatabaseDeps | undefined,
  health: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<MigrationState> {
  if (!deps) return Promise.resolve(UNKNOWN);
  return migrationState(deps, async () => {
    const m = (await health())["migrations"];
    const latest = m && typeof m === "object" ? (m as Record<string, unknown>)["latest"] : null;
    return typeof latest === "string" ? latest : null;
  });
}

/** The banner for the Health, Indexing and Database screens; "" when nothing is pending. */
export function updateBanner(state: MigrationState): string {
  if (!state.known || state.pending.length === 0) return "";
  const n = state.pending.length;
  const count = state.exact ? `${n}` : `at least ${n}`;
  return `<div class="card errors" role="alert"><p><strong>Database update needed: ${esc(count)} pending.</strong> This app was updated and its database was not. <a href="/setup/database">Update the database</a></p></div>`;
}

/** For a screen with no administrator context (the owner screens): no count. */
export const UPDATE_NEEDED_TEXT =
  "Database update needed: this app was updated and its database was not. An administrator can apply the update on the Database screen (/setup/database).";

// ── the update ──────────────────────────────────────────────────────────────

export const UPDATE_STEPS: ReadonlyArray<{ readonly id: string; readonly title: string }> = [
  { id: "project", title: "Check the Supabase project" },
  { id: "migrations", title: "Apply the pending migrations" },
  { id: "schema", title: "Re-expose the Engine's schema to the Data API" },
];

type Runner = (inputs: CoreInputs) => Promise<{ readonly status: StepStatus; readonly note?: string }>;

/** Expose the schema if it is not, then tell the Data API to reload its cache (new functions). */
const exposeAndReload: Runner = async (inputs) => {
  const out = await schemaStep(inputs);
  await inputs.mgmt.sql("notify pgrst, 'reload schema';");
  return out.status === "unchanged"
    ? { status: "done", note: "Already exposed; the Data API was told to reload. It can take up to a minute." }
    : out;
};

const UPDATE_RUNNERS: Readonly<Record<string, Runner>> = {
  project: projectStep,
  migrations: migrationsStep,
  schema: exposeAndReload,
};

export type DbUpdateInputs = {
  readonly mgmt: Mgmt;
  readonly files: SqlFiles;
  readonly kbSchema: string;
  readonly now?: () => number;
};

/** Apply only the pending migrations and re-expose the schema; stop at the first failure. */
export async function runDbUpdate(inputs: DbUpdateInputs): Promise<{ readonly ok: boolean; readonly steps: readonly StepReport[] }> {
  if (inputs.kbSchema !== SCHEMA) {
    return {
      ok: false,
      steps: [{ id: "project", title: "Check the Supabase project", status: "failed", note: `This screen updates the default schema only. For KB_SCHEMA=${inputs.kbSchema} use \`kbe db migrate\`.` }],
    };
  }
  return runSteps(UPDATE_STEPS, UPDATE_RUNNERS, { mgmt: inputs.mgmt, files: inputs.files }, inputs.now ?? Date.now);
}

// ── at boot ─────────────────────────────────────────────────────────────────

/** Log the pending migrations by name once the Engine is set up. Never throws. */
export async function warnPendingAtBoot(
  deps: DatabaseDeps,
  mode: () => Promise<EngineMode>,
): Promise<readonly string[]> {
  try {
    if ((await mode()).kind !== "ready") return [];
  } catch {
    return [];
  }
  const state = await migrationState(deps);
  if (!state.known) {
    logger.warn("database: could not check for pending migrations");
    return [];
  }
  if (state.pending.length === 0) return [];
  logger.warn(
    { pending: state.pending, count: state.pending.length, exact: state.exact },
    `database update needed: ${state.pending.length} pending migration(s); an administrator can apply them at /setup/database`,
  );
  return state.pending;
}
