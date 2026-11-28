import { DEFAULT_SESSION, SESSION_NAMES, type Level, type SessionLength, type SetupInputs } from "./inputs.js";
import type { JsonObject } from "./merge.js";

/**
 * Inputs in, an ordered list of changes out. Pure: no network, no clock.
 *
 * The same plan is shown to the person as a preview and then carried out by
 * apply.ts, so what they read is what gets done.
 */

/** Where Claude sends people back to after they sign in. */
export const CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

/** Second factors a browser can use. */
export const SECOND_FACTORS = ["totp", "biometrics", "security_key"] as const;

export type AccessRule =
  | { readonly email: { readonly email: string } }
  | { readonly email_domain: { readonly domain: string } }
  // Only in the timer's bypass rule, which lets nobody sign in: it skips sign-in.
  | { readonly everyone: Readonly<Record<string, never>> };

type StepBase = {
  /** What a person reads in the preview and the result. */
  readonly title: string;
  readonly lines: readonly string[];
};

export type OrganizationStep = StepBase & {
  readonly id: "organization";
  readonly kind: "organization";
  readonly authenticators: readonly string[];
  readonly sessionDuration: string;
};

export type LoginMethodStep = StepBase & {
  readonly id: "login_method";
  readonly kind: "login_method";
};

export type DnsStep = StepBase & {
  readonly id: "dns";
  readonly kind: "dns";
  readonly name: string;
  readonly target: string;
  /** Repoint a record that setup did not make and that points elsewhere. */
  readonly replaceExisting: boolean;
};

export type PolicyStep = StepBase & {
  readonly id: "engine_policy" | "admin_policy" | "tick_policy" | "hooks_policy";
  readonly kind: "policy";
  readonly name: string;
  /** "bypass" only for the curator timer's path. Default "allow". */
  readonly decision?: "allow" | "bypass";
  readonly include: readonly AccessRule[];
  /** Written on the rule itself, so a rule cannot stretch a session. */
  readonly sessionDuration: string;
};

export type ApplicationStep = StepBase & {
  readonly id: "engine_app" | "admin_app" | "tick_app" | "hooks_app";
  readonly kind: "application";
  readonly policy: PolicyStep["id"];
  /** The hostname (and path) that identifies the application. */
  readonly domain: string;
  readonly secondFactor: boolean;
  /** Take over an application for this address that setup did not make. */
  readonly replaceExisting: boolean;
  /** The fields this application must have. Ids are filled in at apply time. */
  readonly body: JsonObject;
};

export type PlanStep =
  OrganizationStep | LoginMethodStep | DnsStep | PolicyStep | ApplicationStep;

export type Plan = {
  readonly host: string;
  readonly level: Level;
  /** The main sign-in length, also the connector's OAuth grant length. */
  readonly session: SessionLength;
  readonly connectorUrl: string;
  readonly steps: readonly PlanStep[];
};

/** The timer bypass app's own (unused) session length. */
const ENGINE_SESSION = "24h";
const ADMIN_SESSION = "12h";

/** The main sign-in length: the one chosen on the form, else 1 year. */
const mainSession = (inputs: SetupInputs): SessionLength => inputs.session ?? DEFAULT_SESSION;

const takeoverLine = (inputs: SetupInputs): string =>
  inputs.replaceExisting
    ? "If Cloudflare already has an application for this address, it is taken over and rewritten."
    : "If Cloudflare already has an application for this address that setup did not make, setup stops and changes nothing.";

const emailRule = (email: string): AccessRule => ({ email: { email } });
const domainRule = (domain: string): AccessRule => ({
  email_domain: { domain },
});

/** Who may sign in to the connector. The owner is always on the list. */
export function signInRules(inputs: SetupInputs): readonly AccessRule[] {
  const owner = emailRule(inputs.ownerEmail);
  if (inputs.level === "owner") return [owner];
  if (inputs.level === "people")
    return [owner, ...inputs.emails.map(emailRule)];
  return [owner, ...inputs.domains.map(domainRule)];
}

function whoLine(inputs: SetupInputs): string {
  if (inputs.level === "owner") return `Only ${inputs.ownerEmail} may sign in.`;
  if (inputs.level === "people")
    return `These people may sign in: ${[inputs.ownerEmail, ...inputs.emails].join(", ")}.`;
  return `Anyone with an email address at ${inputs.domains.join(", ")} may sign in, and so may ${inputs.ownerEmail}.`;
}

