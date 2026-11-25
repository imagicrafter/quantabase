/**
 * A small client for the Supabase Management API, used by the Database setup
 * screen only (test A2 proved the calls: SQL without a database password,
 * expose the schema, deploy the embed function, read the API keys).
 *
 * THE ACCESS TOKEN is typed into the page, handed to this client and goes
 * nowhere else: not to a log line, not into a page, not into the database.
 * Any error text that comes back is cut short and has the token removed
 * before it is shown.
 *
 * ONE PROJECT: the client is pinned to the ref of the project the service
 * already talks to (SUPABASE_URL). A token for another project cannot be
 * pointed anywhere else through this page.
 */

export const MGMT_API = "https://api.supabase.com";
const TIMEOUT_MS = 120_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class MgmtError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MgmtError";
  }
}

export const REF_PATTERN = /^[a-z0-9]{20}$/;

/** The project ref in https://<ref>.supabase.co, or null for any other address. */
export function refFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(host);
    return m ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

export type Mgmt = {
  readonly ref: string;
  readonly get: (path: string) => Promise<unknown>;
  readonly patch: (path: string, body: object) => Promise<unknown>;
  readonly sql: (query: string, parameters?: readonly unknown[]) => Promise<unknown>;
  readonly deployFunction: (slug: string, source: string) => Promise<unknown>;
  readonly projectCount: () => Promise<number>;
};

function scrubbed(text: string, token: string): string {
  const cut = text.slice(0, 400);
  return token.length >= 8 ? cut.split(token).join("[redacted]") : cut;
}

export function createMgmt(token: string, ref: string, fetchFn: FetchLike): Mgmt {
  if (!REF_PATTERN.test(ref)) throw new MgmtError(400, "That is not a Supabase project ref.");
  if (!/^[A-Za-z0-9_.-]{20,512}$/.test(token)) {
    throw new MgmtError(400, "That does not look like a Supabase access token. Paste the whole token and nothing else.");
  }

  const call = async (method: string, url: string, body?: string | FormData, json = true): Promise<unknown> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined && json) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new MgmtError(502, "Supabase did not answer. Try again in a minute.");
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const d = data as Record<string, unknown> | null;
      const msg = String((d && (d["message"] ?? d["error"] ?? d["msg"])) ?? text ?? "");
      if (res.status === 401 || res.status === 403) {
        throw new MgmtError(res.status, "Supabase refused the token for this project. Check it was made for this project and has not expired.");
      }
      throw new MgmtError(res.status, `Supabase said (HTTP ${res.status}): ${scrubbed(msg, token)}`);
    }
    return data;
  };

  const base = `${MGMT_API}/v1/projects/${ref}`;
  return {
    ref,
    get: (path) => call("GET", `${base}${path}`),
    patch: (path, body) => call("PATCH", `${base}${path}`, JSON.stringify(body)),
    sql: (query, parameters) =>
      call("POST", `${base}/database/query`, JSON.stringify(parameters ? { query, parameters } : { query })),
    deployFunction: (slug, source) => {
      const form = new FormData();
      form.append("metadata", JSON.stringify({ name: slug, entrypoint_path: "index.ts", verify_jwt: false }));
      form.append("file", new Blob([source], { type: "application/typescript" }), "index.ts");
      return call("POST", `${base}/functions/deploy?slug=${encodeURIComponent(slug)}`, form, false);
    },
    projectCount: async () => {
      const list = await call("GET", `${MGMT_API}/v1/projects`);
      return Array.isArray(list) ? list.length : 0;
    },
  };
}
