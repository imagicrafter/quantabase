/**
 * Grouping pages by entity key.
 *
 * Keys are shared across the Engine; pages are not. Two people may each hold
 * a page on one key. Results show one entry per key with the caller's own page
 * first, and lists count keys, not pages. When two pages on one key disagree
 * on a header field, both values are shown and the field is marked as a
 * conflict; nothing is picked silently.
 */

export type PageRow = {
  readonly id: string;
  readonly owner_handle: string;
  readonly is_own: boolean;
  readonly drawer: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly updated_at: string;
  readonly [extra: string]: unknown;
};

export type KeyGroup<T extends PageRow> = {
  readonly key: string;
  readonly drawer: string;
  readonly pages: readonly T[];
};

export function groupByKey<T extends PageRow>(rows: readonly T[]): KeyGroup<T>[] {
  const order = [...new Set(rows.map((r) => r.key))];
  return order.map((key) => {
    const pages = rows
      .filter((r) => r.key === key)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => Number(b.r.is_own) - Number(a.r.is_own) || a.i - b.i)
      .map(({ r }) => r);
    return { key, drawer: pages[0]!.drawer, pages };
  });
}

export type FieldValue =
  | { readonly value: unknown }
  | { readonly conflict: true; readonly values: readonly unknown[] };

export type EntitySummary = {
  readonly key: string;
  readonly drawer: string;
  readonly title: string;
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly conflicts: readonly string[];
  readonly pages: readonly {
    id: string;
    owner: string;
    is_own: boolean;
    title: string;
    description: string | null;
    updated_at: string;
  }[];
};

export type SummaryOptions = {
  readonly filter?: Readonly<Record<string, string | number | boolean>>;
  readonly sort?: string;
  readonly desc?: boolean;
  readonly limit?: number;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function mergeFields(pages: readonly PageRow[]): Record<string, FieldValue> {
  const names = [...new Set(pages.flatMap((p) => Object.keys(p.fields ?? {})))];
  return Object.fromEntries(
    names.map((name) => {
      const values = pages
        .filter((p) => p.fields && name in p.fields)
        .map((p) => p.fields[name])
        .filter((v, i, list) => list.findIndex((x) => same(x, v)) === i);
      const merged: FieldValue =
        values.length === 1 ? { value: values[0] } : { conflict: true, values };
      return [name, merged];
    }),
  );
}

function firstValue(f: FieldValue | undefined): unknown {
  if (!f) return undefined;
  return "value" in f ? f.value : f.values[0];
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function summarise(group: KeyGroup<PageRow>): EntitySummary {
  const fields = mergeFields(group.pages);
  return {
    key: group.key,
    drawer: group.drawer,
    title: group.pages[0]!.title,
    fields,
    conflicts: Object.keys(fields).filter((n) => "conflict" in fields[n]!),
    pages: group.pages.map((p) => ({
      id: p.id,
      owner: p.owner_handle,
      is_own: p.is_own,
      title: p.title,
      description: p.description,
      updated_at: p.updated_at,
    })),
  };
}

function matches(group: KeyGroup<PageRow>, filter: SummaryOptions["filter"]): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([name, want]) =>
    group.pages.some((p) => p.fields && same(p.fields[name], want)),
  );
}

/** One entry per key, filtered and sorted. `count` is the number of keys. */
export function summariseEntities(
  rows: readonly PageRow[],
  opts: SummaryOptions,
): { count: number; truncated: boolean; entities: EntitySummary[] } {
  const all = groupByKey(rows)
    .filter((g) => matches(g, opts.filter))
    .map(summarise);
  const sortKey = opts.sort;
  const sorted = sortKey
    ? [...all].sort((a, b) => {
        const av = firstValue(a.fields[sortKey]);
        const bv = firstValue(b.fields[sortKey]);
        if (av === undefined || bv === undefined) {
          return Number(av === undefined) - Number(bv === undefined);
        }
        return opts.desc ? compare(bv, av) : compare(av, bv);
      })
    : all;
  const limit = opts.limit ?? 100;
  return { count: all.length, truncated: sorted.length > limit, entities: sorted.slice(0, limit) };
}
