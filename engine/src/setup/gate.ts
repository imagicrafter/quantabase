import type { Context } from "hono";
import type { AccessSettings } from "../config/settings.js";
import { logger } from "../log/logger.js";
import type { StoredAccess } from "./apply.js";
import { setupAssetVersion } from "./assets.js";
import type { FetchLike } from "./cloudflare-client.js";
import { requireAdministrator, type GuardDeps } from "./guard.js";
import type { EngineMode } from "./mode.js";
import { messagePage, SETUP_CSP } from "./page.js";
import { refusalBody, wantsJson } from "./reply.js";
import {
  verifySetupCode,
  type SetupCodeDeps,
  type SetupCodeResult,
} from "./setup-code.js";

/**
 * What every /setup request passes through before a handler looks at it:
 * which state the Engine is in, who is asking, whether a form post came from
 * this page, and whether the setup code is right.
 *
 * WHO GETS IN. In setup mode there is no sign-in to check, so the one-time
 * setup code is the gate: nothing is validated, shown or done without it.
 * Once the Engine has sign-in settings, every /setup route first needs what
 * /status needs (guard.ts), and the code as well.
 */

export type SetupDeps = {
  /** SETUP_CODE, or undefined when the app has none. */
  readonly setupCode: string | undefined;
  /**
   * The first-run code, when this request carries a valid claim session
   * (app/first-run-routes.ts). The claim stands in for typing the code.
   */
  readonly sessionCode?: (c: Context) => string | undefined;
  readonly mode: () => Promise<EngineMode>;
  /** Owner email from the applied config, or null when there is none. */
  readonly ownerEmail: () => Promise<string | null>;
  /**
   * The hostname the applied config names for the Engine, or null. Only used
   * to fill in the form's hostname box; the form's own value is what counts.
   */
  readonly configuredHost?: () => Promise<string | null>;
  readonly lockout: Omit<SetupCodeDeps, "expected">;
  readonly complete: (code: string, access: StoredAccess) => Promise<boolean>;
  readonly cloudflareFetch: FetchLike;
  readonly guard: GuardDeps;
  /** Called once setup has completed, to drop cached settings. */
  readonly onCompleted: () => void;
  readonly now: () => number;
};

export type Status = 200 | 400 | 401 | 403 | 409 | 415 | 422 | 429 | 502 | 503;

function headers(c: Context): void {
  c.header("Content-Security-Policy", SETUP_CSP);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  // So this page's own form posts carry an Origin header (see sameOrigin).
  c.header("Referrer-Policy", "same-origin");
}

export function page(c: Context, status: Status, html: string): Response {
  headers(c);
  return c.html(html, status);
}

/** The same answer as a page, as JSON (see reply.ts). Same headers. */
export function json(c: Context, status: Status, body: object): Response {
  headers(c);
  return c.json(body, status);
}

export const message = (
  c: Context,
  status: Status,
  title: string,
  text: string,
) =>
  wantsJson(c)
    ? json(c, status, refusalBody(title, text))
    : page(
        c,
        status,
        messagePage(title, text, setupAssetVersion(), status !== 503),
      );

export const UNAVAILABLE = [
  "Setup is unavailable",
  "The Engine's database did not answer. Try again in a minute.",
] as const;

/** Where a request stands before any form field is looked at. */
export type Stage =
  | { readonly kind: "respond"; readonly response: Response }
  | {
      readonly kind: "open";
      readonly reopened: boolean;
      /** The sign-in settings in force, when setup was reopened. */
      readonly access: AccessSettings | null;
    }
  | {
      readonly kind: "closed";
      readonly access: AccessSettings;
      readonly reason: "environment" | "complete" | "no_code";
      readonly email: string;
    };

