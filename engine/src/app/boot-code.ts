import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The first-run claim (Phase 10 build order, Step D).
 *
 * A fresh Engine has no sign-in yet, so nobody can be checked. On boot it
 * makes a random one-time code and writes it once to its own log (the
 * DigitalOcean run log, which only the person who deployed the app can read).
 * Whoever opens /setup?code=<that code> claims the app, then names its owner
 * on the Database screen.
 *
 * SINGLE USE: a claim spends the code in this process. From then on the
 * claimant carries a sealed cookie (claim session), not the code.
 *
 * SURVIVING A RESTART (2026-11-20 cold start). Once the Database screen has
 * run, the database holds the claim: the code's hash (engine_setup_reopen),
 * the owner, and the wrong-code lockout (0034). A restart then does NOT make
 * a new code: the process starts "resumable" and adopts the original code
 * once the database confirms it, either from the claimant's cookie or from
 * the first FIRST RUN log line typed in again (first-run-routes.ts). The
 * cookie is AES-256-GCM sealed under a key derived from the app's JWT secret,
 * so it outlives the process. It carries the code (needed to finish setup);
 * it is HttpOnly, SameSite=Strict and sent to /setup only.
 *
 * LOCKOUT, per client: five wrong codes from one client (CF-Connecting-IP,
 * else the first X-Forwarded-For address) lock that client out for an hour,
 * so a stranger cannot lock the owner out. A global ceiling (100 wrong codes
 * in 15 minutes from anyone) locks claiming for everyone as a backstop. The
 * per-client table is bounded (oldest dropped first). These locks live in
 * this process; a resumed claim is counted by the database's lockout instead.
 *
 * ONE INSTANCE during setup: each instance makes its own code and holds its
 * own claim. The deploy file runs one.
 */

export const CLAIM_COOKIE = "kbe_claim";
const SESSION_MS = 2 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 100;
const MAX_CLIENTS = 1000;

type ClientState = { readonly failures: readonly number[]; readonly lockedUntil: number };

export type ClaimResult =
  | { readonly ok: true; readonly cookie: string }
  | { readonly ok: false; readonly reason: "none" | "spent" | "locked" | "wrong"; readonly retryAfterSeconds: number };

export type ClaimSession = { readonly expiresAt: number; readonly cookie: string };

export type BootCode = {
  /** The code, while it is still unspent. Never put in a page or a log line by callers. */
  readonly peek: () => string | undefined;
  /** The code this process was started with (or adopted), spent or not. */
  readonly original: () => string | undefined;
  /** `client` names who is asking (an IP address); unknown callers share one bucket. */
  readonly claim: (submitted: unknown, client?: string) => ClaimResult;
  readonly session: (cookie: string | undefined) => ClaimSession | null;
  /** The owner named on the Database screen, once the database stored them. */
  readonly claimedOwner: () => string | null;
  readonly setOwner: (email: string) => void;
  /** True while this process waits to adopt the code the database holds. */
  readonly resumable: () => boolean;
  /** While resumable: the code sealed in a still-valid cookie, for the database to confirm. */
  readonly cookieCode: (cookie: string | undefined) => string | null;
  /** Take the code the database confirmed. It is spent; returns a fresh cookie. Null when not resumable. */
  readonly adopt: (confirmed: string) => string | null;
};

export type BootCodeOptions = {
  /** Secret the cookie key is derived from. Random (this process only) when absent. */
  readonly cookieSecret?: string;
  /** Start with no code, waiting to adopt the one the database holds. */
  readonly resumable?: boolean;
};

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

