import { assertEmailDomainAllowed } from "../auth/principal.js";
import { verifyAccessAssertion } from "../auth/access/verify-access-assertion.js";
import {
  currentSettings,
  invalidateSettings,
  type AccessSettings,
} from "../config/settings.js";
import { env } from "../env.js";
import { statusConfigFrom } from "../status/config.js";
import {
  attemptCheck,
  attemptFail,
  codeValid,
  completeSetup,
  isAdministrator,
} from "./db.js";
import type { SetupDeps } from "./gate.js";
import { currentMode } from "./mode.js";
import { bootCode } from "../app/first-run.js";
import { CLAIM_COOKIE, readCookie } from "../app/boot-code.js";

/** The setup routes' real dependencies: the database, Cloudflare, the clock. */

/** Same order as the status page: variable, stored settings, then config. */
async function statusAudience(
  access: AccessSettings,
): Promise<string | undefined> {
  if (env.CF_ACCESS_STATUS_AUD) return env.CF_ACCESS_STATUS_AUD;
  if (access.statusAud) return access.statusAud;
  const { config } = await currentSettings();
  return config
    ? statusConfigFrom(config).engine.connect.status_page_aud
    : undefined;
}

/** The hostname in the config's connector address, or null. */
export function hostOfConnector(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

const live: SetupDeps = {
  // The deployed SETUP_CODE, else this process's first-run code (app/first-run.ts).
  get setupCode() {
    return env.SETUP_CODE ?? bootCode().original();
  },
  sessionCode: (c) => {
    if (env.SETUP_CODE) return undefined;
    const boot = bootCode();
    return boot.session(readCookie(c.req.header("cookie"), CLAIM_COOKIE))
      ? boot.original()
      : undefined;
  },
  mode: currentMode,
  // The config's owner, else the owner named on the Database screen.
  ownerEmail: async () =>
    (await currentSettings()).config?.engine.owner.email ??
    bootCode().claimedOwner(),
  configuredHost: async () =>
    hostOfConnector(
      (await currentSettings()).config?.dashboard?.connect?.connector_url,
    ),
  lockout: { attemptCheck, attemptFail, codeValid },
  complete: completeSetup,
  // The process-wide fetch, which the outbound allowlist already limits; the
  // Cloudflare client limits it further, to the Cloudflare API alone.
  cloudflareFetch: (url, init) => fetch(url, init),
  guard: {
    verify: (assertion, audience, issuer) =>
      verifyAccessAssertion(assertion, { audience, issuer }),
    isAdmin: isAdministrator,
    statusAudience,
    assertEmailAllowed: assertEmailDomainAllowed,
  },
  onCompleted: invalidateSettings,
  now: Date.now,
};

let current: SetupDeps = live;

/** The dependencies in use. Read on every request. */
export function setupDeps(): SetupDeps {
  return current;
}

/** Replace some dependencies. Tests only; pass nothing to restore them. */
export function _setSetupDepsForTests(over?: Partial<SetupDeps>): void {
  current = over ? { ...live, ...over } : live;
}
