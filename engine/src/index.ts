// Install the outbound allowlist BEFORE importing supabase.ts or any module
// that makes HTTP calls, so the first outbound request is already gated.
// Must come before all other imports that make network calls.
import { installOutboundAllowlist } from "./http/outbound-allowlist.js";
installOutboundAllowlist();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { env } from "./env.js";
import { currentAccess } from "./config/settings.js";
import { logger } from "./log/logger.js";
import { requireAuth } from "./auth/middleware.js";
import { buildProtectedResourceMetadata } from "./auth/access/protected-resource.js";
import { securityHeaders } from "./http/security-headers.js";
import {
  ceilingRateLimit,
  preAuthRateLimit,
  postAuthRateLimit,
} from "./http/rate-limit.js";
import { handleMcpRequest } from "./mcp/transport.js";
import { statusAssets } from "./status/assets.js";
import { makeStatusRoute } from "./status/route.js";
import { setupAssets } from "./setup/assets.js";
import { setupDeps } from "./setup/defaults.js";
import { currentMode, isSetupPath, type EngineMode } from "./setup/mode.js";
import { makeSetupRoutes } from "./setup/route.js";
import { notFoundPage, wrongHost } from "./app/not-found.js";
import { TICK_PATH, makeTickRoute } from "./curator/route.js";
import { reclaimAtBoot } from "./curator/lease.js";
import { store as curatorStore } from "./curator/store.js";
import { firstRunDeps, liveDatabase, screenDeps } from "./app/defaults.js";
import { warnPendingAtBoot } from "./app/db-update.js";
import { makeDatabaseRoutes } from "./app/database-routes.js";
import { makeUpdatesRoutes } from "./app/updates-routes.js";
import { liveFirstRunDeps, startFirstRun } from "./app/first-run.js";
import { firstRunGate, makeFirstRunRoutes } from "./app/first-run-routes.js";
import { makeOwnerRoutes } from "./app/owner-routes.js";
import { makeSettingsRoutes } from "./app/settings-routes.js";
import { makeIndexingRoutes } from "./app/indexing-routes.js";
import { makePipelineRoutes } from "./app/pipeline-routes.js";
import { makeBackupRoutes } from "./app/backup-routes.js";

const app = new Hono();

const startedAt = new Date().toISOString();

// ── Security headers on every response ─────────────────────────────────────
app.use("*", securityHeaders);

// ── Setup mode, sign-in settings + Host header check ───────────────────────
// Applies to every route except /health (so the platform health check works
// regardless of Host).
//
// SETUP MODE: an Engine with no sign-in settings from either source (see
// setup/mode.ts) answers only /health and /setup. Everything else gets a
// plain 503. In setup mode there is no expected host yet, so /setup answers
// on whatever hostname the request arrived on (the platform's own); the
// one-time setup code is what guards it.
//
// FAIL CLOSED: settings that cannot be read answer 503 on every route.
//
// Once set up, the platform's *.ondigitalocean.app starter domain cannot be
// disabled. The ingress redirect to the custom domain is cosmetic; a client
// that ignores a 301 still reaches the app. This check is the only real
// enforcement, and it covers /setup too.
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();

  let mode: EngineMode;
  try {
    mode = await currentMode();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "sign-in settings unavailable",
    );
    return c.json(
      { error: { code: "unavailable", message: "Settings unavailable" } },
      503,
    );
  }
  if (mode.kind === "setup") {
    if (isSetupPath(c.req.path)) return next();
    return c.text("setup not complete", 503);
  }

  const host = c.req.header("host")?.split(":")[0] ?? "";
  if (
    host !== mode.access.host &&
    host !== "localhost" &&
    !host.startsWith("127.")
  ) {
    return wrongHost(c, mode.access.host);
  }
  return next();
});

// "/setup/" and "/app/" (a trailing slash) mean the screen without it.
app.get("/setup/", (c) => c.redirect("/setup", 301));
app.get("/app/", (c) => c.redirect("/app", 301));

