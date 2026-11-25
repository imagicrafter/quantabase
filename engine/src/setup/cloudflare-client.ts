import { z } from "zod";
import type { Json } from "./merge.js";

/**
 * A thin client for the Cloudflare API, built around one rule: the API token
 * goes to https://api.cloudflare.com/client/v4/ and nowhere else.
 *
 *   - one fixed base URL; every path is built from checked segments, and the
 *     finished URL is checked again before anything is sent;
 *   - redirects are never followed;
 *   - every call has a timeout;
 *   - the token lives only in the client made here. It is never put in an
 *     error, and any text Cloudflare sends back is scrubbed of it before it
 *     is kept.
 */

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/";
const BASE = new URL(CLOUDFLARE_API_BASE);

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CloudflareErrorKind =
  | "bad_token" // not shaped like a token; nothing was sent
  | "auth" // Cloudflare did not accept the token
  | "forbidden" // the token may not do this
  | "not_found"
  | "api" // any other refusal
  | "network"
  | "timeout";

/** Holds a kind, a status and Cloudflare's numeric codes. Never the token. */
export class CloudflareError extends Error {
  readonly kind: CloudflareErrorKind;
  readonly status: number;
  readonly codes: readonly number[];

  constructor(
    kind: CloudflareErrorKind,
    message: string,
    status = 0,
    codes: readonly number[] = [],
  ) {
    super(message);
    this.name = "CloudflareError";
    this.kind = kind;
    this.status = status;
    this.codes = codes;
  }
}

const Envelope = z.object({
  success: z.boolean(),
  errors: z
    .array(z.object({ code: z.number(), message: z.string().optional() }))
    .nullish(),
  result: z.unknown(),
  result_info: z
    .object({ total_pages: z.number().int().nonnegative().optional() })
    .nullish(),
});

export type Query = Readonly<Record<string, string>>;

export type CloudflareClient = {
  /** GET one object. */
  readonly get: (path: readonly string[], query?: Query) => Promise<unknown>;
  /** GET every page of a list. */
  readonly list: (path: readonly string[], query?: Query) => Promise<unknown[]>;
  readonly send: (
    method: "POST" | "PUT" | "PATCH",
    path: readonly string[],
    body: Json,
  ) => Promise<unknown>;
};

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,256}$/;

/** The request URL. Throws rather than build one that leaves the API. */
export function buildUrl(path: readonly string[], query: Query = {}): URL {
  if (path.length === 0 || !path.every((part) => SEGMENT.test(part))) {
    throw new CloudflareError("api", "Refused to build an unexpected API path");
  }
  const url = new URL(path.join("/"), BASE);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  if (
    url.origin !== BASE.origin ||
    !url.pathname.startsWith(BASE.pathname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new CloudflareError(
      "api",
      "Refused to call outside the Cloudflare API",
    );
  }
  return url;
}

function kindFor(
  status: number,
  codes: readonly number[],
): CloudflareErrorKind {
  if (status === 401 || codes.includes(6003) || codes.includes(1000))
    return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "api";
}

type Deps = {
  readonly token: string;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  /** A time (ms, on `now`'s clock) after which no call is made or awaited. */
  readonly deadline?: number;
  readonly now?: () => number;
};

/** One client's settings. `token` goes into the Authorization header only. */
type Session = {
  readonly token: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  /** Milliseconds left before the deadline; Infinity when there is none. */
  readonly remaining: () => number;
};

/** Cloudflare's own words, cut short, with the token taken out. */
const scrub = (session: Session, text: string): string =>
  text.split(session.token).join("[removed]").slice(0, 200);

async function exchange(
  session: Session,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const left = session.remaining();
  if (left <= 0) {
    throw new CloudflareError("timeout", "Setup ran out of time");
  }
  try {
    return await session.fetch(url.toString(), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(session.timeoutMs, left)),
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (err) {
    // The underlying error is dropped on purpose: only its kind is kept.
    const name = err instanceof Error ? err.name : "";
    throw name === "TimeoutError" || name === "AbortError"
      ? new CloudflareError("timeout", "Cloudflare took too long to answer")
      : new CloudflareError("network", "Cloudflare could not be reached");
  }
}

/** The answer's envelope, or a CloudflareError that says why there is none. */
async function readEnvelope(session: Session, res: Response) {
  if (res.status >= 300 && res.status < 400) {
    throw new CloudflareError(
      "api",
      "Cloudflare answered with a redirect, which is never followed",
      res.status,
    );
  }
  const text = await res.text().catch(() => "");
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new CloudflareError(
      "api",
      "Cloudflare's answer was too large",
      res.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const envelope = Envelope.safeParse(parsed);
  if (!envelope.success) {
    throw new CloudflareError(
      kindFor(res.status, []),
      `Cloudflare answered ${res.status} with something unreadable`,
      res.status,
    );
  }
  if (res.ok && envelope.data.success) return envelope.data;

  const errors = envelope.data.errors ?? [];
  const codes = errors.map((e) => e.code);
  const said = errors
    .slice(0, 2)
    .map((e) => scrub(session, e.message ?? ""))
    .filter((m) => m.length > 0)
    .join("; ");
  throw new CloudflareError(
    kindFor(res.status, codes),
    `Cloudflare answered ${res.status}${said ? `: ${said}` : ""}`,
    res.status,
    codes,
  );
}

async function call(session: Session, url: URL, init: RequestInit) {
  return readEnvelope(session, await exchange(session, url, init));
}

async function listPages(
  session: Session,
  path: readonly string[],
  query: Query,
  page: number,
  seen: readonly unknown[],
): Promise<unknown[]> {
  const url = buildUrl(path, {
    ...query,
    page: String(page),
    per_page: String(PAGE_SIZE),
  });
  const data = await call(session, url, { method: "GET" });
  const items = Array.isArray(data.result) ? data.result : [];
  const all = [...seen, ...items];
  const totalPages = data.result_info?.total_pages ?? 1;
  const more = page < totalPages && items.length > 0 && page < MAX_PAGES;
  return more ? listPages(session, path, query, page + 1, all) : all;
}

export function createCloudflareClient(deps: Deps): CloudflareClient {
  const token = deps.token.trim();
  if (!TOKEN.test(token)) {
    throw new CloudflareError(
      "bad_token",
      "That does not look like a Cloudflare API token",
    );
  }
  const now = deps.now ?? Date.now;
  const deadline = deps.deadline;
  const session: Session = {
    token,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    remaining: () =>
      deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now(),
  };
  return {
    get: async (path, query) =>
      (await call(session, buildUrl(path, query), { method: "GET" })).result,
    list: (path, query = {}) => listPages(session, path, query, 1, []),
    send: async (method, path, body) =>
      (
        await call(session, buildUrl(path), {
          method,
          body: JSON.stringify(body),
        })
      ).result,
  };
}
