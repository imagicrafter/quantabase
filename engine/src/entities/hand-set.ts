/**
 * Fields a person set by hand.
 *
 * When a person changes a page's properties in the app's edit form, each
 * field they changed is recorded in the page's `verified` list as
 * {field, value, by: "person", at}. The curator applies its changes on its
 * own, except one that would overwrite such a value with a different one:
 * that waits for the owner's yes (see curator/policy.ts).
 *
 * Only the app's edit form marks fields. Writes through the MCP page tools
 * (the ingest plugin, scheduled tasks) are machine-shaped and do not.
 */

export type HandSetMark = {
  readonly field: string;
  readonly value: unknown;
  readonly by: "person";
  readonly at: string;
};

function isMark(v: unknown): v is HandSetMark {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return r["by"] === "person" && typeof r["field"] === "string" && "value" in r;
}

/** field -> the value the person set (null when they cleared it). */
export function handSetFields(verified: readonly unknown[] | undefined): ReadonlyMap<string, unknown> {
  return new Map((verified ?? []).filter(isMark).map((m) => [m.field, m.value]));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `verified` with a fresh mark for every field that differs between before and after. */
export function markHandSet(
  verified: readonly unknown[],
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  at: string,
): readonly unknown[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = names.filter((n) => !same(before[n], after[n]));
  if (changed.length === 0) return verified;
  const kept = verified.filter((v) => !(isMark(v) && changed.includes(v.field)));
  const marks: HandSetMark[] = changed.map((field) => ({ field, value: after[field] ?? null, by: "person", at }));
  return [...kept, ...marks];
}
