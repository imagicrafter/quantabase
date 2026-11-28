import { Hono } from "hono";
import { logger } from "../log/logger.js";
import { parseHookEvent } from "./event.js";
import { fetchBegun, type FetchDeps } from "./fetch.js";
import { HOOK_ID, SIGNATURE_HEADER, verifySignature } from "./signature.js";

/**
 * POST /hooks/fireflies/<hook id>: where Fireflies posts a finished meeting.
 *
 * No Cloudflare sign-in here (Fireflies cannot sign in; setup/plan.ts gives
 * this path a bypass application). The only check is the signature: the
 * HMAC-SHA256 of the RAW body under that account's signing secret, compared
 * timing-safe. An unknown id, a missing or wrong signature: 401, no detail,
 * and the same answer for each so the path tells a stranger nothing. The
 * body limit (index.ts) and the pre-auth rate limit come first.
 *
 * A good delivery is answered at once (Fireflies wants a 2xx within 30
 * seconds): the delivery row is marked pending, then the meeting is fetched
 * and stored in the background. A failure there is recorded, not lost: the
 * account page shows it as missed. A database outage answers 503, which
 * Fireflies retries.
 */

export const HOOK_PATH = "/hooks/fireflies";

export type HookRouteDeps = FetchDeps & {
  /** Runs the fetch after the answer. Tests await it. */
  readonly background?: (work: Promise<unknown>) => void;
};

const runLater = (work: Promise<unknown>) => {
  work.catch((err: unknown) => logger.warn({ error: err instanceof Error ? err.name : "error" }, "fireflies webhook: background fetch failed"));
};

export function makeHookRoute(deps: () => HookRouteDeps): Hono {
  const app = new Hono();
  const refuse = (reason: string) => {
    logger.warn({ reason }, "fireflies webhook rejected");
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  };

  app.post("/:id", async (c) => {
    const d = deps();
    const id = c.req.param("id");
    if (!HOOK_ID.test(id)) return refuse("bad_id");
    const signature = c.req.header(SIGNATURE_HEADER);
    if (!signature) return refuse("unsigned");
    const raw = new Uint8Array(await c.req.arrayBuffer());

    let hook: Awaited<ReturnType<HookRouteDeps["store"]["lookup"]>>;
    try {
      hook = await d.store.lookup(id);
    } catch {
      return c.json({ error: "unavailable" }, 503);
    }
    if (!hook) return refuse("unknown_id");
    if (!verifySignature(raw, signature, hook.secret)) return refuse("bad_signature");

    const event = parseHookEvent(new TextDecoder().decode(raw));
    if (!event) return c.json({ error: "not a JSON object" }, 400);
    try {
      await d.store.seen(hook.accountId, event.event);
      if (!event.fetch || event.meetingId === null) {
        logger.info({ event: event.event }, "fireflies webhook: acknowledged, nothing to fetch");
        return c.json({ ok: true, fetch: false });
      }
      const begun = await d.store.begin(hook.accountId, event.meetingId, event.event, event.reprocessedAt);
      if (begun === "skip") {
        logger.info({ event: event.event }, "fireflies webhook: already stored, skipped");
        return c.json({ ok: true, fetch: false, duplicate: true });
      }
      (d.background ?? runLater)(fetchBegun(d, hook.accountId, event.meetingId, event.event));
      logger.info({ event: event.event }, "fireflies webhook accepted");
      return c.json({ ok: true, fetch: true });
    } catch {
      return c.json({ error: "unavailable" }, 503);
    }
  });
  return app;
}