// ── /setup ──────────────────────────────────────────────────────────────────
// The one-time sign-in setup page (setup/route.ts). A small body limit and
// the pre-auth rate limit come first: these routes answer before any sign-in
// exists.
app.use("/setup/*", bodyLimit({ maxSize: 16 * 1024 }));
app.use("/setup", preAuthRateLimit);
app.use("/setup/*", preAuthRateLimit);
app.use("/setup/*", ceilingRateLimit("setup", 60));
app.get("/setup/assets/:file", setupAssets);
// First run (app/first-run-routes.ts): the claim and the Database screen, and
// a gate that keeps every other /setup page behind the claim while the
// Engine has its first-run code.
app.use("/setup", firstRunGate(firstRunDeps));
app.use("/setup/*", firstRunGate(firstRunDeps));
app.route("/setup", makeFirstRunRoutes(firstRunDeps));
// After setup, /setup/database is the administrators' update screen.
app.route("/setup", makeDatabaseRoutes(screenDeps));
app.route("/setup", makeUpdatesRoutes(screenDeps));
// The setup screens after sign-in (administrators, app/settings-routes.ts).
app.route("/setup", makeSettingsRoutes(screenDeps));
app.route("/setup", makeIndexingRoutes(screenDeps));
app.route("/setup", makePipelineRoutes(screenDeps));
app.route("/setup", makeBackupRoutes(screenDeps));
app.route("/setup", makeSetupRoutes(setupDeps));

// ── /app ────────────────────────────────────────────────────────────────────
// The owner screens (app/owner-routes.ts): changes waiting for a yes, flagged
// items, pages, history. Any active person, signed in through the Engine's
// own Cloudflare application. A page body may be 200,000 characters, so the
// limit is larger than /setup's.
app.use("/app", preAuthRateLimit);
app.use("/app/*", bodyLimit({ maxSize: 1024 * 1024 }));
app.use("/app/*", preAuthRateLimit);
app.get("/app/assets/:file", setupAssets);
app.route("/app", makeOwnerRoutes(screenDeps));

// ── /health ─────────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    ok: true,
    git_sha: env.SOURCE_COMMIT,
    deployed_at: startedAt,
  }),
);

// ── /internal/curator/tick ──────────────────────────────────────────────────
// The curator's timer: Supabase cron pokes it (curator/route.ts). No sign-in;
// a shared secret checked against the vault guards it. Small body, rate
// limited before the secret check.
app.use(TICK_PATH, bodyLimit({ maxSize: 1024 }));
app.use(TICK_PATH, preAuthRateLimit);
app.route(TICK_PATH, makeTickRoute());

// ── /status ─────────────────────────────────────────────────────────────────
// The Engine dashboard (the config's `dashboard` section). Behind its own Access app with MFA;
// the route re-verifies the assertion and the DB function admits admins only.
app.get("/status/assets/:file", preAuthRateLimit, statusAssets);
app.get("/status", preAuthRateLimit, makeStatusRoute());

// ── /.well-known/* ───────────────────────────────────────────────────────────
// Browser-based MCP clients fetch these discovery documents cross-origin.
// Without CORS headers the browser blocks them and discovery silently fails.
// Allow any origin — these are public, unauthenticated metadata documents.
app.use("/.well-known/*", cors());

// RFC 9728 protected-resource discovery — served unauthenticated so an MCP
// client can find the Cloudflare Access authorization server before it holds
// a token.
//
// Verified empirically 2026-08-18 (plan Step 3): Cloudflare Access serves this
// document itself at the edge on the application hostname — both the bare and
// `/mcp`-suffixed forms — without reaching this origin. These routes are kept
// as a defensive fallback only.
//
// TWO paths must be served: the bare form AND the path-suffixed form.
// RFC 9728 §3.1 inserts the well-known segment BEFORE the resource's path,
// so a client discovering https://engine.example.com/mcp fetches
// /.well-known/oauth-protected-resource/mcp. Without the suffixed route, a
// 404 kills discovery BEFORE token exchange ("Authorization with the MCP
// server failed").
const protectedResource = async (c: Context) => {
  try {
    return c.json(buildProtectedResourceMetadata(await currentAccess()));
  } catch {
    return c.json(
      { error: { code: "not_found", message: "OAuth is not configured" } },
      404,
    );
  }
};
app.get("/.well-known/oauth-protected-resource", protectedResource);
app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

