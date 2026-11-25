import type { SourceTag } from "./types.js";

export const MAX_TAGS = 50;
export const MAX_ID = 300;
export const MAX_NAME = 200;

/** Trimmed text, or "" for anything that is not a string. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A tag with a cut id and name, or null when either is empty. */
export function tag(kind: string, id: string, name: string): SourceTag | null {
  const cleanId = id.trim().slice(0, MAX_ID);
  const cleanName = name.trim().slice(0, MAX_NAME);
  return cleanId && cleanName ? { kind, id: cleanId, name: cleanName } : null;
}

/** Drop empties and repeats (same kind and id), keep order, cap the count. */
export function unique(tags: readonly (SourceTag | null)[]): readonly SourceTag[] {
  const seen = new Set<string>();
  const out: SourceTag[] = [];
  for (const t of tags) {
    if (!t) continue;
    const k = `${t.kind}\u0000${t.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
