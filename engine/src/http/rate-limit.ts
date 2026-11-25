import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

// In-memory rate limiter — single instance, no shared store needed.
// App Platform provides no L7 rate limiting or WAF at any tier.
// A single 512 MB instance with instance_count: 1 means an HTTP flood is both
// an outage and a bandwidth bill ($0.02/GiB after the 50 GiB included).
//
// Two limits:
//   Pre-auth (by IP):    20 requests/minute  — caps unauthenticated JWKS cost
//   Post-auth (by sub):  60 requests/minute  — caps authenticated tool usage

type WindowEntry = { count: number; reset_at: number };

const WINDOW_MS = 60_000;
const ipWindows = new Map<string, WindowEntry>();
const subWindows = new Map<string, WindowEntry>();

function check(
  map: Map<string, WindowEntry>,
  key: string,
  limit: number,
): boolean {
  const now = Date.now();
  const entry = map.get(key);

  if (!entry || now > entry.reset_at) {
    map.set(key, { count: 1, reset_at: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= limit) {
    return false;
  }

  entry.count += 1;
  return true;
}

function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("cf-connecting-ip") ??
    "unknown"
  );
}

/** Pre-auth rate limit by IP. Must run BEFORE JWT verification. */
export const preAuthRateLimit = createMiddleware(async (c, next) => {
  const ip = clientIp(c);
  if (!check(ipWindows, ip, 20)) {
    return c.json(
      { error: { code: "rate_limited", message: "Too many requests" } },
      429,
    );
  }
  await next();
});

const ceilingWindows = new Map<string, WindowEntry>();

/**
 * A ceiling on form posts across ALL clients, whatever address they claim.
 * The per-address limit above reads a header a direct caller can set, so it
 * cannot be the only brake on a route that answers before sign-in exists.
 * GET requests are not counted.
 */
export function ceilingRateLimit(name: string, perMinute: number) {
  return createMiddleware(async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    if (!check(ceilingWindows, name, perMinute)) {
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests" } },
        429,
      );
    }
    await next();
  });
}

/** For tests: start every window afresh. */
export function _resetRateLimitsForTests(): void {
  ipWindows.clear();
  subWindows.clear();
  ceilingWindows.clear();
}

/** Post-auth rate limit by the verified subject (`sub`). Runs after requireAuth sets auth context. */
export const postAuthRateLimit = createMiddleware(async (c, next) => {
  const auth = c.var["auth"] as { sub: string } | undefined;
  const sub = auth?.sub ?? "unknown";
  if (!check(subWindows, sub, 60)) {
    return c.json(
      { error: { code: "rate_limited", message: "Too many requests" } },
      429,
    );
  }
  await next();
});

// Periodic cleanup to prevent unbounded memory growth.
// Runs every 5 minutes; removes entries whose window has expired.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of ipWindows) {
      if (now > entry.reset_at) ipWindows.delete(key);
    }
    for (const [key, entry] of subWindows) {
      if (now > entry.reset_at) subWindows.delete(key);
    }
  },
  5 * 60 * 1000,
).unref();
