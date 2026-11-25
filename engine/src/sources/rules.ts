import { z } from "zod";

/**
 * Source inclusion rules (migration 0063, docs/source-rules.md).
 *
 * The database is the control: it validates every rule list, evaluates the
 * rules for each item record_source_item hands over, sets the topic itself
 * and refuses to keep anything no rule includes. This module only:
 *   - describes the rule shape for the app's forms, and
 *   - turns the caller's rules into a NARROWED provider query, so an ingest
 *     run lists less. A query that lists too much is harmless (the database
 *     drops what no rule includes); it must never be the only check.
 */

export const RULE_SOURCES = ["gmail", "fireflies"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export const isRuleSource = (s: string): s is RuleSource => (RULE_SOURCES as readonly string[]).includes(s);

export const GMAIL_FIELDS = ["any_address", "from", "to", "cc", "labels"] as const;
export const FIREFLIES_FIELDS = ["participants", "channels"] as const;
export type AddressField = "any_address" | "from" | "to" | "cc" | "participants";
export type LabelField = "labels" | "channels";

export const fieldsFor = (source: RuleSource): readonly string[] =>
  source === "gmail" ? GMAIL_FIELDS : FIREFLIES_FIELDS;

export type LabelRef = { readonly id: string; readonly name?: string; readonly deleted?: boolean };

export type RuleMatch = Partial<Record<AddressField, readonly string[]>> & Partial<Record<LabelField, readonly LabelRef[]>>;

export type Rule = {
  readonly id?: string;
  readonly version?: number;
  readonly kind: "include" | "exclude";
  readonly name?: string;
  readonly match: RuleMatch;
  readonly topic?: string | null;
  readonly private?: boolean;
  readonly broken?: boolean;
};

const labelRef = z.object({ id: z.string().min(1).max(300), name: z.string().max(200).optional(), deleted: z.boolean().optional() });

/** The shape a rule takes on the way in; the database checks it again, fully. */
export const ruleSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    version: z.number().int().positive().optional(),
    kind: z.enum(["include", "exclude"]),
    name: z.string().max(80).optional(),
    match: z
      .object({
        any_address: z.array(z.string().max(254)).max(50).optional(),
        from: z.array(z.string().max(254)).max(50).optional(),
        to: z.array(z.string().max(254)).max(50).optional(),
        cc: z.array(z.string().max(254)).max(50).optional(),
        participants: z.array(z.string().max(254)).max(50).optional(),
        labels: z.array(labelRef).max(50).optional(),
        channels: z.array(labelRef).max(50).optional(),
      })
      .strict(),
    topic: z.string().max(40).nullable().optional(),
    private: z.boolean().optional(),
    broken: z.boolean().optional(),
  })
  .strict();

export const rulesSchema = z.array(ruleSchema).max(100);

/** Rules as the database returned them; anything malformed is dropped. */
export function parseRules(value: unknown): readonly Rule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) => {
    const ok = ruleSchema.safeParse(r);
    return ok.success ? [ok.data as Rule] : [];
  });
}

const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN = /^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** One address-or-domain value as the database stores it, or null. */
export function addressValue(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (ADDRESS.test(v)) return v;
  if (DOMAIN.test(v)) return `@${v.replace(/^@/, "")}`;
  return null;
}

