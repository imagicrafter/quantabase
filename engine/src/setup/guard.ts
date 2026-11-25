import type { AccessSettings } from "../config/settings.js";
import { isMcpAppError } from "../mcp/errors.js";

/**
 * Who may open /setup once the Engine has sign-in settings: the same people
 * as /status. The request must carry a Cloudflare assertion for the
 * status-and-setup application (the one with the second factor), and the
 * person must be an active administrator in the database.
 *
 * FAIL CLOSED: no assertion, no audience for that application, an audience
 * equal to the connector's, a failed check, or a database that cannot answer
 * all end in a refusal.
 */

export type GuardDeps = {
  readonly verify: (
    assertion: string,
    audience: string,
    issuer: string,
  ) => Promise<{ email: string }>;
  readonly isAdmin: (email: string) => Promise<boolean>;
  /** AUD tag of the status-and-setup application, if one is known. */
  readonly statusAudience: (
    access: AccessSettings,
  ) => Promise<string | undefined>;
  /** Throws for an email outside the optional domain allowlist. */
  readonly assertEmailAllowed: (email: string) => void;
};

export type GuardResult =
  | { readonly ok: true; readonly email: string }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly title: string;
      readonly message: string;
    };

const refuse = (
  status: 401 | 403 | 503,
  title: string,
  message: string,
): GuardResult => ({ ok: false, status, title, message });

const UNAVAILABLE = refuse(
  503,
  "Sign-in check unavailable",
  "The sign-in could not be checked just now. Try again in a minute.",
);

/** The audience this page's assertions must carry, or a refusal. */
async function pageAudience(
  deps: GuardDeps,
  access: AccessSettings,
): Promise<string | GuardResult> {
  let audience: string | undefined;
  try {
    audience = await deps.statusAudience(access);
  } catch {
    return UNAVAILABLE;
  }
  // An audience equal to the connector's would let a connector sign-in (no
  // second factor) open this page.
  if (!audience || audience === access.aud) {
    return refuse(
      503,
      "Page not configured",
      "No sign-in application of its own is set for this page.",
    );
  }
  return audience;
}

export async function requireAdministrator(
  deps: GuardDeps,
  access: AccessSettings,
  assertion: string | undefined,
): Promise<GuardResult> {
  if (!assertion) {
    return refuse(
      401,
      "Sign in required",
      "Open this page through its Cloudflare sign-in link.",
    );
  }
  const audience = await pageAudience(deps, access);
  if (typeof audience !== "string") return audience;

  let email: string;
  try {
    email = (await deps.verify(assertion, audience, access.teamDomain)).email;
    deps.assertEmailAllowed(email);
  } catch (err) {
    return isMcpAppError(err) && err.code === "internal_error"
      ? UNAVAILABLE
      : refuse(
          401,
          "Sign in required",
          "Your sign-in was not accepted. Sign in again.",
        );
  }

  let admin: boolean;
  try {
    admin = await deps.isAdmin(email);
  } catch {
    return UNAVAILABLE;
  }
  return admin
    ? { ok: true, email }
    : refuse(
        403,
        "No access",
        "This page is only for the Engine's administrators.",
      );
}
