import type { EntitySchema } from "../entities/templates.js";
import { isPeopleDrawer } from "./accounts.js";
import { SAME_SHARE, wordShare } from "./dedupe.js";
import type { PlannedNewPage } from "./output.js";
import { hasStrongKey } from "./quality.js";

/**
 * Update first. A proposed page that is really an existing page under
 * another name becomes a patch to that page (namematch.ts applies it). Pure,
 * cheap and run before the database name match:
 *
 *   name   same drawer, the same name (title, alias or key slug)
 *   words  same drawer, titles sharing at least SAME_SHARE of their words
 *          (the repeated-line matcher, dedupe.ts) and the same numbers, so
 *          "Phase 3" never absorbs "Phase 4"
 *   alias  any drawer but people: the new name is an existing page's alias
 *          or title, word for word (a project already filed as a concept)
 */

export type KnownPage = {
  readonly key: string;
  readonly drawer: string;
  readonly title: string;
  readonly aliases: readonly string[];
};

export type SameAs = { readonly key: string; readonly how: "name" | "words" | "alias" };

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const numbers = (s: string): string => [...new Set(s.match(/\d+/g) ?? [])].sort().join(",");
const slugOf = (key: string): string => /^[a-z][a-z-]*:(.+)$/.exec(key)?.[1]?.replace(/[-_.]+/g, " ") ?? "";

function namesOf(p: { readonly key: string; readonly title: string; readonly aliases?: readonly string[] }): string[] {
  return [p.title, ...(p.aliases ?? []), slugOf(p.key)].map(norm).filter((n) => n !== "");
}

const wordsIn = (s: string): number => norm(s).split(" ").filter((w) => w !== "").length;

/** The existing page this proposed page duplicates, or null. */
export function sameAsExisting(n: Pick<PlannedNewPage, "key" | "title" | "drawer">, pages: readonly KnownPage[], schema: EntitySchema): SameAs | null {
  const drawer = schema.drawers.find((d) => d.id === n.drawer);
  if (!drawer || hasStrongKey(drawer, n.key)) return null;
  const mine = namesOf(n);
  const others = pages.filter((p) => p.key !== n.key);
  const same = others.filter((p) => p.drawer === n.drawer);
  const byName = same.find((p) => namesOf(p).some((x) => mine.includes(x)));
  if (byName) return { key: byName.key, how: "name" };
  const byWords = same.find((p) => [p.title, ...p.aliases].some((t) =>
    wordsIn(t) >= 2 && wordsIn(n.title) >= 2 && numbers(t) === numbers(n.title) && wordShare(t, n.title) >= SAME_SHARE));
  if (byWords) return { key: byWords.key, how: "words" };
  if (isPeopleDrawer(drawer)) return null;
  const title = norm(n.title);
  const byAlias = others.find((p) => {
    const d = schema.drawers.find((x) => x.id === p.drawer);
    return !isPeopleDrawer(d) && wordsIn(title) >= 2 && [p.title, ...p.aliases].some((a) => norm(a) === title);
  });
  return byAlias ? { key: byAlias.key, how: "alias" } : null;
}