function organizationStep(): OrganizationStep {
  return {
    id: "organization",
    kind: "organization",
    title: "Turn on second-factor sign-in for the account",
    lines: [
      "Reads your Zero Trust team name.",
      "Switches on Cloudflare's own second factor (authenticator app, fingerprint or face, security key) for the account, so single pages can ask for it.",
      "It is not made a rule for all your other Cloudflare applications.",
    ],
    authenticators: SECOND_FACTORS,
    sessionDuration: "24h",
  };
}

function loginMethodStep(): LoginMethodStep {
  return {
    id: "login_method",
    kind: "login_method",
    title: "Make sure one-time PIN sign-in exists",
    lines: [
      "People sign in with a code Cloudflare emails to them. Adds that sign-in method if the account does not have it.",
    ],
  };
}

function dnsStep(inputs: SetupInputs): DnsStep {
  return {
    id: "dns",
    kind: "dns",
    title: `Point ${inputs.host} at this app`,
    lines: [
      `DNS record: CNAME ${inputs.host} -> ${inputs.origin}, proxied through Cloudflare.`,
      inputs.replaceExisting
        ? "If that name already points somewhere else, it is repointed here."
        : "If that name already points somewhere else, setup stops and changes nothing.",
    ],
    name: inputs.host,
    target: inputs.origin,
    replaceExisting: inputs.replaceExisting,
  };
}

function enginePolicy(inputs: SetupInputs): PolicyStep {
  return {
    id: "engine_policy",
    kind: "policy",
    title: "Set who may sign in",
    lines: [
      whoLine(inputs),
      ...(inputs.level === "domain"
        ? [
            "Anyone who can receive email at those domains can sign in. Use only domains your company controls.",
          ]
        : []),
      "If this rule already exists, it is rewritten to say exactly this.",
    ],
    name: `KB Engine sign-in: ${inputs.host}`,
    include: signInRules(inputs),
    sessionDuration: mainSession(inputs),
  };
}

function engineApp(inputs: SetupInputs): ApplicationStep {
  return {
    id: "engine_app",
    kind: "application",
    title: `Put Cloudflare sign-in in front of ${inputs.host}`,
    lines: [
      `Application for ${inputs.host} (every path), sign-in by one-time PIN, sessions last ${SESSION_NAMES[mainSession(inputs)]}.`,
      `Managed OAuth is switched on, so Claude can connect. Claude's connector re-approves every ${SESSION_NAMES[mainSession(inputs)]}, the same as a sign-in.`,
      `Allowed redirect addresses: ${CLAUDE_REDIRECT_URIS.join(", ")}, plus apps on this computer (localhost and loopback).`,
      "Any other sign-in rule attached to this application is detached.",
      takeoverLine(inputs),
    ],
    policy: "engine_policy",
    domain: inputs.host,
    secondFactor: false,
    replaceExisting: inputs.replaceExisting,
    body: {
      name: `KB Engine: ${inputs.host}`,
      type: "self_hosted",
      domain: inputs.host,
      destinations: [{ type: "public", uri: inputs.host }],
      session_duration: mainSession(inputs),
      app_launcher_visible: false,
      oauth_configuration: {
        enabled: true,
        dynamic_client_registration: {
          enabled: true,
          allow_any_on_localhost: true,
          allow_any_on_loopback: true,
          allowed_uris: [...CLAUDE_REDIRECT_URIS],
        },
        // The connector's approval lasts as long as a sign-in (the owner's decision,
        // 2026-11-20): the same setting, 1 year by default.
        grant: { access_token_lifetime: "15m", session_duration: mainSession(inputs) },
      },
    },
  };
}

function adminPolicy(inputs: SetupInputs): PolicyStep {
  return {
    id: "admin_policy",
    kind: "policy",
    title: "Set who may open the status and setup pages",
    lines: [`Only ${inputs.ownerEmail}.`],
    name: `KB Engine administrators: ${inputs.host}`,
    include: [emailRule(inputs.ownerEmail)],
    sessionDuration: ADMIN_SESSION,
  };
}

function adminApp(inputs: SetupInputs): ApplicationStep {
  const status = `${inputs.host}/status`;
  const setup = `${inputs.host}/setup`;
  return {
    id: "admin_app",
    kind: "application",
    title: "Guard the status and setup pages with a second factor",
    lines: [
      `A second application for ${status} and ${setup}.`,
      "Sign-in by one-time PIN and then a second factor, every 12 hours.",
      takeoverLine(inputs),
    ],
    policy: "admin_policy",
    domain: status,
    secondFactor: true,
    replaceExisting: inputs.replaceExisting,
    body: {
      name: `KB Engine admin pages: ${inputs.host}`,
      type: "self_hosted",
      domain: status,
      destinations: [
        { type: "public", uri: status },
        { type: "public", uri: setup },
      ],
      session_duration: ADMIN_SESSION,
      app_launcher_visible: false,
      mfa_config: {
        mfa_disabled: false,
        allowed_authenticators: [...SECOND_FACTORS],
        session_duration: ADMIN_SESSION,
      },
    },
  };
}

