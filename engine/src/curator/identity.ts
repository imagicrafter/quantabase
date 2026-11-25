import type { DrawerDef } from "../entities/templates.js";
import { domainOf } from "./keys.js";
import type { PageRow } from "./store.js";

/**
 * Identities: a person page keeps every address it is known by, an
 * organisation page every domain (the field the drawer's key_rule names,
 * `identities: emails | domains`). Key matching checks them all
 * (curator_candidates, 0067).
 *
 * The curator may add one to an existing page only when the item clearly ties
 * it to that page: the value is written in the item, the page's name is in
 * the item, and for an address the organisation is the same (the address is
 * at the page's organisation domain, or the item names that domain). It never
 * merges pages: a look-alike goes to the owner's "Possible duplicates" list.
 */

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN = /^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const MAX_IDENTITIES = 50;

const words = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

export function identityList(page: Pick<PageRow, "fields">, field: string): string[] {
  const v = page.fields[field];
  return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
}

export type Accepted = {
  readonly add: readonly string[];
  readonly refused: ReadonlyArray<{ readonly value: string; readonly why: string }>;
};

function problem(value: string, page: PageRow, drawer: DrawerDef, source: string, seen: readonly string[]): string | null {
  const field = drawer.key_rule.identities;
  if (!field) return "this drawer keeps no identities";
  if (field === "emails" && !EMAIL.test(value)) return "not an email address";
  if (field === "domains" && !DOMAIN.test(value)) return "not a domain";
  if (value === page.key || seen.includes(value)) return "already on the page";
  const text = source.toLowerCase();
  if (!text.includes(value)) return "not written in the item";
  // The name must be written out, not only spelled inside an address.
  if (!words(source.replace(/\S+@\S+/g, " ")).includes(words(page.title))) return "the page's name is not in the item";
  if (field === "emails") {
    const org = typeof page.fields["organisation"] === "string" ? page.fields["organisation"].toLowerCase() : "";
    if (!org) return "the page has no organisation to tie the address to";
    if (domainOf(value) !== org && !text.includes(org)) return "a different organisation";
  }
  return null;
}

/** Which proposed identities may be added to this page, and why the others may not. */
export function acceptedIdentities(values: readonly string[], page: PageRow, drawer: DrawerDef | undefined, source: string): Accepted {
  const add: string[] = [];
  const refused: Array<{ value: string; why: string }> = [];
  const existing = drawer?.key_rule.identities ? identityList(page, drawer.key_rule.identities) : [];
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    const why = drawer ? problem(value, page, drawer, source, [...existing, ...add]) : "unknown drawer";
    if (why) refused.push({ value, why });
    else add.push(value);
  }
  const room = Math.max(0, MAX_IDENTITIES - existing.length);
  return { add: add.slice(0, room), refused };
}

/** The page's fields with these identities added to its list (a new object). */
export function withIdentities(fields: Record<string, unknown>, field: string, add: readonly string[]): Record<string, unknown> {
  if (add.length === 0) return fields;
  const now = Array.isArray(fields[field]) ? (fields[field] as unknown[]).map(String) : [];
  return { ...fields, [field]: [...new Set([...now, ...add])] };
}
