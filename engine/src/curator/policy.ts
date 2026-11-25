import { applyPatches } from "../entities/sections.js";
import { handSetFields } from "../entities/hand-set.js";
import type { EntitySchema } from "../entities/templates.js";
import type { Candidate, PlannedNewPage, PlannedUpdate } from "./output.js";

/**
 * The curator applies its changes on its own: new pages in any drawer (deals,
 * offers, programs and properties included), stage and value changes, long
 * additions. Every save is a version in the page's history, so any of it
 * can be undone there.
 *
 * It waits for the owner's yes ONLY in these extreme cases:
 *   (a) the item was held by the steering screen as possible AI steering and
 *       a person released it
 *   (b) the change would delete or replace a large part of an existing page:
 *       LARGE_REMOVAL_SHARE or more of its text, or any whole section
 *   (c) a field change would overwrite a value a person set by hand in the
 *       app (entities/hand-set.ts) with a different one
 * An owner may still opt a drawer in to more caution in a template
 * (update_rules.needs_yes, curator.new_page: needs_yes); the shipped
 * templates do not. A change that waits is queued whole: nothing of it is
 * applied until the owner says yes.
 */

/** Share of an existing page's text whose removal or replacement needs a yes. */
export const LARGE_REMOVAL_SHARE = 0.4;

export type Verdict = { readonly apply: true } | { readonly apply: false; readonly reasons: readonly string[] };

const RELEASED = "item was held by the steering screen";

function verdict(reasons: readonly string[]): Verdict {
  return reasons.length === 0 ? { apply: true } : { apply: false, reasons };
}

const headings = (body: string): string[] =>
  body.split("\n").filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#{1,6}\s+/, "").trim());

/** How much of `before` is gone from `after`: share of its characters, and whole sections lost. */
export function removal(before: string, after: string): { share: number; lostSections: string[] } {
  const left = new Map<string, number>();
  for (const l of after.split("\n")) left.set(l, (left.get(l) ?? 0) + 1);
  let removed = 0;
  for (const l of before.split("\n")) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else removed += l.length;
  }
  const total = before.replace(/\n/g, "").length;
  const kept = new Set(headings(after));
  return { share: total === 0 ? 0 : removed / total, lostSections: headings(before).filter((h) => !kept.has(h)) };
}

function removalReasons(u: PlannedUpdate, page: Candidate, share: number): string[] {
  let after: string;
  try {
    after = applyPatches(page.body, u.patches);
  } catch {
    return [];
  }
  const r = removal(page.body, after);
  return [
    ...(r.share >= share ? [`would remove ${Math.round(share * 100)}% or more of the page`] : []),
    ...r.lostSections.map((h) => `would remove the section "${h}"`),
  ];
}

export function judgeUpdate(
  u: PlannedUpdate,
  page: Candidate & { readonly verified?: readonly unknown[] },
  schema: EntitySchema,
  released: boolean,
  /** The removal share that needs a yes (tuning.ts); never above LARGE_REMOVAL_SHARE. */
  share: number = LARGE_REMOVAL_SHARE,
): Verdict {
  const drawer = schema.drawers.find((d) => d.id === page.drawer);
  const optIn = new Set(drawer?.update_rules.needs_yes ?? []);
  const handSet = handSetFields(page.verified);
  const changed = Object.entries(u.fields).filter(([n, v]) => page.fields[n] !== v);
  const fieldReasons = changed.flatMap(([n, v]) => [
    ...(handSet.has(n) && JSON.stringify(handSet.get(n) ?? null) !== JSON.stringify(v) ? [`${n} was set by hand`] : []),
    ...(optIn.has(n) ? [`${n} change needs a yes`] : []),
  ]);
  return verdict([...fieldReasons, ...removalReasons(u, page, Math.min(share, LARGE_REMOVAL_SHARE)), ...(released ? [RELEASED] : [])]);
}

export function judgeNewPage(n: PlannedNewPage, schema: EntitySchema, released: boolean): Verdict {
  const drawer = schema.drawers.find((d) => d.id === n.drawer);
  return verdict([
    ...(drawer?.curator?.new_page === "needs_yes" ? [`new page in ${n.drawer}`] : []),
    ...(released ? [RELEASED] : []),
  ]);
}