/** The path Supabase cron pokes (curator/route.ts TICK_PATH). */
export const TICK_PATH = "/internal/curator/tick";

/**
 * The curator timer's path skips Cloudflare sign-in: Supabase cron cannot
 * sign in. The path is guarded by the timer secret instead (checked against
 * Supabase Vault on every poke), and answers POST only.
 */
function tickPolicy(inputs: SetupInputs): PolicyStep {
  return {
    id: "tick_policy",
    kind: "policy",
    title: "Let the curator timer through",
    lines: [
      `Skips sign-in for ${inputs.host}${TICK_PATH} only.`,
      "That path is guarded by the timer secret, which lives in Supabase Vault.",
    ],
    name: `KB Engine timer bypass: ${inputs.host}`,
    decision: "bypass",
    include: [{ everyone: {} }],
    sessionDuration: ENGINE_SESSION,
  };
}

function tickApp(inputs: SetupInputs): ApplicationStep {
  const path = `${inputs.host}${TICK_PATH}`;
  return {
    id: "tick_app",
    kind: "application",
    title: "Let Supabase cron reach the curator timer",
    lines: [`An application for ${path} with the bypass rule above.`, takeoverLine(inputs)],
    policy: "tick_policy",
    domain: path,
    secondFactor: false,
    replaceExisting: inputs.replaceExisting,
    body: {
      name: `KB Engine timer: ${inputs.host}`,
      type: "self_hosted",
      domain: path,
      destinations: [{ type: "public", uri: path }],
      session_duration: ENGINE_SESSION,
      app_launcher_visible: false,
    },
  };
}

/** Where Fireflies posts finished meetings (fireflies/route.ts HOOK_PATH). */
export const HOOKS_PATH = "/hooks/fireflies";

/**
 * The Fireflies webhook path skips Cloudflare sign-in: Fireflies cannot sign
 * in. Each delivery is checked against the HMAC signature under that
 * account's own secret (Supabase Vault) instead, and the path answers POST
 * only. The bypass covers this one path and nothing above it.
 */
function hooksPolicy(inputs: SetupInputs): PolicyStep {
  return {
    id: "hooks_policy",
    kind: "policy",
    title: "Let Fireflies deliver meetings",
    lines: [
      `Skips sign-in for ${inputs.host}${HOOKS_PATH} only.`,
      "Every delivery there must carry a signature made with that account's own signing secret, which lives in Supabase Vault.",
    ],
    name: `KB Engine Fireflies webhook bypass: ${inputs.host}`,
    decision: "bypass",
    include: [{ everyone: {} }],
    sessionDuration: ENGINE_SESSION,
  };
}

function hooksApp(inputs: SetupInputs): ApplicationStep {
  const path = `${inputs.host}${HOOKS_PATH}`;
  return {
    id: "hooks_app",
    kind: "application",
    title: "Let Fireflies reach the meeting webhook",
    lines: [`An application for ${path} with the bypass rule above.`, takeoverLine(inputs)],
    policy: "hooks_policy",
    domain: path,
    secondFactor: false,
    replaceExisting: inputs.replaceExisting,
    body: {
      name: `KB Engine Fireflies webhook: ${inputs.host}`,
      type: "self_hosted",
      domain: path,
      destinations: [{ type: "public", uri: path }],
      session_duration: ENGINE_SESSION,
      app_launcher_visible: false,
    },
  };
}

/** The ordered list of changes for these inputs. Rules come before the apps that use them. */
export function buildPlan(inputs: SetupInputs): Plan {
  return {
    host: inputs.host,
    level: inputs.level,
    session: mainSession(inputs),
    connectorUrl: `https://${inputs.host}/mcp`,
    steps: [
      organizationStep(),
      loginMethodStep(),
      dnsStep(inputs),
      enginePolicy(inputs),
      engineApp(inputs),
      adminPolicy(inputs),
      adminApp(inputs),
      tickPolicy(inputs),
      tickApp(inputs),
      hooksPolicy(inputs),
      hooksApp(inputs),
    ],
  };
}
