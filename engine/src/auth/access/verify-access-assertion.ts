import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { currentAccess } from "../../config/settings.js";
import { McpAppError } from "../../mcp/errors.js";

/**
 * The verified identity extracted from a Cloudflare Access `Cf-Access-Jwt-Assertion`.
 * The Access application token carries `email` directly, so no separate
 * lookup is needed to resolve it.
 */
export type VerifiedAccessIdentity = {
  readonly email: string;
  readonly sub: string;
};

/**
 * Optional dependency injection seam for tests: supply a JWKS resolver plus the
 * expected issuer/audience so a verifier can run against locally-generated keys
 * without env config or network access. Mirrors verify-oauth-token.ts's seam.
 */
export type VerifyAccessAssertionOptions = {
  readonly jwks?: Parameters<typeof jwtVerify>[1];
  readonly issuer?: string;
  readonly audience?: string;
};

/**
 * Lazily-built, module-cached remote JWKS, one per team domain.
 * `createRemoteJWKSet` performs its own key caching + cooldown, so one instance
 * is reused across requests. Cloudflare rotates the Access signing key roughly
 * every six weeks; `createRemoteJWKSet` handles this transparently and must not
 * be replaced with a pinned key.
 */
const remoteJwks = new Map<string, JWTVerifyGetKey>();

function getRemoteJwks(teamDomain: string): JWTVerifyGetKey {
  const known = remoteJwks.get(teamDomain);
  if (known) return known;
  const jwks = createRemoteJWKSet(
    new URL(`${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`),
  );
  remoteJwks.set(teamDomain, jwks);
  return jwks;
}

/** Reset the memoized JWKS — only used in tests. */
export function _resetAccessJwks(): void {
  remoteJwks.clear();
}

/**
 * jose error codes that indicate an infrastructure/availability problem fetching or
 * matching the remote JWKS — a Cloudflare outage, DNS/TLS failure, timeout, or key
 * rotation — rather than a client presenting an invalid assertion. These must map to
 * `internal_error` (logged, 500) so an upstream blip is observable and doesn't tell
 * every user their assertion is invalid. Everything else is a validation failure.
 * Mirrors the same split in verify-oauth-token.ts.
 */
const INFRA_JOSE_CODES = new Set([
  "ERR_JWKS_TIMEOUT",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

function isInfraError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && INFRA_JOSE_CODES.has(code);
}

/**
 * Validate a Cloudflare Access `Cf-Access-Jwt-Assertion`. Verifies the signature
 * against the team JWKS and checks `iss`, `aud`, and `exp`, then extracts the
 * user's subject and verified email.
 *
 * Throws `McpAppError('unauthenticated', ...)` when an assertion fails signature /
 * `iss` / `aud` / `exp` validation, is missing `sub`, or carries no `email` claim
 * (absent email is a misconfiguration under Access, not a provider quirk; there
 * is no fallback email lookup). Throws `McpAppError('internal_error', ...)`
 * if the Access path is reached while unconfigured or the team JWKS is unavailable.
 */
export async function verifyAccessAssertion(
  assertion: string,
  options: VerifyAccessAssertionOptions = {},
): Promise<VerifiedAccessIdentity> {
  // Sign-in settings are looked up only for what the caller did not supply.
  const needsSettings = !options.issuer || !options.audience;
  const access = needsSettings ? await currentAccess() : null;
  const issuer = options.issuer ?? access?.teamDomain;
  const audience = options.audience ?? access?.aud;

  if (!issuer || !audience) {
    throw new McpAppError(
      "internal_error",
      "Access not configured: no team domain or audience is set",
    );
  }

  const jwks = options.jwks ?? getRemoteJwks(issuer);

  let payload: Record<string, unknown>;
  try {
    // Pin RS256 explicitly (defense-in-depth against alg-confusion), even though the
    // RSA JWKS already constrains key selection to RSA signature algorithms.
    const verified = await jwtVerify(assertion, jwks, {
      issuer,
      audience,
      algorithms: ["RS256"],
    });
    payload = verified.payload;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    if (isInfraError(err)) {
      throw new McpAppError(
        "internal_error",
        "Access verification temporarily unavailable",
        {
          cause,
        },
      );
    }
    throw new McpAppError("unauthenticated", "Invalid Access assertion", {
      cause,
    });
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new McpAppError(
      "unauthenticated",
      "Access assertion missing subject",
    );
  }

  const rawEmail = payload.email;
  const email =
    typeof rawEmail === "string" && rawEmail.length > 0 ? rawEmail : undefined;

  // Under Access, email is always expected on the assertion. Absent email means
  // the application isn't gated by an identity-carrying login method (e.g. a
  // service token reached this route), which is a misconfiguration, not a
  // provider quirk to work around.
  if (!email) {
    throw new McpAppError(
      "unauthenticated",
      "Access assertion missing email claim",
    );
  }

  return { email, sub };
}
