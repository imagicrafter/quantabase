import { z } from "zod";
import { DEFAULT_KB_SCHEMA, kbSchemaProblem } from "./kb-schema.js";
import { appIdOf, DEFAULT_RELEASE_REPO } from "./app/release-check.js";

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  // DO App Platform may pass `${_self.commit_hash}` through unexpanded; treat
  // empty or templated values as unknown rather than reporting them as a sha.
  SOURCE_COMMIT: z
    .string()
    .default("unknown")
    .transform((v) => (v === "" || v.includes("${") ? "unknown" : v)),

  // The Updates screen (app/updates-routes.ts). QB_RELEASE_REPO is the public
  // GitHub repository (owner/name) whose `stable` branch holds the newest
  // release; empty counts as unset, a malformed value stops the boot.
  QB_RELEASE_REPO: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "must be owner/name, for example imagicrafter/quantabase")
      .refine((v) => !v.includes(".."), "must be owner/name, for example imagicrafter/quantabase")
      .default(DEFAULT_RELEASE_REPO),
  ),
  // DigitalOcean's id for this app (the spec binds `${APP_ID}`), for a direct
  // link to it. Anything but a UUID (empty, an unexpanded template) is unset.
  APP_ID: z
    .string()
    .optional()
    .transform((v) => appIdOf(v) ?? undefined),

  // Supabase. The project is chosen by SUPABASE_URL and the keys below.
  SUPABASE_URL: z.string().url(),
  // The Postgres schema that holds the knowledge index. One setting, shared
  // with the jobs, the `kbe` CLI and the embed function. A bad name stops the
  // boot; it is never replaced by the default. Empty counts as unset.
  KB_SCHEMA: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .default(DEFAULT_KB_SCHEMA)
      .superRefine((name, ctx) => {
        const problem = kbSchemaProblem(name);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
  ),
  // Project JWT secret. Used to mint a short-lived PostgREST JWT as the kb_engine role.
  // The engine never holds SUPABASE_SERVICE_ROLE_KEY.
  // NOTE: every app that shares this Supabase project shares this secret. If
  // independent rotation becomes necessary, switch to a real Postgres role +
  // pooler connection.
  SUPABASE_JWT_SECRET: z.string().min(32),
  // Publishable anon key — used to authenticate to the embed edge function gateway.
  // Not a secret; this is the same key visible in the Supabase dashboard.
  SUPABASE_ANON_KEY: z.string().min(20),
  // Bearer token for the kb-engine principal (handle: kb-engine, zero domain grants).
  // Used to authenticate the embed edge function's own auth check (workspace.principal_can_embed).
  // Minted via: python -m kbe tokens mint --embed --clipboard
  // Optional: an Engine set up from the app's Database screen keeps it in
  // Supabase Vault (kbe_embed_token) and reads it from there.
  EMBED_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(10).optional(),
  ),

  // ── Sign-in settings (Cloudflare Access) ──────────────────────────────────
  // Two places can hold them:
  //   1. these four variables, set together (an existing deployment), or
  //   2. workspace.engine_settings.access in the database, written by setup.
  // The variables win when present. Set all four or none: a half-configured
  // sign-in path produces silent 401s that are impossible to diagnose, so boot
  // fails on a partial set. With neither source, every protected route answers
  // 503 — never open.
  //
  // CF_ACCESS_TEAM_DOMAIN is both the assertion issuer AND the JWKS host
  // (`<team_domain>/cdn-cgi/access/certs`) — see verify-access-assertion.ts.
  // Example: https://acme.cloudflareaccess.com
  CF_ACCESS_TEAM_DOMAIN: z.string().url().optional(),
  // The Access application's AUD tag — the `aud` claim expected on every
  // Cf-Access-Jwt-Assertion (verified in verifyAccessAssertion).
  CF_ACCESS_AUD: z.string().min(1).optional(),
  // The canonical MCP URL for this resource server: the `resource` field in
  // /.well-known/oauth-protected-resource. Must end in /mcp.
  // Example: https://engine.example.com/mcp
  OAUTH_RESOURCE_URL: z.string().url().optional(),
  // Expected Host header. Requests to *.ondigitalocean.app are rejected at the
  // app layer. The ingress redirect in the DO spec is cosmetic; this check is
  // the real enforcement.
  EXPECTED_HOST: z.string().min(1).optional(),

  // AUD of the separate Access app that guards GET /status (path-scoped, with a
  // second factor). Optional: when unset the route uses the stored sign-in
  // settings, then the config's dashboard.connect.status_page_aud.
  CF_ACCESS_STATUS_AUD: z.string().min(1).optional(),

  // The one-time code that opens the setup page (GET /setup). Generated by
  // the deploy tooling, which also stores its SHA-256 in the database; both
  // must match. Long and random: 32 to 256 characters, letters, digits, "-"
  // and "_" only (so it can never need escaping in a log line or a header).
  // Space around it is dropped. Unset (or empty) means the setup page refuses
  // to work.
  SETUP_CODE: z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
    z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{32,256}$/,
        "must be 32 to 256 letters, digits, '-' or '_'",
      )
      .optional(),
  ),

  // Optional comma-separated email domain allowlist. Defence-in-depth, not the
  // gate — the Access policy's explicit email list is the real gate.
  // If set, any email outside these domains is rejected before any DB call.
  // Example: example.com,example.org
  ALLOWED_EMAIL_DOMAINS: z.string().optional(),
});

/** Every variable the service reads. `.env.example` must list each one. */
export const ENV_KEYS: readonly string[] = Object.keys(Env.shape);

/** The four sign-in variables that must be set together or not at all. */
export const ACCESS_ENV_KEYS = [
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "OAUTH_RESOURCE_URL",
  "EXPECTED_HOST",
] as const;

/** Names of the sign-in variables that are missing from a partial set. */
export function missingAccessKeys(
  values: Readonly<Partial<Record<(typeof ACCESS_ENV_KEYS)[number], string>>>,
): readonly string[] {
  const missing = ACCESS_ENV_KEYS.filter((key) => !values[key]);
  return missing.length === ACCESS_ENV_KEYS.length ? [] : missing;
}

// Boot fails loudly when OAuth vars are partially set.
// A half-configured OAuth path produces silent 401s with nothing to diagnose.
const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`kb-engine: invalid environment\n${issues}`);
}

const missingAccess = missingAccessKeys(parsed.data);
if (missingAccess.length > 0) {
  throw new Error(
    `kb-engine: invalid environment\n  sign-in settings are half set; also set ${missingAccess.join(", ")} (or unset all four to use the stored settings)`,
  );
}

export const env = parsed.data;
export type Env = typeof parsed.data;
