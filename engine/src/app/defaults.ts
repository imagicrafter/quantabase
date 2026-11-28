import { invalidateSettings } from "../config/settings.js";
import { env } from "../env.js";
import { setupDeps } from "../setup/defaults.js";
import { currentMode } from "../setup/mode.js";
import { embedText } from "../supabase.js";
import { createCsrf } from "./csrf.js";
import { checkHostReaches } from "./host-check.js";
import { findRepoDir, repoSqlFiles } from "./db-setup.js";
import { bootCode } from "./first-run.js";
import type { FirstRunRouteDeps, HeldVerdict } from "./first-run-routes.js";
import { attemptCheck, codeValid } from "../setup/db.js";
import { refFromUrl } from "./mgmt.js";
import type { SettingsDeps } from "./settings-routes.js";
import { liveStore, migrationsApplied } from "./store.js";
import type { DatabaseDeps } from "./db-update.js";
import { allowOutboundHost } from "../http/outbound-allowlist.js";
import { SUPABASE_API_HOST } from "./first-run.js";
import { createReleaseCheck, RELEASE_HOST } from "./release-check.js";
import type { UpdatesDeps } from "./updates-routes.js";
import { ENGINE_VERSION } from "../version.js";
import { liveFirefliesScreens } from "../fireflies/defaults.js";

/** The app screens' real dependencies, read on every request. */

const csrf = createCsrf(env.SUPABASE_JWT_SECRET);

/** The Database screen after sign-in, and the boot check (db-update.ts). */
export const liveDatabase = (): DatabaseDeps => ({
  projectRef: refFromUrl(env.SUPABASE_URL),
  kbSchema: env.KB_SCHEMA,
  files: () => {
    const dir = findRepoDir();
    return dir ? repoSqlFiles(dir) : null;
  },
  // The Management API host joins the outbound allowlist only when an
  // administrator runs an update.
  fetch: (url, init) => {
    allowOutboundHost(SUPABASE_API_HOST);
    return fetch(url, init);
  },
  applied: migrationsApplied,
});

/** The Updates screen: one checker for the process, so its hour-long cache holds. */
const releaseCheck = createReleaseCheck({
  repo: env.QB_RELEASE_REPO,
  // raw.githubusercontent.com joins the outbound allowlist only when an
  // administrator opens the Updates screen.
  fetch: (url, init) => {
    allowOutboundHost(RELEASE_HOST);
    return fetch(url, init);
  },
  now: Date.now,
});
const liveUpdates: UpdatesDeps = {
  running: ENGINE_VERSION,
  appId: env.APP_ID ?? null,
  check: () => releaseCheck(ENGINE_VERSION),
};

const liveScreens = (): SettingsDeps => ({
  mode: currentMode,
  guard: setupDeps().guard,
  store: liveStore,
  csrf,
  now: Date.now,
  embedCheck: async () => (await embedText("health check")).length > 0,
  embed: embedText,
  hostCheck: (host) => checkHostReaches(host),
  database: liveDatabase(),
  updates: liveUpdates,
  fireflies: liveFirefliesScreens,
});

const liveFirstRun = (): FirstRunRouteDeps => ({
  boot: bootCode,
  envCode: env.SETUP_CODE,
  mode: currentMode,
  projectRef: refFromUrl(env.SUPABASE_URL),
  kbSchema: env.KB_SCHEMA,
  jwtSecret: env.SUPABASE_JWT_SECRET,
  anonKey: env.SUPABASE_ANON_KEY,
  files: () => {
    const dir = findRepoDir();
    return dir ? repoSqlFiles(dir) : null;
  },
  // The process-wide fetch, which the outbound allowlist limits; the first
  // run adds api.supabase.com to it (first-run.ts).
  fetch: (url, init) => fetch(url, init),
  onDatabaseReady: invalidateSettings,
  confirmHeld: confirmHeldClaim,
});

/** A resumed claim: the database's lockout first, then its own check of the code's hash. */
async function confirmHeldClaim(code: string): Promise<HeldVerdict> {
  const before = await attemptCheck();
  if (before.locked) return { ok: false, locked: true, retryAfterSeconds: before.retry_after_seconds };
  if (await codeValid(code)) return { ok: true };
  // engine_setup_code_valid counted the wrong code; ask whether that locked it.
  const after = await attemptCheck();
  return { ok: false, locked: after.locked, retryAfterSeconds: after.retry_after_seconds };
}

let screens: () => SettingsDeps = liveScreens;
let firstRun: () => FirstRunRouteDeps = liveFirstRun;

export const screenDeps = (): SettingsDeps => screens();
export const firstRunDeps = (): FirstRunRouteDeps => firstRun();

/** Tests only: replace some dependencies; pass nothing to restore them. */
export function _setAppDepsForTests(over?: {
  screens?: Partial<SettingsDeps>;
  firstRun?: Partial<FirstRunRouteDeps>;
}): void {
  screens = over?.screens ? () => ({ ...liveScreens(), ...over.screens }) : liveScreens;
  firstRun = over?.firstRun ? () => ({ ...liveFirstRun(), ...over.firstRun }) : liveFirstRun;
}
