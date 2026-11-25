import { createMiddleware } from "hono/factory";
import { decodeJwt } from "jose";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isMcpAppError } from "../mcp/errors.js";
import { logger } from "../log/logger.js";
import { currentAccess, type AccessSettings } from "../config/settings.js";
import { verifyAccessAssertion } from "./access/verify-access-assertion.js";
import { resolvePrincipal, assertEmailDomainAllowed } from "./principal.js";

export type AuthContext = {
  readonly sub: string;
  readonly email: string;
};

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

const errorBody = (code: string, message: string) => ({
  error: { code, message },
});

/**
 * The `oauth-protected-resource` metadata URL derived from the resource URL's origin.
 * MCP clients read this from the `WWW-Authenticate` challenge on a 401 to discover
 * the authorization server (RFC 9728 + MCP auth spec).
 */
function resourceMetadataUrl(resourceUrl: string): string {
  try {
    return `${new URL(resourceUrl).origin}/.well-known/oauth-protected-resource`;
  } catch {
    return `${resourceUrl}/.well-known/oauth-protected-resource`;
  }
}

/**
 * 401 with the `WWW-Authenticate` challenge required by the MCP authorization spec.
 * Without it, a fresh MCP client cannot discover where to authenticate.
 */
function unauthorized(
  c: Context,
  access: AccessSettings,
  code: string,
  message: string,
) {
  const meta = resourceMetadataUrl(access.resourceUrl);
  c.header(
    "WWW-Authenticate",
    `Bearer error="unauthorized", error_description="Authorization needed", resource_metadata="${meta}"`,
  );
  return c.json(errorBody(code, message), 401);
}

/**
 * The sign-in settings, or the 503 to send when there are none.
 *
 * FAIL CLOSED: an Engine with no sign-in settings (not set up yet), or one
 * whose settings cannot be read, has nothing to verify an assertion against.
 * It refuses every request rather than letting any through.
 */
async function accessOrRefusal(c: Context): Promise<AccessSettings | Response> {
  try {
    const access = await currentAccess();
    if (access) return access;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "sign-in settings unavailable",
    );
    return c.json(
      errorBody("unavailable", "Sign-in settings are unavailable"),
      503,
    );
  }
  return c.json(
    errorBody("not_configured", "This Engine's sign-in is not set up yet"),
    503,
  );
}

/**
 * Decode a JWT's claims WITHOUT verifying — diagnostics only.
 * Lets us log aud/iss/exp of a rejected assertion so a mismatch is visible.
 * Never trust these values for authz.
 */
function unverifiedClaims(token: string): Record<string, unknown> {
  try {
    const p = decodeJwt(token);
    return { aud: p.aud, iss: p.iss, exp: p.exp, sub: p.sub };
  } catch {
    return { decode: "failed" };
  }
}

/**
 * Authentication middleware. Cloudflare Access-ONLY.
 *
 * Decision 7 in the plan: there is no token fallback in /mcp. The rejected design
 * dispatched on verification FAILURE — a bearer that did not verify as a valid
 * assertion was hashed and tried as a token. That means any string reaching this
 * route reaches the MCP tool surface, resolves to zero domains, and returns 200
 * with an empty result instead of 401. It is also precisely the silent-zero-on-
 * unauthenticated failure that supabase/functions/search/index.ts:14-17 exists to
 * refuse.
 *
 * Missing `Cf-Access-Jwt-Assertion` → 401, never a pass-through. This is what
 * makes a direct call to the *.ondigitalocean.app hostname (which App Platform
 * cannot disable) non-exploitable: it never carries a Cloudflare-signed assertion.
 *
 * Rule: unknown identity → 401 with WWW-Authenticate.
 *        Known principal with zero grants → 200 empty (tool handles this).
 * The two must never collapse into one response.
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const access = await accessOrRefusal(c);
  if (access instanceof Response) return access;

  const assertion = c.req.header("Cf-Access-Jwt-Assertion");
  if (!assertion) {
    return unauthorized(
      c,
      access,
      "unauthenticated",
      "Missing Cf-Access-Jwt-Assertion header",
    );
  }

  let sub: string;
  let email: string;

  try {
    const identity = await verifyAccessAssertion(assertion, {
      issuer: access.teamDomain,
      audience: access.aud,
    });
    sub = identity.sub;
    email = identity.email;
  } catch (err) {
    if (isMcpAppError(err)) {
      if (err.code === "internal_error") {
        logger.error({ err }, "Access verification unavailable");
        return c.json(errorBody(err.code, err.message), 500);
      }
      // Assertion failed verification. Log unverified claims for diagnosability
      // (aud/iss mismatch is the Cloudflare equivalent of the silent-401 that
      // this codebase already has scar tissue about).
      logger.warn(
        {
          reason: err.message,
          cause: (err as { details?: { cause?: unknown } }).details?.cause,
          token_claims: unverifiedClaims(assertion),
          expected_aud: access.aud,
          expected_iss: access.teamDomain,
        },
        "Access assertion rejected",
      );
      return unauthorized(c, access, err.code, err.message);
    }
    logger.error({ err }, "Unexpected Access verification error");
    return c.json(errorBody("internal_error", "Authentication failed"), 500);
  }

  // Pre-database email domain check. An unprovisioned stranger must never reach Postgres.
  try {
    assertEmailDomainAllowed(email);
  } catch (err) {
    if (isMcpAppError(err)) {
      return c.json(
        errorBody(err.code, err.message),
        err.httpStatus as ContentfulStatusCode,
      );
    }
    return c.json(errorBody("forbidden", "Email domain not allowed"), 403);
  }

  let authCtx: AuthContext;
  try {
    const principal = await resolvePrincipal(sub, email);
    authCtx = { sub: principal.sub, email: principal.email };
  } catch (err) {
    if (isMcpAppError(err)) {
      if (err.code === "internal_error") {
        logger.error({ err, sub }, "Principal resolution failed");
        return c.json(errorBody(err.code, err.message), 500);
      }
      return c.json(
        errorBody(err.code, err.message),
        err.httpStatus as ContentfulStatusCode,
      );
    }
    logger.error({ err, sub }, "Unexpected principal resolution error");
    return c.json(errorBody("internal_error", "Authentication failed"), 500);
  }

  c.set("auth", authCtx);
  await next();
});
