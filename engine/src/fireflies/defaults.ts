import { allowOutboundHost } from "../http/outbound-allowlist.js";
import type { FirefliesScreenDeps } from "../app/fireflies-routes.js";
import { liveFirefliesAppStore } from "../app/fireflies-store.js";
import { createFirefliesClient, FIREFLIES_HOST } from "./client.js";
import { createJobs } from "./fetch.js";
import type { HookRouteDeps } from "./route.js";
import { liveFirefliesStore } from "./store.js";

/**
 * The Fireflies webhook's real dependencies. api.fireflies.ai joins the
 * outbound allowlist only when the Engine first calls it (a key check, a
 * delivery's fetch, a retry or a backfill), the same way the Updates screen
 * adds its host.
 */

const client = createFirefliesClient((url, init) => {
  allowOutboundHost(FIREFLIES_HOST);
  return fetch(url, init);
});

const jobs = createJobs();

export const liveFirefliesScreens: FirefliesScreenDeps = { store: liveFirefliesAppStore, client, jobs };

export const liveHookDeps = (): HookRouteDeps => ({ store: liveFirefliesStore, client });
