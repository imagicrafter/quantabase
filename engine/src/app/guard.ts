import type { Context } from "hono";
import { isMcpAppError } from "../mcp/errors.js";
import type { AccessSettings } from "../config/settings.js";
import { requireAdministrator, type GuardDeps } from "../setup/guard.js";
import type { EngineMode } from "../setup/mode.js";
import { isFormPost, sameSite, type Csrf } from "./csrf.js";
import { sendMessage, type Area } from "./html.js";
import { UPDATE_NEEDED_TEXT } from "./db-update.js";
import type { FirefliesScreenDeps } from "./fireflies-routes.js";
import { AppDeniedError, AppInputError, AppMissingFunctionError, type AppStore, type Row } from "./store.js";

/**
 * Who may use the signed-in screens.
 *
 *   settings screens (/setup/<screen>)  an active administrator, signed in
 *     through the admin application (second factor), exactly as /status and
 *     /setup require (setup/guard.ts);
 *   owner screens (/app/...)            any active person on this Engine,
 *     signed in through the Engine's own application.
 *
 * FAIL CLOSED: no sign-in settings, no assertion, a failed check or a
 * database that cannot answer all end in a refusal.
 */

export type ScreenDeps = {
  readonly mode: () => Promise<EngineMode>;
  readonly guard: GuardDeps;
  readonly store: AppStore;
  readonly csrf: Csrf;
  readonly now: () => number;
  /** The Fireflies webhook (0081). Absent: the Sources screens show no Connect Fireflies card. */
  readonly fireflies?: FirefliesScreenDeps;
};

export type Allowed = { readonly ok: true; readonly email: string; readonly access: AccessSettings; readonly who: Row | null };
export type Refused = { readonly ok: false; readonly response: Response };

async function signedInAccess(c: Context, deps: ScreenDeps, area: Area): Promise<AccessSettings | Refused> {
  let mode: EngineMode;
  try {
    mode = await deps.mode();
  } catch {
    return { ok: false, response: sendMessage(c, area, 503, "Unavailable", "The Engine's settings could not be read. Try again in a minute.") };
  }
  if (mode.kind !== "ready") {
    return {
      ok: false,
      response: sendMessage(c, area, 503, "Finish sign-in setup first", "This screen opens once Cloudflare sign-in is set up. Go to /setup."),
    };
  }
  return mode.access;
}

export async function requireAdmin(c: Context, deps: ScreenDeps): Promise<Allowed | Refused> {
  const access = await signedInAccess(c, deps, "setup");
  if ("ok" in access) return access;
  const who = await requireAdministrator(deps.guard, access, c.req.header("Cf-Access-Jwt-Assertion"));
  if (!who.ok) return { ok: false, response: sendMessage(c, "setup", who.status, who.title, who.message) };
  return { ok: true, email: who.email, access, who: null };
}

export async function requirePerson(c: Context, deps: ScreenDeps): Promise<Allowed | Refused> {
  const access = await signedInAccess(c, deps, "app");
  if ("ok" in access) return access;
  const assertion = c.req.header("Cf-Access-Jwt-Assertion");
  if (!assertion) {
    return { ok: false, response: sendMessage(c, "app", 401, "Sign in required", "Open this page through its Cloudflare sign-in link.") };
  }
  let email: string;
  try {
    email = (await deps.guard.verify(assertion, access.aud, access.teamDomain)).email;
    deps.guard.assertEmailAllowed(email);
  } catch (err) {
    const down = isMcpAppError(err) && err.code === "internal_error";
    return {
      ok: false,
      response: down
        ? sendMessage(c, "app", 503, "Sign-in check unavailable", "The sign-in could not be checked just now. Try again in a minute.")
        : sendMessage(c, "app", 401, "Sign in required", "Your sign-in was not accepted. Sign in again."),
    };
  }
  let who: Row | null;
  try {
    who = await deps.store.whoami(email);
  } catch {
    return { ok: false, response: sendMessage(c, "app", 503, "Unavailable", "The Engine's database did not answer. Try again in a minute.") };
  }
  if (!who) {
    return { ok: false, response: sendMessage(c, "app", 403, "No access", "Your account is not active on this Engine. Ask its owner.") };
  }
  return { ok: true, email, access, who };
}

export type Form = Readonly<Record<string, string>>;

/** The checks every form post passes before a field is read. */
export async function readForm(
  c: Context,
  deps: ScreenDeps,
  area: Area,
  email: string,
  scope: string,
): Promise<{ readonly ok: true; readonly form: Form } | Refused> {
  const refuse = (status: 403 | 415 | 400, text: string): Refused => ({
    ok: false,
    response: sendMessage(c, area, status, "Not accepted", text),
  });
  if (!sameSite(c)) return refuse(403, "Send this form from the page itself.");
  if (!isFormPost(c)) return refuse(415, "Send this form from the page itself.");
  let raw: Record<string, unknown>;
  try {
    raw = await c.req.parseBody();
  } catch {
    return refuse(400, "The form could not be read.");
  }
  if (!deps.csrf.check(email, scope, raw["csrf"])) {
    return refuse(403, "This form is out of date or did not come from this page. Open the page again.");
  }
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") form[k] = v;
  return { ok: true, form };
}

/** A database refusal as a page; anything unexpected becomes a plain 503. */
export function storeFailure(c: Context, area: Area, err: unknown): Response {
  if (err instanceof AppInputError) return sendMessage(c, area, 400, "Not saved", err.message);
  if (err instanceof AppDeniedError) return sendMessage(c, area, 403, "No access", "That is not yours to change.");
  if (err instanceof AppMissingFunctionError) return sendMessage(c, area, 503, "Database update needed", UPDATE_NEEDED_TEXT);
  return sendMessage(c, area, 503, "Unavailable", "The Engine's database did not answer. Try again in a minute.");
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
