import type { Context, Hono } from "hono";
import { logger } from "../log/logger.js";
import { FirefliesError, type FirefliesClient } from "../fireflies/client.js";
import { backfill, retryMissed, type Jobs } from "../fireflies/fetch.js";
import { newHookId, newSigningSecret } from "../fireflies/signature.js";
import type { FirefliesScreenStore } from "./fireflies-store.js";
import { readForm, UUID, type Allowed, type ScreenDeps } from "./guard.js";
import { appLayout, notice, sendMessage, sendPage } from "./html.js";

/**
 * The Fireflies webhook on the Sources screens (docs/source-rules.md,
 * "Fireflies by webhook"). Every person, for their OWN accounts only (the
 * database refuses anyone else's, administrators included).
 *
 *   POST /app/sources/fireflies/connect     paste a key: checked with Fireflies
 *                                           (one user query), then the
 *                                           fireflies:<email> account is made or
 *                                           reused and its webhook set up
 *   POST /app/sources/:id/fireflies/retry   fetch the missed meetings again
 *   POST /app/sources/:id/fireflies/backfill  once: the last 30 or 90 days
 *   POST /app/sources/:id/fireflies/disconnect
 *
 * The key is never logged, echoed or put in a page; only its last 4
 * characters come back from the database.
 */

export type FirefliesScreenDeps = {
  readonly store: FirefliesScreenStore;
  readonly client: FirefliesClient;
  readonly jobs: Jobs;
  readonly newHookId?: () => string;
  readonly newSecret?: () => string;
  readonly pause?: (ms: number) => Promise<void>;
};

type Handler = (c: Context, me: Allowed, deps: ScreenDeps) => Promise<Response>;

const SCOPE = "sources";
const HERE = "/app/sources";
const KEY_SHAPE = /^[\x21-\x7e]{10,4096}$/;

const page = (c: Context, title: string, text: string, status: 400 | 502 | 503) =>
  sendPage(c, status, appLayout("app", HERE, title, notice("error", text)));

const notReady = (c: Context) => page(c, "Not available", "This Engine cannot take Fireflies webhooks yet. Ask an administrator to update it.", 503);

function accountId(c: Context): string | null {
  const id = c.req.param("id") ?? "";
  return UUID.test(id) ? id : null;
}

const connect: Handler = async (c, me, deps) => {
  const ff = deps.fireflies;
  if (!ff) return notReady(c);
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const key = (sent.form["api_key"] ?? "").trim();
  if (!KEY_SHAPE.test(key)) return page(c, "Not connected", "Paste the whole key and nothing else (10 to 4096 characters, no spaces).", 400);
  let who: { readonly email: string };
  try {
    who = await ff.client.whoami(key);
  } catch (err) {
    const code = err instanceof FirefliesError ? err.code : "unreachable";
    logger.info({ reason: code }, "app: fireflies key not accepted");
    if (code === "unauthorized") {
      return page(c, "Not connected", "Fireflies did not accept that key. Copy it again from Fireflies (Integrations, then Fireflies API) and paste it here.", 400);
    }
    return page(c, "Not connected", "Fireflies did not answer. Try again in a minute.", 502);
  }
  const row = await ff.store.connect(me.email, who.email, key, (ff.newHookId ?? newHookId)(), (ff.newSecret ?? newSigningSecret)());
  logger.info({ new: row["new"] === true }, "app: fireflies webhook connected");
  return c.redirect(`/app/sources/${String(row["account_id"])}?connected=1`, 303);
};

const retry: Handler = async (c, me, deps) => {
  const ff = deps.fireflies;
  if (!ff) return notReady(c);
  const id = accountId(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such source account of yours.");
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const ids = await ff.store.missed(me.email, id);
  if (ids.length === 0) return sendMessage(c, "app", 200, "Nothing missed", "Every meeting Fireflies sent is in.");
  const started = ff.jobs.start(id, () => retryMissed({ store: ff.store, client: ff.client, ...(ff.pause ? { pause: ff.pause } : {}) }, id, ids));
  return sendMessage(
    c, "app", 200, started ? "Fetching again" : "Already fetching",
    started ? `Fetching ${ids.length} ${ids.length === 1 ? "meeting" : "meetings"} again. Open the account again in a minute to see the result.` : "A fetch for this account is already running. Open the account again in a minute.",
  );
};

const runBackfill: Handler = async (c, me, deps) => {
  const ff = deps.fireflies;
  if (!ff) return notReady(c);
  const id = accountId(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such source account of yours.");
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const days = Number(sent.form["days"] ?? "");
  if (days !== 30 && days !== 90) return page(c, "Not started", "Choose 30 or 90 days.", 400);
  // The database refuses an account that is not the caller's (or not connected) before anything is fetched.
  const state = await ff.store.get(me.email, id);
  if (state["connected"] !== true) return page(c, "Not started", "Connect this account by webhook first.", 400);
  const from = new Date(deps.now() - days * 86_400_000).toISOString();
  const started = ff.jobs.start(id, () => backfill({ store: ff.store, client: ff.client, ...(ff.pause ? { pause: ff.pause } : {}) }, id, from));
  logger.info({ days, started }, "app: fireflies backfill asked for");
  return sendMessage(
    c, "app", 200, started ? "Bringing in older meetings" : "Already fetching",
    started
      ? `The Engine is fetching your Fireflies meetings from the last ${days} days, one at a time. Your rules decide what is kept. Open the account again in a few minutes.`
      : "A fetch for this account is already running. Open the account again in a minute.",
  );
};

const disconnect: Handler = async (c, me, deps) => {
  const ff = deps.fireflies;
  if (!ff) return notReady(c);
  const id = accountId(c);
  if (!id) return sendMessage(c, "app", 404, "Not found", "There is no such source account of yours.");
  const sent = await readForm(c, deps, "app", me.email, SCOPE);
  if (!sent.ok) return sent.response;
  const done = await ff.store.disconnect(me.email, id);
  logger.info({ done }, "app: fireflies webhook disconnected");
  return sendMessage(c, "app", 200, "Disconnected", done
    ? "The webhook is off and the key and secret are gone from the Engine. Delete the webhook in Fireflies too. Meetings already kept stay."
    : "This account had no webhook.");
};

/** Mount the Fireflies webhook screens on the owner routes, before the generic /sources/:id ones. */
export function addFirefliesRoutes(app: Hono, h: (handler: Handler) => (c: Context) => Promise<Response>): void {
  app.post("/sources/fireflies/connect", h(connect));
  app.post("/sources/:id/fireflies/retry", h(retry));
  app.post("/sources/:id/fireflies/backfill", h(runBackfill));
  app.post("/sources/:id/fireflies/disconnect", h(disconnect));
}
