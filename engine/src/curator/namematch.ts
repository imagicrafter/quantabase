import { logger } from "../log/logger.js";
import { alreadyHas } from "./apply.js";
import type { CurateDeps } from "./curate.js";
import { eventsRule, type Plan, type PlannedNewPage, type PlannedUpdate } from "./output.js";
import { hasStrongKey, matchThreshold } from "./quality.js";
import { archivistThreshold } from "./tuning.js";
import { asUpdate, normKey, type Lookup } from "./resolve.js";
import { sameAsExisting, type KnownPage } from "./similar.js";
import type { ClaimedItem, PageRow } from "./store.js";

/**
 * Before a page without a strong key is made (a concept, a project, a
 * person known only by name: person:<name>), the owner's pages in the same
 * drawer and topic set are searched by normalised title and aliases, then by
 * embedding (curator_name_match, 0067). At or above the drawer's threshold
 * (templates: match_threshold) the new page is filed on the existing page
 * instead, and its title becomes an alias there. Every match score is logged.
 * First, the pages the writer was shown and the page index are checked by
 * name, alias and shared words (similar.ts): a hit there is filed the same way.
 */

export type NameMatched = {
  readonly plan: Plan;
  readonly shortlist: readonly PageRow[];
  /** Pages that already list this item (an earlier, cut-short run). */
  readonly done: readonly string[];
  readonly matched: number;
};

/** The names a proposed page answers to: its title and the name part of its key. */
export function namesOf(n: Pick<PlannedNewPage, "title" | "key">): string[] {
  const slug = /^[a-z][a-z-]*:(.+)$/.exec(n.key)?.[1]?.replace(/[-_.]+/g, " ");
  return [...new Set([n.title.trim(), ...(slug ? [slug] : [])].filter((s) => s !== ""))];
}

async function embedding(deps: CurateDeps, n: PlannedNewPage): Promise<number[] | null> {
  if (!deps.embed) return null;
  return deps.embed(`${n.title}. ${n.description ?? ""}`.trim()).catch(() => null);
}

function mergeUpdate(updates: readonly PlannedUpdate[], extra: PlannedUpdate): PlannedUpdate[] {
  const at = updates.findIndex((u) => u.key === extra.key);
  if (at === -1) return [...updates, extra];
  return updates.map((u, i) => (i !== at ? u : {
    ...u,
    patches: [...u.patches, ...extra.patches],
    fields: { ...extra.fields, ...u.fields },
    related: [...new Set([...u.related, ...extra.related])],
    aliases: [...new Set([...(u.aliases ?? []), ...(extra.aliases ?? [])])],
  }));
}

export async function fileByName(
  plan: Plan,
  shortlist: readonly PageRow[],
  item: ClaimedItem,
  deps: CurateDeps,
  lookup: Lookup,
  known: readonly KnownPage[] = [],
): Promise<NameMatched> {
  let updates: PlannedUpdate[] = [...plan.updates];
  const keep: PlannedNewPage[] = [];
  const pages: PageRow[] = [...shortlist];
  const done: string[] = [];
  const renamed = new Map<string, string>();
  for (const n of plan.newPages) {
    const drawer = deps.schema.drawers.find((d) => d.id === n.drawer);
    // Anchored drawers (a deal per organisation) are matched by their anchor
    // (consensus.ts preferOpen): a closed deal with the same name must not
    // absorb a new one.
    // Update first: an existing page under another name (similar.ts). Not
    // for drawers with one open page per anchor (deals): preferOpen decides.
    const near = drawer && !drawer.key_rule.anchor?.single_open ? sameAsExisting(n, [...pages, ...known], deps.schema) : null;
    if (!near && (!drawer || hasStrongKey(drawer, n.key) || drawer.key_rule.anchor)) {
      keep.push(n);
      continue;
    }
    const best = near ? { key: near.key, score: 1, how: near.how } : (await deps.store.nameMatch(item.id, n.drawer, namesOf(n), await embedding(deps, n)))[0];
    const threshold = archivistThreshold(matchThreshold(deps.schema, n.drawer), deps.tuning?.archivistBar);
    const hit = best !== undefined && best.score >= threshold;
    logger.info({ item: item.id, drawer: n.drawer, score: best?.score ?? 0, how: best?.how ?? "none", threshold, matched: hit },
      "curator: name match before create");
    const page = hit ? pages.find((p) => normKey(p.key) === normKey(best.key)) ?? (await lookup(normKey(best.key)).catch(() => null)) : null;
    if (!page) {
      keep.push(n);
      continue;
    }
    if (!pages.includes(page)) pages.push(page);
    renamed.set(normKey(n.key), page.key);
    if (alreadyHas(page, item.id)) {
      done.push(page.id);
      continue;
    }
    updates = mergeUpdate(updates, { ...asUpdate(n, page, eventsRule(deps.schema)), aliases: [n.title] });
  }
  const fix = <T extends { readonly related: readonly string[]; readonly key: string }>(x: T): T => ({
    ...x,
    related: [...new Set(x.related.map((r) => renamed.get(normKey(r)) ?? r))].filter((r) => r !== x.key),
  });
  return {
    plan: { ...plan, updates: updates.map(fix), newPages: keep.map(fix) },
    shortlist: pages,
    done,
    matched: renamed.size,
  };
}
