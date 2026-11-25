import { z } from "zod";
import { env } from "../env.js";
import { allowOutboundHost } from "../http/outbound-allowlist.js";
import { logger } from "../log/logger.js";
import { db } from "../db.js";
import { validateEngineConfig, type EngineConfig } from "./engine-config.js";

/**
 * Engine settings: the applied config and the sign-in settings.
 *
 * Both live in the database (workspace.engine_settings) and are read through
 * one function, engine_settings_public(), which never returns the setup code
 * hash. The read is cached for a minute, or for a few seconds while the
 * Engine has no sign-in settings, so it leaves setup mode soon after setup
 * completes even if another process completed it.
 *
 * Sign-in settings come from the environment when the four variables are set
 * (see env.ts), otherwise from the database. With neither, `access` is null
 * and every protected route must answer 503: never open.
 */

export type AccessSettings = {
  /** Assertion issuer and JWKS host, e.g. https://acme.cloudflareaccess.com */
  readonly teamDomain: string;
  /** AUD tag of the sign-in app in front of /mcp. */
  readonly aud: string;
  /** AUD tag of the separate sign-in app in front of /status, if known. */
  readonly statusAud: string | undefined;
  /** The only Host header the app answers to. */
  readonly host: string;
  /** Canonical MCP URL, e.g. https://engine.example.com/mcp */
  readonly resourceUrl: string;
  readonly source: "environment" | "database";
  /** The access level chosen at setup ("owner", "people" or "domain"), if recorded. */
  readonly level?: string | undefined;
  /** The sign-in length chosen at setup (also the connector's approval length), if recorded. */
  readonly session?: string | undefined;
};

export type Settings = {
  /** null when no config has been applied, or the stored one is invalid. */
  readonly config: EngineConfig | null;
  readonly access: AccessSettings | null;
  readonly setupState: "open" | "complete" | null;
  /**
   * The database holds sign-in settings, but they are not usable. This is
   * NOT the same as "not set up": see setup/mode.ts.
   */
  readonly accessInvalid?: boolean;
  /**
   * The Engine's schema or settings function is not in the database yet: a
   * fresh project before the Database setup screen has run. Treated as
   * "not set up" (setup/mode.ts), never as broken settings.
   */
  readonly databaseMissing?: boolean;
};

/** The database could not be read. Callers answer 503. */
export class SettingsUnavailableError extends Error {}

type AccessEnv = Pick<
  typeof env,
  | "CF_ACCESS_TEAM_DOMAIN"
  | "CF_ACCESS_AUD"
  | "CF_ACCESS_STATUS_AUD"
  | "OAUTH_RESOURCE_URL"
  | "EXPECTED_HOST"
>;

/** Sign-in settings from the environment, or null unless all four are set. */
export function accessFromEnv(e: Partial<AccessEnv>): AccessSettings | null {
  const teamDomain = e.CF_ACCESS_TEAM_DOMAIN;
  const aud = e.CF_ACCESS_AUD;
  const resourceUrl = e.OAUTH_RESOURCE_URL;
  const host = e.EXPECTED_HOST;
  if (!teamDomain || !aud || !resourceUrl || !host) return null;
  return {
    teamDomain,
    aud,
    statusAud: e.CF_ACCESS_STATUS_AUD,
    host,
    resourceUrl,
    source: "environment",
  };
}

/**
 * What setup stores. The team domain must be a Cloudflare Access team domain:
 * it becomes the host signing keys are fetched from, so a stored value is
 * never trusted to name an arbitrary host.
 */
const StoredAccess = z.object({
  team_domain: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname.endsWith(".cloudflareaccess.com")
      );
    }, "must be https://<team>.cloudflareaccess.com"),
  aud: z.string().min(1),
  status_aud: z.string().min(1).optional(),
  host: z.string().regex(/^[a-z0-9.-]+$/i, "must be a bare hostname"),
  resource_url: z.string().url().optional(),
  level: z.string().max(40).optional(),
  session: z.string().max(10).optional(),
});

/** Sign-in settings from the database row, or null when absent or invalid. */
export function accessFromDatabase(raw: unknown): AccessSettings | null {
  if (raw === null || raw === undefined) return null;
  const parsed = StoredAccess.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      { problems: parsed.error.issues.map((i) => i.message) },
      "stored sign-in settings are invalid; treating the Engine as not set up",
    );
    return null;
  }
  const a = parsed.data;
  return {
    teamDomain: a.team_domain.replace(/\/$/, ""),
    aud: a.aud,
    statusAud: a.status_aud,
    host: a.host,
    resourceUrl: a.resource_url ?? `https://${a.host}/mcp`,
    source: "database",
    level: a.level,
    session: a.session,
  };
}

