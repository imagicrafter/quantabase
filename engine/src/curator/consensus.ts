import type { DrawerDef, EntitySchema } from "../entities/templates.js";
import type { Candidate, Plan, PlannedNewPage, PlannedUpdate } from "./output.js";

/**
 * Consensus curation. Runs are compared on their structured decisions only,
 * never on wording:
 *
 *   page:<drawer>:<target>   "create" or "patch"
 *   field:<target>:<name>    the value, normalised for its kind
 *
 * The target is the page key, except in a drawer whose key rule has an
 * `anchor` (templates YAML): there a page is "<drawer>@<anchor value>", so
 * three runs that name the same organisation's deal three different slugs
 * vote on one deal. The canonical key comes from the first run on the winning
 * side. With `anchor.single_open`, a new page whose anchor already has an open
 * page on the shortlist becomes an update of that page (see preferOpen).
 *
 * Field values are normalised before comparing: numbers by value ("$12,000"
 * = 12000), dates by day, enums, keys, emails and urls by lower case. Free
 * text votes only on being set; its wording comes from the winning side.
 *
 * Two runs that agree on every decision: run 1 is used as it is. Otherwise,
 * with a third run, each decision goes to the value at least two runs share
 * (absent counts as a value: two runs leaving a page out drop it). A decision
 * with no majority is dropped and reported as uncertain, with each run's
 * target and value. Patch text comes from the first run on the winning side.
 */

export type Decisions = ReadonlyMap<string, string>;

/** What the vote needs to know besides the runs: the drawers and the pages shown. */
export type VoteContext = {
  readonly schema: EntitySchema;
  readonly shortlist: readonly Pick<Candidate, "key" | "drawer" | "fields">[];
};

type FieldValue = string | number;
type Entry =
  | { readonly kind: "patch"; readonly drawer: string; readonly item: PlannedUpdate }
  | { readonly kind: "create"; readonly drawer: string; readonly item: PlannedNewPage };
type Indexed = {
  readonly decisions: Map<string, string>;
  readonly entries: ReadonlyMap<string, Entry>;
  /** Decision id -> how this run's proposal reads on Indexing. */
  readonly shown: ReadonlyMap<string, string>;
};

const ABSENT = "(absent)";
const SET = "(set)";

const drawerDef = (ctx: VoteContext | undefined, id: string): DrawerDef | undefined =>
  ctx?.schema.drawers.find((d) => d.id === id);

const lower = (v: FieldValue): string => String(v).trim().toLowerCase();
const canonKey = (key: string): string => key.trim().toLowerCase();

function asNumber(v: FieldValue): number | null {
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$€£,\s]/g, ""));
  return Number.isFinite(n) && String(v).trim() !== "" ? n : null;
}

function asDay(v: FieldValue): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  if (m) return m[1] ?? null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A field value as the vote compares it. */
export function normaliseField(drawer: DrawerDef | undefined, name: string, value: FieldValue): string {
  const kind = drawer?.fields.find((f) => f.name === name)?.kind;
  switch (kind) {
    case "number": {
      const n = asNumber(value);
      return n === null ? JSON.stringify(value) : `n:${n}`;
    }
    case "date": {
      const d = asDay(value);
      return d === null ? JSON.stringify(value) : `d:${d}`;
    }
    case "enum":
    case "key":
    case "email":
    case "url":
      return JSON.stringify(lower(value));
    case "text":
      return SET;
    default:
      return JSON.stringify(value);
  }
}

function anchorOf(drawer: DrawerDef | undefined, fields: Readonly<Record<string, unknown>>): string | null {
  const field = drawer?.key_rule.anchor?.field;
  const v = field ? fields[field] : undefined;
  return typeof v === "string" && v.trim() !== "" ? `${drawer!.id}@${lower(v)}` : null;
}

function isOpen(drawer: DrawerDef | undefined, fields: Readonly<Record<string, unknown>>): boolean {
  const rule = drawer?.key_rule.anchor?.single_open;
  if (!rule) return false;
  const v = fields[rule.field];
  return !(typeof v === "string" && rule.closed.includes(lower(v)));
}

/** The open shortlist page for an anchor in a single_open drawer, if any. */
function openPageFor(ctx: VoteContext, drawerId: string, anchor: string) {
  const def = drawerDef(ctx, drawerId);
  if (!def?.key_rule.anchor?.single_open) return undefined;
  return ctx.shortlist.find((p) => p.drawer === drawerId && isOpen(def, p.fields) && anchorOf(def, p.fields) === anchor);
}

