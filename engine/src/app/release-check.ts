/**
 * What the newest release is: the public repository's `stable` branch, read
 * as two plain files (VERSION and CHANGELOG.md) from raw.githubusercontent.com
 * over HTTPS, with no token. Used by the Updates screen (updates-routes.ts).
 *
 * EVERYTHING FETCHED IS UNTRUSTED. VERSION must be strict semver or the check
 * fails; changelog text is returned as plain text with control characters
 * removed and its size capped. The screen escapes it again and never renders
 * it as HTML or as links.
 *
 * Any failure (network, timeout, a non-200, an oversized body, a bad VERSION)
 * is `{ ok: false }`: the screen says it could not check. An answer is kept
 * for an hour; a failure for five minutes.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_RELEASE_REPO = "imagicrafter/quantabase";
export const RELEASE_HOST = "raw.githubusercontent.com";
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s.*)?$/;

const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 5;
const MAX_CHARS = 4000;
const TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;

export type ReleaseNote = { readonly version: string; readonly text: string };

export type ReleaseCheck =
  | {
      readonly ok: true;
      readonly repo: string;
      readonly latest: string;
      /** True when latest is newer than the running version; null when they cannot be compared. */
      readonly newer: boolean | null;
      readonly notes: readonly ReleaseNote[];
    }
  | { readonly ok: false };

type Parsed = { readonly core: readonly number[]; readonly pre: readonly string[] };

export function parseVersion(value: string): Parsed | null {
  const m = SEMVER.exec(value);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Semver order; both must parse (callers check). Positive when a is newer. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    const d = x.core[i]! - y.core[i]!;
    if (d !== 0) return d;
  }
  return comparePre(x.pre, y.pre);
}

/** Plain text: no control characters except newline and tab; CRLF to LF. */
export function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** The changelog entries above `running` and up to `latest`, newest first, capped. */
export function newerEntries(changelog: string, running: string, latest: string): ReleaseNote[] {
  const sections: Array<{ version: string; lines: string[] }> = [];
  let current: { version: string; lines: string[] } | null = null;
  for (const line of cleanText(changelog).split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { version: heading[1]!, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const out: ReleaseNote[] = [];
  let budget = MAX_CHARS;
  for (const s of sections) {
    if (out.length >= MAX_ENTRIES || budget <= 0) break;
    if (!parseVersion(s.version)) continue;
    if (compareVersions(s.version, running) <= 0 || compareVersions(s.version, latest) > 0) continue;
    const text = s.lines.join("\n").trim().slice(0, budget);
    budget -= text.length;
    out.push({ version: s.version, text });
  }
  return out;
}

/** QB_RELEASE_REPO as owner/name, else the default. */
export function releaseRepoOf(value: string | undefined): string {
  return value && REPO.test(value) && !value.includes("..") ? value : DEFAULT_RELEASE_REPO;
}

/** DigitalOcean's app id (the `${APP_ID}` binding), or null when absent or not a UUID. */
export function appIdOf(value: string | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return UUID.test(v) ? v : null;
}

async function fetchText(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, redirect: "error", headers: { Accept: "text/plain" } });
    if (res.status !== 200) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return null;
    const text = await res.text();
    return text.length > MAX_BYTES ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type Files = { readonly latest: string; readonly changelog: string | null } | null;

export type ReleaseCheckOptions = {
  readonly repo: string;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly timeoutMs?: number;
};

/** A checker with its own cache: call it with the running version. */
export function createReleaseCheck(opts: ReleaseCheckOptions): (running: string) => Promise<ReleaseCheck> {
  const base = `https://${RELEASE_HOST}/${opts.repo}/stable`;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  let cached: { files: Files; until: number } | null = null;

  async function load(): Promise<Files> {
    const raw = await fetchText(opts.fetch, `${base}/VERSION`, timeout);
    const latest = raw?.trim() ?? "";
    if (!parseVersion(latest)) return null;
    const changelog = await fetchText(opts.fetch, `${base}/CHANGELOG.md`, timeout);
    return { latest, changelog };
  }

  return async (running) => {
    const now = opts.now();
    if (!cached || now >= cached.until) {
      const files = await load();
      cached = { files, until: now + (files ? TTL_MS : FAIL_TTL_MS) };
    }
    const files = cached.files;
    if (!files) return { ok: false };
    if (!parseVersion(running)) return { ok: true, repo: opts.repo, latest: files.latest, newer: null, notes: [] };
    const newer = compareVersions(files.latest, running) > 0;
    const notes = newer && files.changelog ? newerEntries(files.changelog, running, files.latest) : [];
    return { ok: true, repo: opts.repo, latest: files.latest, newer, notes };
  };
}
