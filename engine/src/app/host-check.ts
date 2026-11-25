import { allowOutboundHost } from "../http/outbound-allowlist.js";
import { isHostname } from "../setup/inputs.js";

/**
 * Does the Engine's hostname reach this app? (2026-11-20 cold start: the
 * hostname answered DigitalOcean's "not found" because the app listed no
 * domains.)
 *
 * Asks https://<host>/internal/curator/tick by POST with NO timer secret.
 * That path is the one Cloudflare sign-in lets through (the timer bypass), and
 * this app answers it with its own 401 JSON ("unauthorized"). Any other answer
 * means the request did not reach this app. Nothing is started: without the
 * secret the tick route does nothing.
 */

export type HostReach = { readonly ok: boolean; readonly detail: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 5_000;

async function ours(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    return body?.error?.code === "unauthorized";
  } catch {
    return false;
  }
}

function verdict(status: number): string {
  if (status === 404) {
    return "DigitalOcean answered 404 (not found): the hostname is not on the app yet. Add it under Settings, Domains.";
  }
  if (status >= 300 && status < 400) {
    return `Cloudflare sign-in answered (${status}) on the timer path: run the sign-in setup again to add its bypass.`;
  }
  return `The hostname answered ${status}, not this app.`;
}

export async function checkHostReaches(host: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<HostReach> {
  if (!isHostname(host)) return { ok: false, detail: "No plain hostname is stored." };
  allowOutboundHost(host);
  try {
    const res = await fetchFn(`https://${host}/internal/curator/tick`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (await ours(res)) return { ok: true, detail: `https://${host} reaches this app` };
    return { ok: false, detail: verdict(res.status) };
  } catch {
    return { ok: false, detail: `https://${host} could not be reached (DNS, TLS or a timeout).` };
  }
}