// Some MCP OAuth clients discover the authorization server by fetching OAuth/OIDC
// metadata from the RESOURCE server's origin — NOT by following protected-resource
// authorization_servers. Without these, such clients fall back to <origin>/token and
// the token exchange fails ("Failed to fetch"). Proxy Cloudflare Access's team-domain
// metadata so they discover the correct token/authorize/jwks/registration endpoints.
// Upstream non-200 → 502.
async function proxyAccessMetadata(c: Context, wellKnownPath: string) {
  try {
    const access = await currentAccess();
    if (!access) throw new Error("no sign-in settings");
    const teamDomain = access.teamDomain;
    const upstream = await fetch(
      `${teamDomain.replace(/\/$/, "")}${wellKnownPath}`,
    );
    if (!upstream.ok) {
      return c.json(
        { error: { code: "bad_gateway", message: "AS metadata unavailable" } },
        502,
      );
    }
    return c.json((await upstream.json()) as Record<string, unknown>);
  } catch {
    return c.json(
      { error: { code: "bad_gateway", message: "AS metadata unavailable" } },
      502,
    );
  }
}

app.get("/.well-known/oauth-authorization-server", (c) =>
  proxyAccessMetadata(c, "/.well-known/oauth-authorization-server"),
);
app.get("/.well-known/openid-configuration", (c) =>
  proxyAccessMetadata(c, "/.well-known/openid-configuration"),
);

// ── /mcp ─────────────────────────────────────────────────────────────────────

// Body limit BEFORE auth — a single 200 MB POST OOM-kills a 512 MB instance.
// instance_count: 1 means that is a full outage. 64 KB is generous for JSON-RPC.
app.use("/mcp", bodyLimit({ maxSize: 64 * 1024 }));

// Rate limit BEFORE JWT verification — an unauthenticated flood must be rejected
// cheaply without paying for a JWKS fetch per request. App Platform provides no
// L7 rate limiting at any tier.
app.use("/mcp", preAuthRateLimit);

// CORS on /mcp BEFORE requireAuth, so:
//   (a) CORS preflight (OPTIONS) is answered without auth
//   (b) the 401 itself carries CORS headers exposing WWW-Authenticate
// A browser-based MCP client (Inspector, claude.ai) needs to read that header to
// kick off OAuth. Without CORS on the 401, it's blocked before seeing the challenge.
//
// `origin: '*'` is correct here. Auth is via the `Cf-Access-Jwt-Assertion` header,
// not a cookie — no ambient credential a browser attaches automatically. A wildcard
// origin grants a hostile page nothing it could not do from curl: it can make the
// request but has no assertion to attach. The dangerous case (wildcard CORS +
// implicit auth) does not apply. Annotated here so this decision is not re-litigated.
app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Cf-Access-Jwt-Assertion",
      "Accept",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-ID",
    ],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    maxAge: 86400,
  }),
);

app.use("/mcp", requireAuth);
app.use("/mcp", postAuthRateLimit);

// Route ALL methods — not just POST — to the transport so the MCP SDK handles
// GET (SSE stream) and DELETE (session teardown), not a bare 404.
// OPTIONS is already short-circuited by cors() above.
app.all("/mcp", (c) =>
  handleMcpRequest(c.req.raw, c.var["auth"] as { sub: string; email: string }),
);

// Anything else: a page with the menu under /setup and /app, plain text elsewhere.
app.notFound(notFoundPage);

// ── Server startup ─────────────────────────────────────────────────────────
if (env.NODE_ENV !== "test") {
  // A new Engine with no SETUP_CODE makes its one-time claim code now.
  await startFirstRun(liveFirstRunDeps(currentMode));
  // An app update can ship migrations the database does not have yet.
  void warnPendingAtBoot(liveDatabase(), currentMode);
  // A run the previous process left "running" would block every tick until
  // its lease ran out; close it now. Never throws (an Engine still in setup
  // has no curator yet, and that is only logged).
  void reclaimAtBoot(curatorStore);
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info(
      { port: info.port, node_env: env.NODE_ENV, git_sha: env.SOURCE_COMMIT },
      "kb-engine listening",
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutdown initiated");
    server.close(() => process.exit(0));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export { app };