function configFromDatabase(raw: unknown): EngineConfig | null {
  if (raw === null || raw === undefined) return null;
  try {
    return validateEngineConfig(raw);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "stored Engine config is invalid; treating the Engine as not configured",
    );
    return null;
  }
}

const Row = z.object({
  config: z.unknown().optional(),
  access: z.unknown().optional(),
  setup_state: z.enum(["open", "complete"]).nullable().optional(),
  uninstalled: z.literal(true).optional(),
});

export type SettingsStoreDeps = {
  /** Returns what workspace.engine_settings_public() returns. */
  readonly read: () => Promise<unknown>;
  readonly envAccess: AccessSettings | null;
  readonly now?: () => number;
  readonly ttlMs?: number;
  /** How long an answer with no sign-in settings is kept. */
  readonly setupTtlMs?: number;
};

export type SettingsStore = {
  /** Config + sign-in settings. Throws SettingsUnavailableError if unreadable. */
  readonly get: () => Promise<Settings>;
  /** Sign-in settings only. Never touches the database when the env has them. */
  readonly access: () => Promise<AccessSettings | null>;
  /** Drop the cached answer, so the next read asks the database. */
  readonly invalidate: () => void;
};

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_SETUP_TTL_MS = 5_000;

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const setupTtlMs = Math.min(deps.setupTtlMs ?? DEFAULT_SETUP_TTL_MS, ttlMs);
  let cached: { readonly at: number; readonly value: Settings } | undefined;

  const get = async (): Promise<Settings> => {
    if (cached) {
      const keepFor = cached.value.access ? ttlMs : setupTtlMs;
      if (now() - cached.at < keepFor) return cached.value;
    }
    let raw: unknown;
    try {
      raw = await deps.read();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new SettingsUnavailableError(`engine settings unavailable: ${why}`);
    }
    const row = Row.safeParse(raw ?? {});
    if (!row.success) {
      throw new SettingsUnavailableError("engine settings have a bad shape");
    }
    const stored = row.data.access;
    const fromDatabase = accessFromDatabase(stored);
    const value: Settings = {
      config: configFromDatabase(row.data.config),
      access: deps.envAccess ?? fromDatabase,
      setupState: row.data.setup_state ?? null,
      databaseMissing: row.data.uninstalled === true,
      accessInvalid:
        !deps.envAccess &&
        stored !== null &&
        stored !== undefined &&
        fromDatabase === null,
    };
    cached = { at: now(), value };
    return value;
  };

  return {
    get,
    access: async () => deps.envAccess ?? (await get()).access,
    invalidate: () => {
      cached = undefined;
    },
  };
}

/**
 * Errors that mean "nothing is installed here yet": the schema is not exposed
 * (PGRST106), the function does not exist (PGRST202, 42883) or the schema does
 * not exist (3F000). Anything else is a real failure.
 */
export const NOT_INSTALLED_CODES: ReadonlySet<string> = new Set(["PGRST106", "PGRST202", "42883", "3F000"]);

/** True for the answers a fresh, empty project gives (see NOT_INSTALLED_CODES). */
export function isNotInstalled(error: { code?: string; message?: string }): boolean {
  if (error.code && NOT_INSTALLED_CODES.has(error.code)) return true;
  // Before the migrations the service's own database role does not exist yet.
  return error.code === "22023" && /role "kb_engine" does not exist/.test(error.message ?? "");
}

async function readFromDatabase(): Promise<unknown> {
  const { data, error } = await db()
    .rpc("engine_settings_public");
  if (error) {
    if (isNotInstalled(error)) return { uninstalled: true };
    throw new Error(error.message);
  }
  return data;
}

let store: SettingsStore = createSettingsStore({
  read: readFromDatabase,
  envAccess: accessFromEnv(env),
});

/** Replace the process-wide store. Tests only; pass nothing to restore it. */
export function _setSettingsStoreForTests(replacement?: SettingsStore): void {
  store =
    replacement ??
    createSettingsStore({
      read: readFromDatabase,
      envAccess: accessFromEnv(env),
    });
}

/** Drop the cached settings. Called when setup completes. */
export function invalidateSettings(): void {
  store.invalidate();
}

/** Config + sign-in settings for this process. */
export function currentSettings(): Promise<Settings> {
  return store.get();
}

/**
 * Sign-in settings for this process, or null when the Engine is not set up.
 * A caller that gets null must refuse the request (503), never let it through.
 */
export async function currentAccess(): Promise<AccessSettings | null> {
  const access = await store.access();
  if (access?.source === "database") {
    allowOutboundHost(new URL(access.teamDomain).hostname);
  }
  return access;
}
