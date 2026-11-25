import { applyPatches } from "../entities/sections.js";
import { withIdentities } from "./identity.js";
import type { PlannedNewPage, PlannedUpdate } from "./output.js";
import type { ClaimedItem, PageRow } from "./store.js";

/**
 * Turning a checked plan into the page a save writes. Pure functions.
 *
 * Every page the curator touches records the item in `sources`
 * ({item, source, source_id, version}). That record is what makes a re-run
 * safe: a page that already lists the item is not patched again.
 */

export type SourceRef = {
  readonly item: string;
  readonly source: string;
  readonly source_id: string;
  readonly version: number;
};

export function sourceRef(item: Pick<ClaimedItem, "id" | "source" | "source_id" | "version">): SourceRef {
  return { item: item.id, source: item.source, source_id: item.source_id, version: item.version };
}

export function alreadyHas(page: Pick<PageRow, "sources">, itemId: string): boolean {
  return page.sources.some(
    (s) => s !== null && typeof s === "object" && (s as Record<string, unknown>)["item"] === itemId,
  );
}

export type Generated = { readonly by: "curator"; readonly model: string; readonly at: string };

/** The whole page after an update: patches applied, fields merged, source added. */
export function updatedPage(
  page: PageRow,
  u: Pick<PlannedUpdate, "patches" | "fields"> & { readonly related?: readonly string[]; readonly aliases?: readonly string[] },
  ref: SourceRef,
  generated: Generated,
  identity?: { readonly field: string; readonly add: readonly string[] },
): Record<string, unknown> {
  const title = page.title.trim().toLowerCase();
  const aliases = [...page.aliases];
  for (const a of u.aliases ?? []) {
    const name = a.trim();
    if (name && name.toLowerCase() !== title && !aliases.some((x) => x.toLowerCase() === name.toLowerCase())) aliases.push(name);
  }
  const fields = { ...page.fields, ...u.fields };
  return {
    drawer: page.drawer,
    key: page.key,
    template: page.template ?? undefined,
    title: page.title,
    aliases,
    description: page.description ?? undefined,
    fields: identity ? withIdentities(fields, identity.field, identity.add) : fields,
    topics: page.topics,
    status: page.status,
    tags: page.tags,
    related: [...new Set([...page.related, ...(u.related ?? [])])],
    sources: [...page.sources, ref],
    generated,
    verified: page.verified,
    body: applyPatches(page.body, u.patches),
  };
}

export type UpdateLine = { readonly heading: string; readonly max: number; readonly date: string; readonly text: string };

const DATED = /^\d{4}-\d{2}-\d{2}\b/;

/**
 * The page with one dated line at the top of its updates list (rules.
 * page_shape): the section sits right after the title heading, newest line
 * first, at most `max` lines (the oldest fall off; the full record stays in
 * the page's own sections and history). A line already there is not added.
 */
export function withUpdateLine(body: string, u: UpdateLine): string {
  const text = u.text.replace(/\s+/g, " ").trim().replace(/^[-*]\s*/, "");
  if (!text) return body;
  const line = `- ${DATED.test(text) ? text : `${u.date}: ${text}`}`;
  const lines = body.split("\n");
  const heading = `## ${u.heading}`;
  const at = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (at === -1) {
    const title = lines.findIndex((l) => /^#\s/.test(l));
    const insertAt = title === -1 ? 0 : title + 1;
    const block = [...(insertAt > 0 ? [""] : []), heading, line, ...(insertAt === 0 ? [""] : [])];
    return [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)].join("\n");
  }
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l));
  const stop = end === -1 ? lines.length : end;
  const bullets = lines.slice(at + 1, stop).filter((l) => /^[-*]\s/.test(l.trim()));
  if (bullets.some((b) => b.trim().toLowerCase() === line.toLowerCase())) return body;
  const kept = [line, ...bullets].slice(0, u.max);
  return [...lines.slice(0, at + 1), ...kept, "", ...lines.slice(stop)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** A new page in the item's topics: title heading, then the drawer's sections in order. */
export function newPage(
  n: PlannedNewPage,
  sectionOrder: readonly string[],
  topics: readonly string[],
  ref: SourceRef,
  generated: Generated,
): Record<string, unknown> {
  const rank = (h: string): number => {
    const i = sectionOrder.findIndex((s) => s.toLowerCase() === h.trim().toLowerCase());
    return i === -1 ? sectionOrder.length : i;
  };
  const sections = [...n.sections].sort((a, b) => rank(a.heading) - rank(b.heading));
  const body = [
    `# ${n.title.trim()}`,
    ...sections.flatMap((s) => ["", `## ${s.heading.trim()}`, ...(s.text.trim() ? [s.text.trim()] : [])]),
    "",
  ].join("\n");
  return {
    drawer: n.drawer,
    key: n.key,
    title: n.title.trim(),
    description: n.description?.trim() || undefined,
    fields: n.fields,
    topics,
    related: [...n.related],
    status: "unreviewed",
    sources: [ref],
    generated,
    body,
  };
}