const rewrite = (related: readonly string[], alias: ReadonlyMap<string, string>, self: string): string[] =>
  [...new Set(related.map((r) => alias.get(r) ?? r))].filter((r) => r !== self);

/**
 * A new page in a single_open drawer whose anchor already has an open page on
 * the shortlist becomes an update of that page (its fields and links; the new
 * page's sections are not carried over), and links to it follow.
 */
export function preferOpen(plan: Plan, ctx: VoteContext): Plan {
  const alias = new Map<string, string>();
  const converted: PlannedUpdate[] = [];
  const newPages = plan.newPages.filter((n) => {
    const def = drawerDef(ctx, n.drawer);
    const anchor = anchorOf(def, n.fields);
    const open = anchor ? openPageFor(ctx, n.drawer, anchor) : undefined;
    if (!open || plan.updates.some((u) => u.key === open.key) || converted.some((u) => u.key === open.key)) return true;
    const anchorField = def?.key_rule.anchor?.field ?? "";
    const fields = Object.fromEntries(Object.entries(n.fields).filter(([f]) => f !== anchorField));
    alias.set(n.key, open.key);
    converted.push({ key: open.key, patches: [], fields, related: n.related });
    return false;
  });
  if (alias.size === 0) return plan;
  const fix = <T extends PlannedUpdate | PlannedNewPage>(x: T): T => ({ ...x, related: rewrite(x.related, alias, x.key) });
  return { ...plan, updates: [...plan.updates, ...converted].map(fix), newPages: newPages.map(fix) };
}

function index(plan: Pick<Plan, "updates" | "newPages">, ctx?: VoteContext): Indexed {
  const decisions = new Map<string, string>();
  const entries = new Map<string, Entry>();
  const shown = new Map<string, string>();
  // A target is never reused within a run, so one decision always names one
  // entry (an update and a new page on the same key used to share a target,
  // and the first entry was lost behind the second).
  const add = (e: Entry, wanted: string | null) => {
    // Two runs naming one page in different case are one decision.
    const own = canonKey(e.item.key);
    let target = wanted && !entries.has(wanted) ? wanted : own;
    for (let n = 2; entries.has(target); n += 1) target = `${own}#${n}`;
    entries.set(target, e);
    const pid = `page:${e.drawer}:${target}`;
    decisions.set(pid, e.kind);
    shown.set(pid, `${e.kind} ${e.drawer} ${e.item.key}`);
    const def = drawerDef(ctx, e.drawer);
    for (const [n, v] of Object.entries(e.item.fields)) {
      const fid = `field:${target}:${n}`;
      decisions.set(fid, ctx ? normaliseField(def, n, v) : JSON.stringify(v));
      shown.set(fid, `${e.item.key} ${n} = ${JSON.stringify(v)}`);
    }
  };
  for (const u of plan.updates) {
    const page = ctx?.shortlist.find((p) => canonKey(p.key) === canonKey(u.key));
    const def = page ? drawerDef(ctx, page.drawer) : undefined;
    const anchored = page && isOpen(def, page.fields) ? anchorOf(def, page.fields) : null;
    add({ kind: "patch", drawer: page?.drawer ?? "?", item: u }, anchored);
  }
  for (const n of plan.newPages) add({ kind: "create", drawer: n.drawer, item: n }, anchorOf(drawerDef(ctx, n.drawer), n.fields));
  return { decisions, entries, shown };
}

/**
 * A run's decisions as the vote compares them. With the context, a new page
 * on an open anchor counts as the update it will become (preferOpen), the
 * same as in merge: one run creating the open deal and another updating it
 * decided the same thing.
 */
export function decisionsOf(plan: Pick<Plan, "updates" | "newPages">, ctx?: VoteContext): Map<string, string> {
  const shaped = ctx ? preferOpen({ notes: "", ...plan }, ctx) : plan;
  return index(shaped, ctx).decisions;
}

/**
 * Decisions both runs can be compared on: every page decision, and a field
 * only when both runs set it. A field one run left out is not a
 * disagreement (the source may state it only in passing); two different
 * values are.
 */
function comparable(a: Decisions, b: Decisions): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => !k.startsWith("field:") || (a.has(k) && b.has(k)));
}

