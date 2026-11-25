import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../log/logger.js";
import { liveBackupStore, runBackup } from "../backup/run.js";
import { embedText } from "../supabase.js";
import { runTick, type TickDeps, type TickMode } from "./run.js";
import { store as defaultStore } from "./store.js";
import { HARD_CAP_MS } from "./lease.js";

/**
 * POST /internal/curator/tick, the address Supabase cron pokes (test A3:
 * pg_cron + pg_net, secret kept in Vault).
 *
 * Guarded by a shared secret in the X-Kbe-Tick header. The service never
 * holds the secret: it hands what arrived to curator_tick_secret_ok, which
 * compares it with the vault copy. Wrong or missing: 401 with no detail.
 *
 * The run is started and the call answered at once (202), because pg_net
 * gives up after a few seconds and would record a long run as a failure.
 * A second poke while a run is going answers 200 {busy: true}.
 */

export const TICK_PATH = "/internal/curator/tick";
export const TICK_HEADER = "x-kbe-tick";

const Body = z.object({ mode: z.enum(["tick", "batch"]).default("tick") }).strict();

export type TickOutcome = "started" | "busy" | "skipped" | "failed";

export type TickRouteDeps = {
  readonly checkSecret: (secret: string) => Promise<boolean>;
  readonly start: (mode: TickMode) => Promise<unknown>;
  /** Records a poke that carried the right secret (curator_tick_seen). */
  readonly seen?: (outcome: TickOutcome) => Promise<void>;
  /** After this long the in-process guard is treated as stale. */
  readonly staleMs?: number;
  readonly clock?: () => number;
};

/** A little past the run's own hard deadline (lease.ts). */
const STALE_GUARD_MS = HARD_CAP_MS + 60_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "error";
}

const defaultTickDeps: TickDeps = {
  store: defaultStore,
  embed: embedText,
  backup: () => runBackup({ store: liveBackupStore, fetch: (url, init) => fetch(url, init) }),
};

export const defaultRouteDeps: TickRouteDeps = {
  checkSecret: (secret) => defaultStore.tickSecretOk(secret),
  start: (mode) => runTick(mode, defaultTickDeps),
  seen: (outcome) => defaultStore.tickSeen(outcome),
};

/**
 * Every poke writes exactly one log line: "curator tick accepted",
 * "curator tick busy", or "curator tick rejected" (with the reason). A run
 * that then fails or is skipped logs its own line (run.ts).
 */
export function makeTickRoute(deps: TickRouteDeps = defaultRouteDeps): Hono {
  const app = new Hono();
  const clock = deps.clock ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_GUARD_MS;
  let running: { readonly since: number } | null = null;

  const note = (outcome: TickOutcome) => {
    if (!deps.seen) return;
    deps.seen(outcome).catch((err: unknown) => logger.warn({ error: errorText(err) }, "curator tick: could not record the poke"));
  };

  app.post("/", async (c) => {
    const secret = c.req.header(TICK_HEADER) ?? "";
    let ok = false;
    try {
      ok = secret.length >= 32 && secret.length <= 512 && (await deps.checkSecret(secret));
    } catch (err) {
      logger.warn({ reason: "secret check failed", error: errorText(err) }, "curator tick rejected");
      return c.json({ error: { code: "unavailable", message: "Unavailable" } }, 503);
    }
    if (!ok) {
      logger.warn({ reason: secret ? "wrong secret" : "no secret" }, "curator tick rejected");
      return c.json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
    }

    const raw = await c.req.json().catch(() => ({}));
    const parsed = Body.safeParse(raw ?? {});
    if (!parsed.success) {
      logger.warn({ reason: "bad body" }, "curator tick rejected");
      return c.json({ error: { code: "invalid_argument", message: "Bad body" } }, 400);
    }
    const mode = parsed.data.mode;

    if (running) {
      const age = clock() - running.since;
      if (age < staleMs) {
        logger.info({ mode, running_for_s: Math.round(age / 1000) }, "curator tick busy");
        note("busy");
        return c.json({ busy: true }, 200);
      }
      logger.warn({ running_for_s: Math.round(age / 1000) }, "curator tick: the run in this process is stale; starting anew");
    }
    const mine = { since: clock() };
    running = mine;
    logger.info({ mode }, "curator tick accepted");
    note("started");
    void Promise.resolve()
      .then(() => deps.start(mode))
      .then((result) => {
        // runTick answers null when another run holds the database lease.
        if (result === null) note("skipped");
      })
      .catch((err: unknown) => {
        logger.error({ mode, error: errorText(err) }, "curator tick failed");
        note("failed");
      })
      .finally(() => {
        if (running === mine) running = null;
      });
    return c.json({ started: true, mode }, 202);
  });

  return app;
}