export async function stage(c: Context, deps: SetupDeps): Promise<Stage> {
  let mode: EngineMode;
  try {
    mode = await deps.mode();
  } catch {
    return { kind: "respond", response: message(c, 503, ...UNAVAILABLE) };
  }

  if (mode.kind === "setup") {
    if (deps.setupCode) return { kind: "open", reopened: false, access: null };
    return {
      kind: "respond",
      response: message(
        c,
        503,
        "Setup is not available",
        "This app has no setup code. Set SETUP_CODE on the app, then open this page again.",
      ),
    };
  }

  const who = await requireAdministrator(
    deps.guard,
    mode.access,
    c.req.header("Cf-Access-Jwt-Assertion"),
  );
  if (!who.ok) {
    return {
      kind: "respond",
      response: message(c, who.status, who.title, who.message),
    };
  }
  const closed = (reason: "environment" | "complete" | "no_code"): Stage => ({
    kind: "closed",
    access: mode.access,
    reason,
    email: who.email,
  });
  if (mode.access.source === "environment") return closed("environment");
  if (!mode.setupOpen) return closed("complete");
  if (!deps.setupCode) return closed("no_code");
  return { kind: "open", reopened: true, access: mode.access };
}

/** The hostname this request arrived on, lower-cased, without a port. */
export function arrivalHost(c: Context): string {
  return (c.req.header("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
}

/**
 * A form post must come from this page. The setup code already makes a
 * faked post useless (whoever sent it does not have the code); this is a second check.
 * Browsers say where a request came from in Sec-Fetch-Site, and in Origin.
 */
export function sameOrigin(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = c.req.header("origin");
  if (!origin) return true; // not a browser: no cross-site request to fake
  try {
    return new URL(origin).host === c.req.header("host");
  } catch {
    return false;
  }
}

export type Posted =
  | {
      readonly ok: true;
      readonly form: Readonly<Record<string, unknown>>;
      readonly reopened: boolean;
    }
  | { readonly ok: false; readonly response: Response };

/** The checks every POST passes before its fields are read. */
export async function posted(c: Context, deps: SetupDeps): Promise<Posted> {
  const at = await stage(c, deps);
  if (at.kind === "respond") return { ok: false, response: at.response };
  const refuse = (status: Status, title: string, text: string): Posted => ({
    ok: false,
    response: message(c, status, title, text),
  });
  if (at.kind === "closed") {
    return refuse(
      409,
      "Setup is closed",
      "Sign-in is already set up. To change it, reopen setup first.",
    );
  }
  if (!sameOrigin(c)) {
    return refuse(
      403,
      "Not accepted",
      "Send this form from the setup page itself.",
    );
  }
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return refuse(
      415,
      "Not accepted",
      "Send this form from the setup page itself.",
    );
  }
  try {
    return { ok: true, form: await c.req.parseBody(), reopened: at.reopened };
  } catch {
    return refuse(400, "Not accepted", "The form could not be read.");
  }
}

function codeRefusal(c: Context, result: SetupCodeResult): Response | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "not_configured":
      return message(
        c,
        503,
        "Setup is not available",
        "This app has no setup code.",
      );
    case "locked": {
      const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
      c.header("Retry-After", String(Math.max(1, result.retryAfterSeconds)));
      return message(
        c,
        429,
        "Setup is locked",
        `Too many wrong setup codes. Nothing is accepted for about ${minutes} more minutes.`,
      );
    }
    case "wrong":
      return message(c, 401, "Wrong setup code", "That is not the setup code.");
    case "closed":
      return message(
        c,
        409,
        "Setup code not accepted",
        "The setup window is closed, or the code set on the app is not the one in the database. Run `kbe access reopen` and set the new code as SETUP_CODE.",
      );
  }
}

/** Check the code. A Response means stop and send it. */
export async function checkCode(
  c: Context,
  deps: SetupDeps,
  code: unknown,
): Promise<Response | null> {
  try {
    const result = await verifySetupCode(
      { ...deps.lockout, expected: deps.setupCode },
      code,
    );
    return codeRefusal(c, result);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "setup: the setup code could not be checked",
    );
    return message(c, 503, ...UNAVAILABLE);
  }
}
