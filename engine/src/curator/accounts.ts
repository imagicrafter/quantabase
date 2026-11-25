import type { DrawerDef, EntitySchema } from "../entities/templates.js";
import type { Plan, PlannedNewPage } from "./output.js";

/**
 * The Engine's own people: its owner and everyone with an account
 * (workspace.principals, curator_account_people, 0070). The wiki is written
 * from the owner's side, so none of them ever gets a person page: a proposed
 * person page whose key or name is one of theirs is left out, and links to
 * it go with it. Who they are comes from the database, never from code.
 */

export type AccountPerson = {
  readonly email: string | null;
  readonly name: string | null;
  /** The short name pages use for them (0077): "Ann". Absent or null: none known. */
  readonly pageName?: string | null;
};

/** The item's owner: their email and the name pages use for them, if known. */
export type OwnerName = { readonly email: string; readonly pageName: string | null };

const words = (s: string): string[] =>
  s.toLowerCase().replace(/^[a-z][a-z-]*:/, "").replace(/[^\p{L}\p{N}@.]+/gu, " ").replace(/[-_.]+/g, " ").trim().split(" ").filter((w) => w !== "");

/** A drawer that holds people (its pages are keyed or known by email). */
export function isPeopleDrawer(d: DrawerDef | undefined): boolean {
  return d !== undefined && (d.key_rule.kind === "email" || d.key_rule.identities === "emails");
}

/** The account people for an item: the database list plus the item's owner. */
export function accountPeople(listed: readonly AccountPerson[], ownerEmail: string | null): readonly AccountPerson[] {
  const owner = ownerEmail?.trim().toLowerCase() ?? "";
  const known = listed.some((p) => p.email?.trim().toLowerCase() === owner);
  return owner && !known ? [...listed, { email: owner, name: null }] : listed;
}

/** The item's owner among the account people, with their page name when one is set. */
export function ownerPerson(people: readonly AccountPerson[], ownerEmail: string | null): OwnerName | null {
  const email = ownerEmail?.trim().toLowerCase() ?? "";
  if (!email) return null;
  const found = people.find((p) => p.email?.trim().toLowerCase() === email);
  const pageName = found?.pageName?.trim() || null;
  return { email, pageName };
}

/** The account person a proposed page is about, or null. */
export function accountMatch(n: Pick<PlannedNewPage, "key" | "title">, people: readonly AccountPerson[]): AccountPerson | null {
  const key = n.key.trim().toLowerCase();
  const title = n.title.trim().toLowerCase();
  const nameWords = [words(n.key), words(n.title)];
  return people.find((p) => {
    const email = p.email?.trim().toLowerCase();
    if (email && (key === email || title === email || key.endsWith(`:${email}`))) return true;
    const name = p.name ? words(p.name) : [];
    // The whole name (every word of it), never a first name alone.
    return name.length >= 2 && nameWords.some((w) => name.every((x) => w.includes(x)) && w.length <= name.length + 1);
  }) ?? null;
}

/** The plan without person pages for account people, and one line per page left out. */
export function dropAccountPages(plan: Plan, people: readonly AccountPerson[], schema: EntitySchema): { readonly plan: Plan; readonly dropped: readonly string[] } {
  if (people.length === 0) return { plan, dropped: [] };
  const gone = new Set<string>();
  const dropped: string[] = [];
  const newPages = plan.newPages.filter((n) => {
    if (!isPeopleDrawer(schema.drawers.find((d) => d.id === n.drawer))) return true;
    if (!accountMatch(n, people)) return true;
    gone.add(n.key);
    dropped.push(`new page "${n.key}" left out: it is the Engine's owner or an account user`);
    return false;
  });
  if (gone.size === 0) return { plan, dropped };
  const unlink = <T extends { readonly related: readonly string[] }>(x: T): T => ({ ...x, related: x.related.filter((r) => !gone.has(r)) });
  return { plan: { ...plan, updates: plan.updates.map(unlink), newPages: newPages.map(unlink) }, dropped };
}
