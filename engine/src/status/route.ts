import type { Context } from "hono";
import { env } from "../env.js";
import { logger } from "../log/logger.js";
import { isMcpAppError } from "../mcp/errors.js";
import { db } from "../db.js";
import { verifyAccessAssertion } from "../auth/access/verify-access-assertion.js";
import { assertEmailDomainAllowed } from "../auth/principal.js";
import {
  currentAccess,
  currentSettings,
  type AccessSettings,
} from "../config/settings.js";
import { statusConfigFrom, type StatusConfig } from "./config.js";
import { assetVersion } from "./assets.js";
import { buildModel } from "./model.js";
import { esc, renderPage } from "./page.js";
import { StatusDataSchema, type StatusData } from "./readings.js";

/**
 * GET /status: the Engine dashboard.
 *
 * Cloudflare Access fronts this path with its own application (Independent
 * MFA), so a browser arrives here only after email code + 2FA. The route still
 * verifies the assertion itself, against the /status app's AUD, and the
 * database function re-checks that the caller is an active administrator.
 */

/** No inline script or style anywhere: the page links two same-origin files. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export type StatusDeps = {
  readonly verify: (
    assertion: string,
    audience: string,
    issuer: string,
  ) => Promise<{ email: string }>;
  readonly readStatus: (email: string) => Promise<unknown>;
  /** The page's view of the applied config; null when none is applied. */
  readonly config: () => Promise<StatusConfig | null>;
  /** Sign-in settings; null when the Engine is not set up. */
  readonly access: () => Promise<AccessSettings | null>;
  readonly now: () => Date;
};

class ForbiddenError extends Error {}

async function readStatusFromDb(email: string): Promise<unknown> {
  const { data, error } = await db().rpc("engine_status", { p_email: email });
  if (error) {
    if (error.code === "42501")
      throw new ForbiddenError("not an administrator");
    throw new Error(`engine_status failed: ${error.message}`);
  }
  return data;
}

/** Read through the settings cache (about a minute), never from disk. */
async function statusConfigFromSettings(): Promise<StatusConfig | null> {
  const { config } = await currentSettings();
  return config ? statusConfigFrom(config) : null;
}

export const defaultDeps: StatusDeps = {
  verify: (assertion, audience, issuer) =>
    verifyAccessAssertion(assertion, { audience, issuer }),
  readStatus: readStatusFromDb,
  config: statusConfigFromSettings,
  access: currentAccess,
  now: () => new Date(),
};

function plainPage(
  c: Context,
  status: 401 | 403 | 503,
  title: string,
  message: string,
) {
  c.header("Content-Security-Policy", CSP);
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 16px"><h1>${esc(title)}</h1><p>${esc(message)}</p></body>`,
    status,
  );
}

const signInRequired = (c: Context, message: string) =>
  plainPage(c, 401, "Sign in required", message);

async function authenticate(
  c: Context,
  deps: StatusDeps,
  assertion: string,
  audience: string,
  issuer: string,
): Promise<string | Response> {
  try {
    const { email } = await deps.verify(assertion, audience, issuer);
    assertEmailDomainAllowed(email);
    return email;
  } catch (err) {
    const infra = isMcpAppError(err) && err.code === "internal_error";
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "status: sign-in rejected",
    );
    return infra
      ? plainPage(
          c,
          503,
          "Sign-in check unavailable",
          "Cloudflare could not be reached. Try again in a minute.",
        )
      : signInRequired(c, "Your sign-in was not accepted. Sign in again.");
  }
}

type Ready = {
  readonly config: StatusConfig;
  readonly access: AccessSettings;
  readonly audience: string;
  readonly assertion: string;
};

const unavailable = (c: Context, err: unknown) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    "status: settings unavailable",
  );
  return plainPage(
    c,
    503,
    "Settings unavailable",
    "The Engine's database did not answer. Try again in a minute.",
  );
};

/**
 * Everything needed before anyone is let in, or the plain page to send.
 *
 * FAIL CLOSED: no sign-in settings, no assertion, no audience for this page,
 * or settings that cannot be read each end in a 503 or 401. Nothing is drawn
 * without a verified administrator. A request with no assertion is turned
 * away before the config is read at all.
 */
async function prepare(
  c: Context,
  deps: StatusDeps,
): Promise<Ready | Response> {
  let access: AccessSettings | null;
  try {
    access = await deps.access();
  } catch (err) {
    return unavailable(c, err);
  }
  if (!access)
    return plainPage(
      c,
      503,
      "Sign-in not set up",
      "This Engine's sign-in has not been set up yet.",
    );

  const assertion = c.req.header("Cf-Access-Jwt-Assertion");
  if (!assertion)
    return signInRequired(
      c,
      "Open this page through its Cloudflare sign-in link.",
    );

  let config: StatusConfig | null;
  try {
    config = await deps.config();
  } catch (err) {
    return unavailable(c, err);
  }
  if (!config)
    return plainPage(
      c,
      503,
      "Engine not configured",
      "No Engine config has been applied yet.",
    );

  const audience =
    env.CF_ACCESS_STATUS_AUD ??
    access.statusAud ??
    config.engine.connect.status_page_aud;
  // This page has its own sign-in app (with a second factor). An audience
  // equal to the /mcp app's would let an /mcp sign-in open it, so that is
  // refused wherever the value came from.
  if (!audience || audience === access.aud)
    return plainPage(
      c,
      503,
      "Dashboard not configured",
      "No sign-in app of its own is set for this page.",
    );
  return { config, access, audience, assertion };
}

export function makeStatusRoute(deps: StatusDeps = defaultDeps) {
  return async (c: Context) => {
    const ready = await prepare(c, deps);
    if (ready instanceof Response) return ready;
    const { config, access, audience, assertion } = ready;

    const email = await authenticate(
      c,
      deps,
      assertion,
      audience,
      access.teamDomain,
    );
    if (typeof email !== "string") return email;

    let data: StatusData;
    try {
      data = StatusDataSchema.parse(await deps.readStatus(email));
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return plainPage(
          c,
          403,
          "No access",
          "This dashboard is only for the Engine's administrators.",
        );
      }
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "status: readings unavailable",
      );
      return plainPage(
        c,
        503,
        "Readings unavailable",
        "The Engine's database did not answer. Try again in a minute.",
      );
    }

    c.header("Content-Security-Policy", CSP);
    c.header("Cache-Control", "no-store");
    return c.html(
      renderPage(
        // prepare() refused unless this page has a sign-in app of its own.
        buildModel(config, data, deps.now(), {
          host: access.host,
          level: access.level,
          ownSignInApp: true,
        }),
        assetVersion(),
        email,
      ),
    );
  };
}

export { ForbiddenError };
