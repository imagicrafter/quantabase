import { z } from "zod";
import type { Rule } from "./rules.js";

/**
 * Mail-contact suggestions (migration 0080, docs/source-rules.md
 * "Suggested from your mail").
 *
 * The owner's own Claude reads ONLY header metadata of their Gmail (the
 * plugin's suggest-rules skill), counts it on their machine and hands the
 * Engine counts per address and per domain: how often the owner sent to
 * them, how often they wrote, in how many threads, how many got a reply,
 * and when last. Never a name, subject, snippet, body or message id: the
 * schema refuses any other key. In Claude the skill asks the person a few
 * questions and marks what they picked (`chosen`); the rule screen starts
 * with exactly those boxes ticked. Saving them goes through the ordinary
 * rule save; Claude never makes a rule.
 */

const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Sent to this many times or more: the box starts ticked. */
export const STRONG_SENT = 3;

/** Common free-mail domains: a person there is a person, never a whole domain. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com",
  "zoho.com", "yandex.com", "yandex.ru", "fastmail.com", "hey.com", "tutanota.com", "qq.com", "163.com",
  "comcast.net", "att.net", "verizon.net", "sbcglobal.net",
]);

const BULK_LOCAL =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer[-_.]?daemon|postmaster|newsletters?|alerts?|digest|bounces?|automated|auto[-_.]?confirm)(?:[-_.+].*)?$|^bounce[-_.+]|^.*[-_.+]no[-_.]?reply$/;

export const isFreeMail = (domain: string): boolean => FREE_MAIL_DOMAINS.has(domain.toLowerCase());
export const isBulkAddress = (address: string): boolean => BULK_LOCAL.test(address.toLowerCase().split("@")[0] ?? "");

const count = z.number().int().min(0).max(1_000_000);
const lastSeen = z.string().max(64).nullable().optional();
// chosen: the person ticked it in Claude (true), left it (false); absent when they were not asked.
const counts = { sent_to: count, received_from: count, threads: count, replied: count, last_seen: lastSeen, chosen: z.boolean().optional() };

const addressIn = z
  .object({ address: z.string().trim().toLowerCase().max(254).regex(ADDRESS, "not an email address"), ...counts, free_mail: z.boolean().optional() })
  .strict();
const domainIn = z
  .object({ domain: z.string().trim().toLowerCase().max(253).regex(DOMAIN, "not a domain"), ...counts, people: count.optional() })
  .strict();

/** What `report_mail_contacts` takes: counts only. Any other key is refused. */
export const mailContactsSchema = z
  .object({
    account: z.string().trim().toLowerCase().email().max(254),
    days: z.number().int().min(1).max(365),
    messages_read: z.number().int().min(0).max(100_000),
    addresses: z.array(addressIn).max(500).default([]),
    domains: z.array(domainIn).max(300).default([]),
    // The script's own tally of what it left out; kept out of the database.
    dropped: z.record(z.string().max(40), count).optional(),
  })
  .strict();

export type MailContactsReport = z.infer<typeof mailContactsSchema>;

export type Suggestion = {
  readonly kind: "address" | "domain";
  readonly value: string;
  readonly sent_to: number;
  readonly received_from: number;
  readonly threads: number;
  readonly replied: number;
  readonly people: number;
  readonly free_mail: boolean;
  /** What the person picked in Claude; null when they made no choice. */
  readonly chosen: boolean | null;
  readonly last_seen: string | null;
};

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The report as database rows, minus the account itself, bulk senders and free-mail domains. */
export function contactsForDb(report: MailContactsReport): { readonly rows: readonly Suggestion[]; readonly dropped: number } {
  const people = report.addresses
    .filter((a) => a.address !== report.account && !isBulkAddress(a.address))
    .map((a): Suggestion => ({
      kind: "address", value: a.address, sent_to: a.sent_to, received_from: a.received_from, threads: a.threads,
      replied: a.replied, people: 1, free_mail: isFreeMail(a.address.split("@")[1] ?? ""), chosen: a.chosen ?? null,
      last_seen: isoOrNull(a.last_seen),
    }));
  const domains = report.domains
    .filter((d) => !isFreeMail(d.domain))
    .map((d): Suggestion => ({
      kind: "domain", value: d.domain, sent_to: d.sent_to, received_from: d.received_from, threads: d.threads,
      replied: d.replied, people: d.people ?? 0, free_mail: false, chosen: d.chosen ?? null, last_seen: isoOrNull(d.last_seen),
    }));
  const dropped = report.addresses.length - people.length + (report.domains.length - domains.length);
  return { rows: [...people, ...domains], dropped };
}

const suggestionRow = z.object({
  kind: z.enum(["address", "domain"]),
  value: z.string().min(3).max(254),
  sent_to: count,
  received_from: count,
  threads: count,
  replied: count,
  people: count.optional(),
  free_mail: z.boolean().optional(),
  chosen: z.boolean().nullable().optional(),
  last_seen: z.string().nullable().optional(),
});

/** Suggestions as the database returned them; anything malformed is dropped. */
export function parseSuggestions(value: unknown): readonly Suggestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) => {
    const ok = suggestionRow.safeParse(r);
    if (!ok.success) return [];
    const s = ok.data;
    return [{ ...s, people: s.people ?? 1, free_mail: s.free_mail ?? false, chosen: s.chosen ?? null, last_seen: s.last_seen ?? null }];
  });
}

export const isStrong = (s: Suggestion): boolean => s.sent_to >= STRONG_SENT;

/** Did the person make choices in Claude for this report? */
export const hasChoices = (list: readonly Suggestion[]): boolean => list.some((s) => s.chosen !== null);

/**
 * Which boxes start ticked: the person's own picks from Claude when they made
 * any, otherwise anyone they sent mail to STRONG_SENT or more times.
 */
export function startsTicked(list: readonly Suggestion[]): (s: Suggestion) => boolean {
  return hasChoices(list) ? (s) => s.chosen === true : isStrong;
}

/** The domain part a value stands for: "bob@acme.example" -> acme.example, "@acme.example" -> acme.example. */
const domainPart = (v: string): string => (v.includes("@") ? v.slice(v.indexOf("@") + 1) : v);
const under = (domain: string, parent: string): boolean => domain === parent || domain.endsWith(`.${parent}`);

/** Does one rule value (an address, or "@domain") cover the suggestion? */
function covers(ruleValue: string, s: Suggestion): boolean {
  const v = ruleValue.toLowerCase();
  if (v.startsWith("@")) return under(domainPart(s.value), v.slice(1));
  return s.kind === "address" && v === s.value;
}

/** The first rule (include or exclude) whose addresses already cover this suggestion, or null. */
export function ruleCovering(rules: readonly Rule[], s: Suggestion): Rule | null {
  const values = (r: Rule): readonly string[] =>
    [r.match.any_address, r.match.from, r.match.to, r.match.cc].flatMap((x) => x ?? []);
  return rules.find((r) => values(r).some((v) => covers(v, s))) ?? null;
}

/** Whole days since `value`, or null without a date. */
export function ageDays(value: unknown, now: Date): number | null {
  const iso = isoOrNull(value);
  return iso === null ? null : Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}
