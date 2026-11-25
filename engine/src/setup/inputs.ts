import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isSharedDomain } from "./shared-domains.js";

export { isSharedDomain } from "./shared-domains.js";

/**
 * What the person types on the setup page, validated, and the signature that
 * carries it from the preview step to the apply step unchanged.
 *
 * Every value here ends up in a Cloudflare sign-in rule or a DNS record, so
 * the rules are strict: lower-case ASCII hostnames and emails only, short
 * lists, nothing that is not plainly a name.
 */

export const LEVELS = ["owner", "people", "domain"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * How long a sign-in to the Engine (and Claude's connector) lasts. Offered on
 * the form; 1 year by default (the owner's decision, 2026-11-20). The admin
 * pages (/status, /setup) are a separate application, always 12h plus a
 * second factor (plan.ts).
 */
export const SESSIONS = ["24h", "720h", "8760h"] as const;
export type SessionLength = (typeof SESSIONS)[number];
export const DEFAULT_SESSION: SessionLength = "8760h";
export const SESSION_NAMES: Readonly<Record<SessionLength, string>> = {
  "24h": "1 day",
  "720h": "30 days",
  "8760h": "1 year",
};

/**
 * Both lengths in one sentence, for the Sign-in and Health screens. The
 * connector's OAuth approval is set from the same setting (plan.ts). A setup
 * that ran before the length was stored says so instead of guessing.
 */
export function sessionSentence(session: string | null | undefined): string {
  const name = session ? SESSION_NAMES[session as SessionLength] : undefined;
  if (!name) {
    return "Sign-in length not recorded (sign-in was set up before it was stored). Run the sign-in setup again to set both to the same length; the default is 1 year.";
  }
  return `You stay signed in for ${name}; Claude's connector re-approves every ${name}.`;
}

export const MAX_EMAILS = 50;
export const MAX_DOMAINS = 10;
/** A preview is good for this long; after that the form must be sent again. */
export const SIGNED_INPUTS_TTL_MS = 30 * 60 * 1000;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,63}$`);
const LOCAL_PART = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*$/;

export function isHostname(value: string): boolean {
  return value.length <= 253 && HOSTNAME.test(value);
}

export function isEmail(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.lastIndexOf("@");
  if (at < 1) return false;
  const local = value.slice(0, at);
  return (
    local.length <= 64 &&
    LOCAL_PART.test(local) &&
    isHostname(value.slice(at + 1))
  );
}

const Hostname = z.string().refine(isHostname, "is not a plain hostname");
const Email = z.string().refine(isEmail, "is not a plain email address");

/** The validated inputs. This same schema re-checks them at the apply step. */
export const SetupInputsSchema = z
  .object({
    host: Hostname,
    origin: Hostname,
    level: z.enum(LEVELS),
    ownerEmail: Email,
    emails: z.array(Email).max(MAX_EMAILS),
    domains: z.array(Hostname).max(MAX_DOMAINS),
    /** Take over a DNS record or application that is already there. */
    replaceExisting: z.boolean(),
    /** The main sign-in length; absent means DEFAULT_SESSION. */
    session: z.enum(SESSIONS).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const problem = crossFieldProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export type SetupInputs = z.infer<typeof SetupInputsSchema>;

type Fields = {
  readonly host: string;
  readonly origin: string;
  readonly level: Level;
  readonly ownerEmail: string;
  readonly emails: readonly string[];
  readonly domains: readonly string[];
};

function crossFieldProblem(v: Fields): string | null {
  if (v.host === v.origin)
    return "The hostname must be different from the address this page is on.";
  if (v.level === "people" && v.emails.length === 0)
    return "Add at least one other person, or choose Owner only.";
  if (v.level !== "people" && v.emails.length > 0)
    return "A list of people is only used with the Named people level.";
  if (v.level === "domain" && v.domains.length === 0)
    return "Add at least one company email domain.";
  if (v.level !== "domain" && v.domains.length > 0)
    return "A list of domains is only used with the Company domain level.";
  const open = v.domains.find(isSharedDomain);
  if (open)
    return `${open} is a public email provider or an ending many organisations share. Anyone can get an address there, so it cannot be used as a company domain.`;
  return null;
}

/** What the form sends back so a person does not retype it after an error. */
export type FormValues = {
  readonly host: string;
  readonly origin: string;
  readonly level: string;
  readonly ownerEmail: string;
  readonly emails: string;
  readonly domains: string;
  readonly replace: boolean;
  /** The chosen sign-in length; "" means the default. */
  readonly session?: string;
};

/** What the page already knows, which the form may not override. */
export type FixedValues = {
  /** Owner email from the applied config, or null when there is none. */
  readonly owner: string | null;
  /**
   * The app's own address. In setup mode this is the hostname the page was
   * reached on; the form's value is then ignored, so a typing mistake cannot
   * send the new hostname to someone else's server.
   */
  readonly origin: string | null;
};

export type ParsedForm =
  | { readonly ok: true; readonly inputs: SetupInputs }
  | { readonly ok: false; readonly errors: readonly string[] };

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max).trim() : "";

/** The form's fields as plain trimmed strings, capped in length. */
export function formValues(
  form: Readonly<Record<string, unknown>>,
): FormValues {
  return {
    host: text(form["host"], 300).toLowerCase(),
    origin: text(form["origin"], 300).toLowerCase(),
    level: text(form["level"], 20),
    ownerEmail: text(form["owner_email"], 300).toLowerCase(),
    emails: text(form["emails"], 8000),
    domains: text(form["domains"], 4000),
    replace: form["replace"] === "yes",
    session: text(form["session"], 10),
  };
}

/**
 * The values to put back into the form after an error. Only values that are
 * valid for their field are given back; anything else comes back blank. So a
 * secret pasted into the wrong box (the setup code, the Cloudflare token) is
 * never written into a page: neither is a valid hostname or email.
 */
export function echoableValues(v: FormValues): FormValues {
  const keep = (items: string, valid: (item: string) => boolean) =>
    splitList(items).filter(valid).join("\n");
  return {
    host: isHostname(v.host) ? v.host : "",
    origin: isHostname(v.origin) ? v.origin : "",
    level: LEVELS.includes(v.level as Level) ? v.level : "",
    ownerEmail: isEmail(v.ownerEmail) ? v.ownerEmail : "",
    emails: keep(v.emails, isEmail),
    domains: keep(v.domains, isHostname),
    replace: v.replace,
    session: SESSIONS.includes(v.session as SessionLength) ? v.session : "",
  };
}

/** Split a typed list on commas, semicolons and white space; drop repeats. */
function splitList(value: string): readonly string[] {
  const items = value
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((item) => item.length > 0);
  return [...new Set(items)].sort();
}

function listProblems(v: FormValues, level: string): readonly string[] {
  const emails = level === "people" ? splitList(v.emails) : [];
  const domains = level === "domain" ? splitList(v.domains) : [];
  const badEmails = emails.filter((e) => !isEmail(e)).length;
  const badDomains = domains.filter((d) => !isHostname(d)).length;
  return [
    ...(emails.length > MAX_EMAILS
      ? [`List at most ${MAX_EMAILS} people.`]
      : []),
    ...(domains.length > MAX_DOMAINS
      ? [`List at most ${MAX_DOMAINS} domains.`]
      : []),
    ...(badEmails > 0
      ? [`${badEmails} of the email addresses are not valid.`]
      : []),
    ...(badDomains > 0
      ? [
          `${badDomains} of the domains are not valid. Write them like example.com.`,
        ]
      : []),
  ];
}

function fieldProblems(v: FormValues, owner: string): readonly string[] {
  return [
    ...(isHostname(v.host)
      ? []
      : ["The hostname is not valid. Write it like engine.example.com."]),
    ...(isHostname(v.origin)
      ? []
      : [
          "The app's own address is not valid. Open this page on the address your hosting gave the app.",
        ]),
    ...(LEVELS.includes(v.level as Level) ? [] : ["Choose an access level."]),
    ...(isEmail(owner) ? [] : ["The owner email is not valid."]),
    ...(!v.session || SESSIONS.includes(v.session as SessionLength)
      ? []
      : ["Choose a sign-in length from the list."]),
    ...listProblems(v, v.level),
  ];
}

/**
 * Validate the form. Whatever is in `fixed` wins over what the form says.
 */
export function parseSetupForm(
  form: Readonly<Record<string, unknown>>,
  fixed: FixedValues,
): ParsedForm {
  const typed = formValues(form);
  const v =
    fixed.origin === null
      ? typed
      : { ...typed, origin: fixed.origin.trim().toLowerCase() };
  const owner = (fixed.owner ?? v.ownerEmail).trim().toLowerCase();
  const problems = fieldProblems(v, owner);
  if (problems.length > 0) return { ok: false, errors: problems };

  const level = v.level as Level;
  const candidate = {
    host: v.host,
    origin: v.origin,
    level,
    ownerEmail: owner,
    emails:
      level === "people" ? splitList(v.emails).filter((e) => e !== owner) : [],
    domains: level === "domain" ? [...splitList(v.domains)] : [],
    replaceExisting: v.replace,
    session: (v.session || DEFAULT_SESSION) as SessionLength,
  };
  const parsed = SetupInputsSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, inputs: parsed.data }
    : { ok: false, errors: parsed.error.issues.map((i) => i.message) };
}

// ── signing ─────────────────────────────────────────────────────────────────

export type SignedInputs = {
  readonly payload: string;
  readonly signature: string;
};

export type OpenedInputs =
  | { readonly ok: true; readonly inputs: SetupInputs }
  | { readonly ok: false; readonly reason: "tampered" | "expired" };

const Envelope = z
  .object({
    v: z.literal(1),
    exp: z.number().int().positive(),
    inputs: SetupInputsSchema,
  })
  .strict();

const MAX_PAYLOAD_CHARS = 16_000;

/** A signing key that is not the setup code itself, but cannot exist without it. */
function signingKey(setupCode: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", setupCode, "kb-engine-setup", "signed-inputs-v1", 32),
  );
}

function mac(payload: string, setupCode: string): Buffer {
  return createHmac("sha256", signingKey(setupCode)).update(payload).digest();
}

export function signInputs(
  inputs: SetupInputs,
  setupCode: string,
  now: number,
): SignedInputs {
  const envelope = { v: 1, exp: now + SIGNED_INPUTS_TTL_MS, inputs };
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString(
    "base64url",
  );
  return { payload, signature: mac(payload, setupCode).toString("hex") };
}

/**
 * Check the signature, then validate the contents all over again. Anything
 * that does not check out is "tampered"; nothing about why is given away.
 */
export function openSignedInputs(
  payload: unknown,
  signature: unknown,
  setupCode: string,
  now: number,
): OpenedInputs {
  const tampered = { ok: false, reason: "tampered" } as const;
  if (typeof payload !== "string" || typeof signature !== "string")
    return tampered;
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS)
    return tampered;
  if (!/^[0-9a-f]{64}$/.test(signature)) return tampered;

  const given = Buffer.from(signature, "hex");
  if (!timingSafeEqual(given, mac(payload, setupCode))) return tampered;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return tampered;
  }
  const envelope = Envelope.safeParse(decoded);
  if (!envelope.success) return tampered;
  if (envelope.data.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, inputs: envelope.data.inputs };
}
