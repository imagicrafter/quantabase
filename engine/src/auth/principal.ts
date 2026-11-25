import { db } from "../db.js";
import { McpAppError } from "../mcp/errors.js";
import { logger } from "../log/logger.js";
import { env } from "../env.js";

export type Principal = {
  readonly sub: string;
  readonly email: string;
};

/**
 * Resolve a verified OAuth `sub` to a principal identity.
 *
 * Identity resolves on `oauth_subject`, not email. Email is bootstrap-only
 * (trust-on-first-use): if no principal carries this `sub`, look one up by
 * verified email where `oauth_subject is null`, write the `sub` back and pin
 * it. After that, the principal is reachable only by `oauth_subject`.
 *
 * `email` is always present here — under Cloudflare Access it is a required
 * claim on the verified assertion (verifyAccessAssertion rejects its absence),
 * so there is no fallback lookup of the email anywhere else.
 *
 * TWO OUTCOMES THAT MUST NEVER COLLAPSE INTO ONE:
 *   - Unknown or unprovisioned identity → throw McpAppError('forbidden')
 *   - Known principal with zero grants → return principal (tool gets empty results)
 *
 * These are distinguished by `resolved_domain_count_for_oauth_subject`, which
 * (as of migration 0020) returns NULL for an unknown subject and an integer
 * (including 0) for a known one. Before 0020 it coalesced both cases to 0,
 * which made `domainCount !== null` always true and silently skipped the
 * bootstrap path below on every first login — see
 * engine/tests/auth/bootstrap-tofu.test.ts for the regression test.
 *
 * Logging posture (sub is opaque; email is PII — log at debug only):
 *   - Log `sub` and resolved domain COUNT at info.
 *   - Email at debug only.
 *   - Never log domain names, the token, or any hash.
 */
export async function resolvePrincipal(
  sub: string,
  email: string,
): Promise<Principal> {
  // Step 1: try by oauth_subject (steady-state path).
  const domainCount = await callDomainCount(sub);

  if (domainCount !== null) {
    // Principal exists. Log count, not domains.
    logger.info(
      { sub, domain_count: domainCount },
      "OAuth authenticated by oauth_subject",
    );
    logger.debug({ sub, email }, "OAuth email (debug only)");
    return { sub, email };
  }

  // Step 2: bootstrap path — try by verified email.
  // Only allowed when oauth_subject is null (TOFU, first login only).
  const verifiedEmail = email;

  // Check domain allowlist before hitting the DB.
  assertEmailDomainAllowed(verifiedEmail);

  // Attempt to claim the principal by email.
  const { data: claimRows, error: claimErr } = await db()
    .rpc("claim_oauth_subject", {
      p_email: verifiedEmail,
      p_oauth_subject: sub,
    });

  if (claimErr) {
    logger.error({ err: claimErr, sub }, "claim_oauth_subject RPC failed");
    throw new McpAppError("internal_error", "Identity resolution failed");
  }

  if (!claimRows || (claimRows as unknown[]).length === 0) {
    logger.warn({ sub }, "Bootstrap: no principal matched email; rejecting");
    throw new McpAppError(
      "forbidden",
      "Authenticated identity is not provisioned for access",
    );
  }

  // Pin succeeded (or was already pinned by a concurrent request). Verify grant count.
  const countAfterClaim = await callDomainCount(sub);
  logger.info(
    { sub, domain_count: countAfterClaim ?? 0 },
    "OAuth principal claimed via bootstrap email (TOFU)",
  );
  logger.debug({ sub, email: verifiedEmail }, "Bootstrap email (debug only)");

  return { sub, email: verifiedEmail };
}

async function callDomainCount(sub: string): Promise<number | null> {
  const { data, error } = await db()
    .rpc("resolved_domain_count_for_oauth_subject", { p_sub: sub });

  if (error) {
    if (error.message?.includes("permission denied")) {
      throw new McpAppError(
        "internal_error",
        "Database role misconfigured — kb_engine lacks execute",
      );
    }
    return null;
  }

  // resolved_domain_count_for_oauth_subject returns NULL for an unknown/
  // unprovisioned subject and an integer (including 0) for a known one.
  return typeof data === "number" ? data : null;
}

/**
 * Reject an email whose domain is not in ALLOWED_EMAIL_DOMAINS.
 * Pre-database rejection: an unprovisioned stranger never reaches Postgres.
 * No-op when ALLOWED_EMAIL_DOMAINS is unset.
 */
export function assertEmailDomainAllowed(email: string): void {
  const allowedRaw = env.ALLOWED_EMAIL_DOMAINS;
  if (!allowedRaw) return;

  const allowed = allowedRaw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return;

  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || !allowed.includes(domain)) {
    throw new McpAppError("forbidden", "Email domain not allowed");
  }
}
