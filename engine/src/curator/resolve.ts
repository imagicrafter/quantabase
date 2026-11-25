import { applyPatches, type Patch } from "../entities/sections.js";
import { alreadyHas } from "./apply.js";
import type { Plan, PlannedNewPage, PlannedUpdate } from "./output.js";
import { eventsSection, type EventsRule } from "./repair.js";
import type { PageRow } from "./store.js";

/**
 * A "create" on a key the owner already has in the item's topics is a patch.
 *
 * The model can only update pages it was shown, and the shortlist is matched
 * on the keys an item names (addresses, domains, meeting ids) plus a text
 * search. A page on a key the model makes up (a project or deal slug), or one
 * the search ranked out, is not shown, so the model proposes a new page and
 * the database refuses it ("you already have a page with this key").
 *
 * Before any save, every new page is looked up by its normalised key in the
 * item's own topic set (the only pages a curator save can collide with: a
 * page on the same key in another topic is a separate page and is allowed).
 * A hit becomes an update of that page: its fields and links, and each
 * proposed section as a patch (appended to a section of that name, or added
 * as a new section at the end). A hit that already lists this item was
 * written by an earlier, cut-short run and is dropped.
 */

export const normKey = (key: string): string => key.trim().toLowerCase();

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function headings(body: string): Array<{ level: number; name: string }> {
  return body.split("\n").flatMap((l) => {
    const m = HEADING.exec(l);
    return m ? [{ level: m[1]!.length, name: (m[2] ?? "").trim() }] : [];
  });
}

const BULLET = /^\s*[-*]\s+(.*)$/;

/** One proposed section as patches on the existing body: only patches that apply. */
function sectionPatches(body: string, section: PlannedNewPage["sections"][number], rule?: EventsRule): Patch[] {
  const text = section.text.trim();
  if (!text) return [];
  const hs = headings(body);
  const has = hs.some((h) => h.name.toLowerCase() === section.heading.trim().toLowerCase());
  // A section the page lacks goes into its events section when it has one,
  // never a second "Timeline" beside "Key Interactions".
  const events = has ? null : eventsSection(body, rule);
  if (events) return [{ op: "append-paragraph" as const, section: events, text }];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const candidates: Patch[] = has
    ? lines.every((l) => BULLET.test(l))
      ? lines.map((l) => ({ op: "append-bullet" as const, section: section.heading.trim(), text: BULLET.exec(l)![1]!.trim() }))
      : [{ op: "append-paragraph" as const, section: section.heading.trim(), text }]
    : (() => {
        const last = hs.filter((h) => h.level >= 2).at(-1) ?? hs[0];
        return last ? [{ op: "new-section-after" as const, after: last.name, heading: section.heading.trim(), text }] : [];
      })();
  return candidates;
}

/** Patches for all proposed sections, in order; a patch that does not apply is left out. */
export function sectionsAsPatches(body: string, sections: PlannedNewPage["sections"], rule?: EventsRule): Patch[] {
  const kept: Patch[] = [];
  let current = body;
  for (const s of sections) {
    for (const p of sectionPatches(current, s, rule)) {
      try {
        current = applyPatches(current, [p]);
        kept.push(p);
      } catch {
        // A section heading clash or a line the section rules refuse: skip it.
      }
    }
  }
  return kept;
}

/** A new page turned into an update of the existing page on its key. */
export function asUpdate(n: PlannedNewPage, page: PageRow, rule?: EventsRule): PlannedUpdate {
  return {
    key: page.key,
    patches: sectionsAsPatches(page.body, n.sections, rule),
    fields: { ...n.fields },
    related: n.related.filter((r) => normKey(r) !== normKey(page.key)),
  } as PlannedUpdate;
}

function mergeInto(u: PlannedUpdate, extra: PlannedUpdate): PlannedUpdate {
  return {
    ...u,
    patches: [...u.patches, ...extra.patches],
    fields: { ...extra.fields, ...u.fields },
    related: [...new Set([...u.related, ...extra.related])],
  };
}

export type Lookup = (key: string) => Promise<PageRow | null>;

export type Resolved = {
  readonly plan: Plan;
  /** The shortlist plus every page a create was matched to. */
  readonly shortlist: readonly PageRow[];
  /** Pages that already list this item (an earlier, cut-short run). */
  readonly done: readonly string[];
  /** Keys of creates that became patches. */
  readonly converted: readonly string[];
};

/**
 * Resolve every create against the owner's existing pages in the item's
 * topics: first the shortlist, then a lookup by key. Pure but for `lookup`.
 */
export async function resolveCreates(
  plan: Plan,
  shortlist: readonly PageRow[],
  itemId: string,
  lookup: Lookup,
  rule?: EventsRule,
): Promise<Resolved> {
  let updates = plan.updates.map((u) => {
    const page = shortlist.find((p) => normKey(p.key) === normKey(u.key));
    return page && page.key !== u.key ? { ...u, key: page.key } : u;
  });
  const newPages: PlannedNewPage[] = [];
  const pages: PageRow[] = [...shortlist];
  const done: string[] = [];
  const converted: string[] = [];
  for (const n of plan.newPages) {
    const page = pages.find((p) => normKey(p.key) === normKey(n.key)) ?? (await lookup(normKey(n.key)));
    if (!page) {
      newPages.push(n);
      continue;
    }
    if (!pages.includes(page)) pages.push(page);
    converted.push(normKey(n.key));
    if (alreadyHas(page, itemId)) {
      done.push(page.id);
      continue;
    }
    const extra = asUpdate(n, page, rule);
    const at = updates.findIndex((u) => u.key === page.key);
    updates = at === -1 ? [...updates, extra] : updates.map((u, i) => (i === at ? mergeInto(u, extra) : u));
  }
  // Links to a converted key now point at the existing page's key.
  const alias = new Map(pages.map((p) => [normKey(p.key), p.key] as const));
  const fixLinks = <T extends { readonly related: readonly string[]; readonly key: string }>(x: T): T => ({
    ...x,
    related: [...new Set(x.related.map((r) => alias.get(normKey(r)) ?? r))].filter((r) => r !== x.key),
  });
  return {
    plan: { ...plan, updates: updates.map(fixLinks), newPages: newPages.map(fixLinks) },
    shortlist: pages,
    done,
    converted,
  };
}
