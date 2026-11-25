// supabase/functions/embed/index.ts
//
// Embedding endpoint. Lets an agent host or a hosted engine obtain
// gte-small vectors without installing sentence-transformers and without holding
// the service role key.
//
// Deployed via Supabase MCP deploy_edge_function. Editing this file does NOT
// auto-deploy -- redeploy manually after changes.
//
// Posture, deliberately unlike agent-memory-search (which this file must not be
// copied from -- see migration 0014 / the lockdown task):
//
//   - ANON key only. The service role key is never read here. Authorisation is
//     the `principal_can_embed` RPC in the Engine's schema (KB_SCHEMA), which is SECURITY DEFINER and
//     fail-closed.
//   - Explicit CORS allowlist. Never `*`. An unlisted origin gets no CORS
//     headers back, so a browser cannot read the response.
//   - An unknown, blank or inactive token returns 401. It must NOT degrade to an
//     empty result: silent-zero-on-unauthenticated is a failure mode already on
//     record from aios_readonly, where a missing RLS policy returned 0 rows and
//     read as "no data" rather than "no access".
//
// Contract:
//   POST { texts: string[] }  ->  { embeddings: number[][], dimensions, model }
//   Authorization: Bearer <token>

import { createClient } from "jsr:@supabase/supabase-js@2";

const model = new Supabase.ai.Session("gte-small");

const MODEL_NAME = "gte-small";
const DIMENSIONS = 384;

// The schema that holds the knowledge index: the KB_SCHEMA function secret,
// `workspace` when it is not set. Same rule as engine/src/kb-schema.ts and
// scripts/knowledge/kb_schema.py. A bad name is refused, never replaced by
// the default: this function decides who may embed, and must not ask the
// wrong schema.
const DEFAULT_KB_SCHEMA = "workspace";
const KB_SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const KB_SCHEMA_RESERVED = new Set([
  "public", "auth", "storage", "extensions", "graphql", "graphql_public",
  "realtime", "vault", "pgsodium", "supabase_migrations", "information_schema",
]);

// PostgreSQL's reserved key words: the same fixed list as the two files above.
const KB_SCHEMA_SQL_RESERVED_WORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array",
  "as", "asc", "asymmetric", "authorization", "binary", "both",
  "case", "cast", "check", "collate", "collation", "column",
  "concurrently", "constraint", "create", "cross", "current_catalog", "current_date",
  "current_role", "current_schema", "current_time", "current_timestamp", "current_user", "default",
  "deferrable", "desc", "distinct", "do", "else", "end",
  "except", "false", "fetch", "for", "foreign", "freeze",
  "from", "full", "grant", "group", "having", "ilike",
  "in", "initially", "inner", "intersect", "into", "is",
  "isnull", "join", "lateral", "leading", "left", "like",
  "limit", "localtime", "localtimestamp", "natural", "not", "notnull",
  "null", "offset", "on", "only", "or", "order",
  "outer", "overlaps", "placing", "primary", "references", "returning",
  "right", "select", "session_user", "similar", "some", "symmetric",
  "system_user", "table", "tablesample", "then", "to", "trailing",
  "true", "union", "unique", "user", "using", "variadic",
  "verbose", "when", "where", "window", "with",
]);

/** The configured schema, or null when KB_SCHEMA is not a usable name. */
function kbSchema(): string | null {
  const name = Deno.env.get("KB_SCHEMA") || DEFAULT_KB_SCHEMA;
  const usable = KB_SCHEMA_NAME.test(name) &&
    !KB_SCHEMA_RESERVED.has(name) && !name.startsWith("pg_") &&
    !KB_SCHEMA_SQL_RESERVED_WORDS.has(name);
  return usable ? name : null;
}

// Guard against a caller melting the function with one request.
//
// MEASURED 2026-08-13 against the deployed function with ~200-char texts:
//   n=12 -> 200 in 1.47s
//   n=16 -> 546 (edge-runtime CPU/wall ceiling) in 2.28s
//
// The cap is 12 so an oversized batch gets an explicit 413 it can act on, rather
// than an opaque 546 that looks like an outage. Note the ceiling is a function of
// total WORK, not count -- twelve 40k-char documents will still 546 where twelve
// short ones succeed. The client (scripts/knowledge/embedder.py) therefore also
// halves and retries on 546; this cap is the floor of that behaviour, not the
// whole of it.
const MAX_TEXTS = 12;
const MAX_CHARS_PER_TEXT = 40_000;

