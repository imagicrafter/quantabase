import { inline } from "./guard.js";

/**
 * The page index the curator reads before deciding (like a person reading
 * the wiki's index.md first): one short line per page the owner has in the
 * item's topic set, ranked by the database (key matches, then words and
 * embedding: curator_page_index, 0067), cut to a token budget. Pages already
 * shown in full on the shortlist are left out. Key, address and alias matches
 * are always kept, whatever the budget.
 */

export type IndexRow = {
  readonly key: string;
  readonly drawer: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly description: string | null;
  readonly identities: readonly string[];
  readonly score: number;
  readonly matched_on: string;
};

/** Rows asked from the database; the budget decides how many are shown. */
export const INDEX_ROWS = 120;
const CHARS_PER_TOKEN = 4;
const KEPT = new Set(["key", "identity", "alias"]);

export function indexLine(r: IndexRow): string {
  const aka = [...r.aliases, ...r.identities].map((a) => inline(a, 80)).slice(0, 6);
  return [
    `- ${r.key}`,
    r.drawer,
    inline(r.title, 120),
    ...(aka.length > 0 ? [`aka ${aka.join(", ")}`] : []),
    inline(r.description ?? "", 160),
  ].join(" | ").replace(/ \| $/, "");
}

/** The index text for the prompt, within `maxTokens` (about four characters a token). */
export function renderIndex(rows: readonly IndexRow[], shortlistKeys: readonly string[], maxTokens: number): string {
  const shown = new Set(shortlistKeys);
  const budget = maxTokens * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let used = 0;
  let left = 0;
  for (const r of rows) {
    if (shown.has(r.key)) continue;
    const line = indexLine(r);
    if (KEPT.has(r.matched_on) || used + line.length + 1 <= budget - 40) {
      lines.push(line);
      used += line.length + 1;
    } else {
      left += 1;
    }
  }
  if (left > 0) lines.push(`(${left} more pages not shown)`);
  return lines.join("\n");
}
