import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { env } from "./env.js";
import { McpAppError } from "./mcp/errors.js";

// The engine never holds SUPABASE_SERVICE_ROLE_KEY (design decision 11 in the plan).
// SUPABASE_SERVICE_ROLE_KEY grants full write access to workspace.principals and
// workspace.access_grants — an engine holding it could grant itself any sensitive topic.
//
// Instead: mint a short-lived PostgREST JWT for the kb_engine role at startup.
// kb_engine has execute-only privileges on three functions and zero table grants.
// PostgREST runs every query in this JWT's session as kb_engine.
//
// CAVEAT (also in README.md): this JWT's rotation is tied to the project JWT secret,
// which every app on the same Supabase project shares. If independent rotation becomes necessary,
// the path is a real Postgres role with a password over the Supabase pooler using `pg`.

async function mintKbEngineJwt(): Promise<string> {
  const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  return new SignJWT({ role: "kb_engine" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("supabase")
    .setIssuedAt()
    .setExpirationTime("1y")
    .sign(secret);
}

// Top-level await — valid in ESM with NodeNext module resolution (Node >=22).
const kbEngineJwt = await mintKbEngineJwt();

// The supabase client authenticates as kb_engine via PostgREST JWT.
// Used for all RPC calls (documents_search_by_oauth_subject, document_get, etc.).
//
// The second positional arg to createClient becomes the `apikey` gateway header
// (validated by Supabase's edge against known project keys, NOT by PostgREST) —
// it must be SUPABASE_ANON_KEY, never the custom kb_engine JWT. A self-signed
// role JWT there fails at the gateway with "Invalid API key" regardless of
// whether it's correctly signed. The kb_engine JWT goes in the Authorization
// header explicitly, which is what PostgREST reads for role-switching.
// Bug found and fixed 2026-08-18 during first real-DB test against production —
// this path was previously unexercised because tests/access/fail-closed.test.ts
// (REAL_DB=1) had never been run for real.
// Every database call has a deadline. Without one a stalled connection hangs
// its caller for ever, and a curator run stuck that way kept every later tick
// "busy" (2026-11-21). A caller's own signal (.abortSignal()) still applies;
// whichever fires first wins.
export const DB_TIMEOUT_MS = 60_000;

export function fetchWithTimeout(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const deadline = AbortSignal.timeout(DB_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
}

export const supabase: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: fetchWithTimeout,
      headers: {
        "X-Client-Info": "kb-engine",
        Authorization: `Bearer ${kbEngineJwt}`,
      },
    },
  },
);

// Outbound HTTP client — with allowlist enforcement.
// The engine should only ever call the Supabase project host and the Cloudflare
// Access team domain. This is enforced in src/http/outbound-allowlist.ts.

const EMBED_URL = `${env.SUPABASE_URL}/functions/v1/embed`;

const EMBED_TOKEN_TTL_MS = 5 * 60_000;
let vaultEmbedToken: { readonly value: string; readonly at: number } | null = null;

/**
 * The embed function's bearer: EMBED_TOKEN when deployed with one, otherwise
 * the vault copy the Database setup screen stored (engine_embed_token()),
 * cached for five minutes. Never logged, never returned to a caller.
 */
async function embedToken(): Promise<string> {
  if (env.EMBED_TOKEN) return env.EMBED_TOKEN;
  if (vaultEmbedToken && Date.now() - vaultEmbedToken.at < EMBED_TOKEN_TTL_MS) {
    return vaultEmbedToken.value;
  }
  const { data, error } = await supabase.schema(env.KB_SCHEMA).rpc("engine_embed_token");
  if (error || typeof data !== "string" || data.length < 10) {
    throw new McpAppError("internal_error", "Embedding is not set up yet (no embed token)");
  }
  vaultEmbedToken = { value: data, at: Date.now() };
  return data;
}

/**
 * Embed a single text string via the Supabase `embed` edge function.
 * Uses SUPABASE_ANON_KEY as the gateway API key (the function is deployed
 * --no-verify-jwt; the gateway needs a valid project key, not a verified JWT).
 * Uses EMBED_TOKEN as the bearer for the function's own auth check
 * (workspace.principal_can_embed).
 */
export async function embedText(text: string): Promise<number[]> {
  const token = await embedToken();
  let res: Response;
  try {
    res = await fetch(EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ texts: [text] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new McpAppError(
      "internal_error",
      "Embedding service temporarily unavailable",
      { cause },
    );
  }

  if (res.status === 401) {
    throw new McpAppError(
      "internal_error",
      "Embed function rejected EMBED_TOKEN — check principal provisioning",
    );
  }
  if (!res.ok) {
    throw new McpAppError(
      "internal_error",
      `Embed function failed (HTTP ${res.status})`,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new McpAppError(
      "internal_error",
      "Embed function returned unparseable response",
    );
  }

  const embeddings = data["embeddings"];
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new McpAppError(
      "internal_error",
      "Embed function returned no embeddings",
    );
  }
  const first = embeddings[0];
  if (!Array.isArray(first)) {
    throw new McpAppError(
      "internal_error",
      "Embed function returned malformed embedding",
    );
  }
  return first as number[];
}