export function agree(a: Decisions, b: Decisions): boolean {
  return comparable(a, b).every((k) => a.get(k) === b.get(k));
}

/** Share of comparable decisions two runs agree on, 0 to 1 (1 when there is nothing to compare). */
export function agreement(a: Decisions, b: Decisions): number {
  const keys = comparable(a, b);
  if (keys.length === 0) return 1;
  return keys.filter((k) => a.get(k) === b.get(k)).length / keys.length;
}

export type Uncertain = { readonly decision: string; readonly proposals: readonly string[] };
export type Merged = { readonly plan: Plan; readonly uncertain: readonly Uncertain[] };

function winner(values: readonly string[]): string | null {
  for (const v of values) if (values.filter((x) => x === v).length >= 2) return v;
  return null;
}

/** The won fields of one target, each value taken from the first run that holds it (the source run first). */
function wonFields(target: string, src: number, runs: readonly Indexed[], won: ReadonlyMap<string, string>): Record<string, FieldValue> {
  const order = [src, ...runs.map((_, i) => i).filter((i) => i !== src)];
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.entries.get(target)?.item.fields ?? {})))];
  const out: Record<string, FieldValue> = {};
  for (const n of names) {
    const fid = `field:${target}:${n}`;
    const w = won.get(fid);
    if (w === undefined) continue;
    const from = order.find((i) => runs[i]!.decisions.get(fid) === w);
    const v = from === undefined ? undefined : runs[from]!.entries.get(target)?.item.fields[n];
    if (v !== undefined) out[n] = v;
  }
  return out;
}

/** Merge two or three runs by majority per decision. */
export function merge(plans: readonly Plan[], ctx?: VoteContext): Merged {
  const runs = plans.map((p) => index(ctx ? preferOpen(p, ctx) : p, ctx));
  const keys = [...new Set(runs.flatMap((r) => [...r.decisions.keys()]))].sort();
  const won = new Map<string, string>();
  const uncertain: Uncertain[] = [];
  for (const k of keys) {
    const w = winner(runs.map((r) => r.decisions.get(k) ?? ABSENT));
    if (w === null) uncertain.push({ decision: k, proposals: runs.map((r) => r.shown.get(k) ?? ABSENT) });
    else if (w !== ABSENT) won.set(k, w);
  }

  type Picked = { readonly target: string; readonly src: number; readonly entry: Entry };
  const picked: Picked[] = [];
  for (const [k, v] of won) {
    if (!k.startsWith("page:")) continue;
    const target = k.split(":").slice(2).join(":");
    const src = runs.findIndex((r) => r.decisions.get(k) === v);
    const entry = runs[src]?.entries.get(target);
    if (entry) picked.push({ target, src, entry });
  }
  // Each run's own key for a won target -> the canonical key (from the source run).
  const aliases = runs.map((r) => new Map(picked.flatMap((p) => {
    const mine = r.entries.get(p.target)?.item.key;
    return mine ? [[mine, p.entry.item.key] as const] : [];
  })));
  const final = new Set([...picked.map((p) => p.entry.item.key), ...(ctx?.shortlist.map((p) => p.key) ?? [])]);
  const madeAnywhere = new Set(runs.flatMap((r) => [...r.entries.values()].filter((e) => e.kind === "create").map((e) => e.item.key)));
  const links = (p: Picked) =>
    rewrite(p.entry.item.related, aliases[p.src]!, p.entry.item.key).filter((r) => final.has(r) || !madeAnywhere.has(r));

  const updates: PlannedUpdate[] = [];
  const newPages: PlannedNewPage[] = [];
  for (const p of picked) {
    const fields = wonFields(p.target, p.src, runs, won);
    // One write per page key, as a single run's reply must be (output.ts):
    // a second write of the same key would fail on a stale hash.
    const key = p.entry.item.key;
    if (updates.some((u) => u.key === key) || newPages.some((n) => n.key === key)) continue;
    if (p.entry.kind === "patch") updates.push({ ...p.entry.item, fields, related: links(p) });
    else if (p.entry.drawer) newPages.push({ ...p.entry.item, fields, related: links(p) });
  }
  const said = (f: "dropped" | "repaired") => [...new Set(plans.flatMap((p) => p[f] ?? []))];
  return { plan: { updates, newPages, notes: plans[0]?.notes ?? "", dropped: said("dropped"), repaired: said("repaired") }, uncertain };
}