function equal(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function newCode(): string {
  return randomBytes(24).toString("base64url");
}

function cookieKey(secret: string | undefined): Buffer {
  return secret
    ? Buffer.from(hkdfSync("sha256", secret, "kb-engine-claim", "claim-cookie-v2", 32))
    : randomBytes(32);
}

type Opened = { readonly expiresAt: number; readonly code: string };

function sealWith(key: Buffer, payload: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

function openWith(key: Buffer, cookie: string | undefined, nowMs: number): Opened | null {
  if (!cookie || cookie.length > 1024) return null;
  const parts = cookie.split(".").map((p) => Buffer.from(p, "base64url"));
  const [iv, body, tag] = parts;
  if (parts.length !== 3 || !iv || !body || !tag || iv.length !== 12 || tag.length !== 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const [kind, exp, ...rest] = payload.split("|");
    const expiresAt = Number(exp);
    const code = rest.join("|");
    if (kind !== "claimed" || !Number.isFinite(expiresAt) || expiresAt <= nowMs || !code) return null;
    return { expiresAt, code };
  } catch {
    return null;
  }
}

export function createBootCode(
  initial: string | undefined,
  now: () => number = Date.now,
  options: BootCodeOptions = {},
): BootCode {
  const key = cookieKey(options.cookieSecret);
  let code = initial;
  let waiting = initial === undefined && options.resumable === true;
  let spent = false;
  let owner: string | null = null;
  let globalFailures: number[] = [];
  let globalLockedUntil = 0;
  let clients = new Map<string, ClientState>();

  const remember = (who: string, state: ClientState): void => {
    const next = new Map(clients);
    next.delete(who);
    next.set(who, state);
    while (next.size > MAX_CLIENTS) {
      const oldest = next.keys().next().value as string;
      next.delete(oldest);
    }
    clients = next;
  };

  const issue = (forCode: string): string => sealWith(key, `claimed|${now() + SESSION_MS}|${forCode}`);

  const claim = (submitted: unknown, client = "unknown"): ClaimResult => {
    const t = now();
    if (!code) return { ok: false, reason: "none", retryAfterSeconds: 0 };
    const who = client.slice(0, 64) || "unknown";
    const mine = clients.get(who) ?? { failures: [], lockedUntil: 0 };
    const lockedUntil = Math.max(globalLockedUntil, mine.lockedUntil);
    if (lockedUntil > t) {
      return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil((lockedUntil - t) / 1000) };
    }
    const given = typeof submitted === "string" ? submitted.trim() : "";
    const plausible = given.length > 0 && given.length <= 256;
    const matches = equal(plausible ? given : "", code);
    if (!plausible || !matches) {
      globalFailures = [...globalFailures.filter((f) => t - f < FAILURE_WINDOW_MS), t];
      if (globalFailures.length >= GLOBAL_MAX_FAILURES) {
        globalLockedUntil = t + LOCK_MS;
        globalFailures = [];
      }
      const failures = [...mine.failures.filter((f) => t - f < FAILURE_WINDOW_MS), t];
      const locked = failures.length >= MAX_FAILURES;
      remember(who, locked ? { failures: [], lockedUntil: t + LOCK_MS } : { failures, lockedUntil: 0 });
      return locked || globalLockedUntil > t
        ? { ok: false, reason: "locked", retryAfterSeconds: LOCK_MS / 1000 }
        : { ok: false, reason: "wrong", retryAfterSeconds: 0 };
    }
    if (spent) return { ok: false, reason: "spent", retryAfterSeconds: 0 };
    spent = true;
    return { ok: true, cookie: issue(code) };
  };

  const session = (cookie: string | undefined): ClaimSession | null => {
    if (!spent || !code) return null;
    const opened = openWith(key, cookie, now());
    if (!opened || !equal(opened.code, code)) return null;
    return { expiresAt: opened.expiresAt, cookie: cookie as string };
  };

  return {
    peek: () => (spent ? undefined : code),
    original: () => code,
    claim,
    session,
    claimedOwner: () => owner,
    setOwner: (email) => {
      owner = email;
    },
    resumable: () => waiting,
    cookieCode: (cookie) => (waiting ? (openWith(key, cookie, now())?.code ?? null) : null),
    adopt: (confirmed) => {
      if (!waiting || !confirmed) return null;
      code = confirmed;
      waiting = false;
      spent = true;
      return issue(confirmed);
    },
  };
}

/** The cookie header value that sets (or clears) the claim session. */
export function claimCookie(value: string | null, secure: boolean): string {
  const flags = `Path=/setup; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  return value === null
    ? `${CLAIM_COOKIE}=; Max-Age=0; ${flags}`
    : `${CLAIM_COOKIE}=${value}; Max-Age=${SESSION_MS / 1000}; ${flags}`;
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