/** Split a typed list ("a@b.com, @acme.com acme.org") into clean values; bad ones are returned apart. */
export function splitAddresses(text: string): { readonly values: readonly string[]; readonly bad: readonly string[] } {
  const parts = text.split(/[\s,;]+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const values = [...new Set(parts.map(addressValue).filter((v): v is string => v !== null))];
  const bad = parts.filter((p) => addressValue(p) === null);
  return { values, bad };
}

/** A copy of an object without some keys (never changes the one given). */
export function without<T extends object>(value: T, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;
}

// ── Gmail search ────────────────────────────────────────────────────────────

/**
 * Gmail's search form of a label name: lower case, spaces and slashes as
 * dashes ("Clients/Acme Inc" -> label:clients-acme-inc). Rules match by label
 * ID on the server; this form is only for the narrowed search text.
 */
export function gmailLabelTerm(name: string): string {
  const v = name.trim().toLowerCase().replace(/[\s/]+/g, "-").replace(/["(){}]/g, "");
  return `label:${v}`;
}

/** A value as a Gmail address term: "@acme.com" becomes "acme.com". */
const gmailAddr = (v: string) => (v.startsWith("@") ? v.slice(1) : v);

function anyOf(terms: readonly string[]): string {
  if (terms.length === 0) return "";
  return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
}

function gmailField(field: string, rule: Rule): string | null {
  const m = rule.match;
  switch (field) {
    case "any_address": {
      const vals = (m.any_address ?? []).map(gmailAddr);
      return vals.length ? anyOf(vals.flatMap((v) => [`from:${v}`, `to:${v}`, `cc:${v}`])) : null;
    }
    case "from":
    case "to":
    case "cc": {
      const vals = (m[field] ?? []).map(gmailAddr);
      return vals.length ? anyOf(vals.map((v) => `${field}:${v}`)) : null;
    }
    case "labels": {
      const labels = m.labels ?? [];
      return labels.length ? anyOf(labels.map((l) => gmailLabelTerm(l.name ?? l.id))) : null;
    }
    default:
      return null;
  }
}

/** One rule as a Gmail search clause: every field (AND), any value (OR). */
export function gmailClause(rule: Rule): string | null {
  const parts = GMAIL_FIELDS.map((f) => gmailField(f, rule)).filter((p): p is string => p !== null && p !== "");
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `(${parts.join(" ")})`;
}

const DAY_MS = 86_400_000;

/**
 * `after:YYYY/MM/DD`, one day before `since` (UTC). A date, not epoch seconds:
 * the claude.ai Gmail connector returns nothing for an epoch `after:`. The
 * extra day covers Gmail's own time zone; the Engine drops items it already has.
 */
export function gmailAfterTerm(sinceIso: string): string {
  const d = new Date(Date.parse(sinceIso) - DAY_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `after:${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

/** `newer_than:Nd` reaching back past `since` (whole days, plus one): the fallback when `after:` lists nothing. */
export function gmailNewerThanTerm(sinceIso: string, nowMs: number): string {
  const days = Math.max(1, Math.ceil((nowMs - Date.parse(sinceIso)) / DAY_MS) + 1);
  return `newer_than:${days}d`;
}

/**
 * The narrowed Gmail search for a run: (OR of the working include rules)
 * minus each exclude rule, then the time term (gmailAfterTerm or
 * gmailNewerThanTerm). Null when no include rule can match (nothing to list).
 */
export function gmailQuery(rules: readonly Rule[], timeTerm: string): string | null {
  const includes = rules
    .filter((r) => r.kind === "include" && r.broken !== true)
    .map(gmailClause)
    .filter((c): c is string => c !== null);
  if (includes.length === 0) return null;
  const excludes = rules
    .filter((r) => r.kind === "exclude")
    .map(gmailClause)
    .filter((c): c is string => c !== null)
    .map((c) => `-${c}`);
  const include = includes.length === 1 ? includes[0]! : `(${includes.join(" OR ")})`;
  return [include, ...excludes, timeTerm].join(" ");
}

// ── Fireflies ───────────────────────────────────────────────────────────────

export type FirefliesFilter = {
  /** Channel ids any working include rule names (list these channels' meetings). */
  readonly channel_ids: readonly string[];
  /** Participant addresses or "@domain" values any working include rule names. */
  readonly participants: readonly string[];
};

/** What a Fireflies run should list: meetings in these channels or with these participants. Null: nothing. */
export function firefliesFilter(rules: readonly Rule[]): FirefliesFilter | null {
  const working = rules.filter((r) => r.kind === "include" && r.broken !== true);
  if (working.length === 0) return null;
  return {
    channel_ids: [...new Set(working.flatMap((r) => (r.match.channels ?? []).map((c) => c.id)))],
    participants: [...new Set(working.flatMap((r) => r.match.participants ?? []))],
  };
}