// Explicit allowlist. Agent hosts are server-side and send no Origin, which
// is why a missing Origin is allowed through -- CORS constrains browsers, not
// servers. A browser origin not on this list simply receives no CORS headers.
const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "http://localhost:3000",
]);

function corsHeadersFor(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bearerFrom(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("Origin"));

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: cors },
    );
  }

  // --- Authenticate ---------------------------------------------------------
  // Identity comes from the Authorization header ONLY -- never a request-body
  // field, never an environment variable. A body-supplied identity is a value
  // the caller chooses.
  const token = bearerFrom(req);
  if (token === null) {
    return Response.json(
      { error: "unauthorized", detail: "Authorization: Bearer <token> required" },
      { status: 401, headers: cors },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    console.error("[embed] SUPABASE_URL or SUPABASE_ANON_KEY not configured");
    return Response.json(
      { error: "server_misconfigured" },
      { status: 500, headers: cors },
    );
  }

  const schema = kbSchema();
  if (schema === null) {
    console.error("[embed] KB_SCHEMA is not a usable schema name");
    return Response.json(
      { error: "server_misconfigured" },
      { status: 500, headers: cors },
    );
  }

  const supabase = createClient(supabaseUrl, anonKey);
  const tokenHash = await sha256Hex(token);

  const { data: allowed, error: authError } = await supabase
    .schema(schema)
    .rpc("principal_can_embed", { p_token_hash: tokenHash });

  if (authError) {
    // Do not leak the database error to the caller; it can describe schema.
    console.error("[embed] principal_can_embed failed:", authError.message);
    return Response.json(
      { error: "authorization_check_failed" },
      { status: 500, headers: cors },
    );
  }

  if (allowed !== true) {
    return Response.json(
      { error: "unauthorized", detail: "Token is unknown, inactive or revoked" },
      { status: 401, headers: cors },
    );
  }

  // --- Validate input -------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "invalid_json" },
      { status: 400, headers: cors },
    );
  }

  const texts = (body as { texts?: unknown })?.texts;

  if (!Array.isArray(texts)) {
    return Response.json(
      { error: "invalid_request", detail: "`texts` must be an array of strings" },
      { status: 400, headers: cors },
    );
  }

  if (texts.length === 0) {
    return Response.json(
      { error: "invalid_request", detail: "`texts` must not be empty" },
      { status: 400, headers: cors },
    );
  }

  if (texts.length > MAX_TEXTS) {
    return Response.json(
      {
        error: "payload_too_large",
        detail: `At most ${MAX_TEXTS} texts per request, got ${texts.length}`,
      },
      { status: 413, headers: cors },
    );
  }

  for (const [index, text] of texts.entries()) {
    if (typeof text !== "string") {
      return Response.json(
        { error: "invalid_request", detail: `texts[${index}] is not a string` },
        { status: 400, headers: cors },
      );
    }
    if (text.length > MAX_CHARS_PER_TEXT) {
      return Response.json(
        {
          error: "payload_too_large",
          detail: `texts[${index}] exceeds ${MAX_CHARS_PER_TEXT} characters`,
        },
        { status: 413, headers: cors },
      );
    }
  }

  // --- Embed ----------------------------------------------------------------
  // mean_pool + normalize must match how the local sentence-transformers path
  // encodes, or the two vector spaces silently diverge and every cross-backend
  // similarity is wrong. verify_embedding_alignment.py is what proves they agree.
  try {
    const embeddings: number[][] = [];
    for (const text of texts as string[]) {
      const vector = await model.run(text, { mean_pool: true, normalize: true });
      embeddings.push(Array.from(vector as Float32Array));
    }

    // Best-effort telemetry. A failure here must never fail the embed.
    supabase
      .schema(schema)
      .rpc("touch_principal_last_used", { p_token_hash: tokenHash })
      .then(({ error }) => {
        if (error) console.error("[embed] touch_principal_last_used:", error.message);
      });

    return Response.json(
      { embeddings, dimensions: DIMENSIONS, model: MODEL_NAME },
      { headers: cors },
    );
  } catch (error) {
    console.error("[embed] embedding failed:", error);
    return Response.json(
      { error: "embedding_failed" },
      { status: 500, headers: cors },
    );
  }
});
