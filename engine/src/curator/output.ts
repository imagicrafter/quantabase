import { z } from "zod";
import { patchSchema, type Patch } from "../entities/sections.js";
import { DEFAULT_EVENTS_SECTIONS, fallbackPrefix, keyPrefix, type DrawerDef, type EntitySchema } from "../entities/templates.js";
import type { IndexRow } from "./page-index.js";
import { rulesOf } from "./quality.js";
import { repairPatches, type EventsRule } from "./repair.js";

/**
 * The curator's reply contract, and the strict check every reply passes
 * before anything is written. A reply outside the contract (not JSON, an
 * unknown key or op, too large) is refused whole. Inside it, one bad patch,
 * field, link or page is left out alone and the reason kept (checkReply).
 */

/** One item may name a person, their organisation, a project and a deal. */
export const MAX_UPDATES = 6;
export const MAX_NEW_PAGES = 4;
const MAX_LINKS = 8;

const FieldValue = z.union([z.string().max(300), z.number().finite()]);
const Fields = z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), FieldValue);
/** Keys of other pages this one links to (the header's `related` list). */
const Related = z.array(z.string().min(1).max(200)).max(MAX_LINKS);

const Update = z
  .object({
    key: z.string().min(1).max(200),
    patches: z.array(patchSchema).max(8),
    fields: Fields.optional(),
    related: Related.optional(),
    // Other addresses (people) or domains (organisations) this page is known
    // by; the Engine adds only those the item clearly ties to it (identity.ts).
    identities: z.array(z.string().min(3).max(200)).max(5).optional(),
    // One sentence for the page's dated updates list (rules.page_shape).
    update_line: z.string().max(300).optional(),
  })
  .strict();

const NewPage = z
  .object({
    drawer: z.string().regex(/^[a-z][a-z0-9-]*$/),
    key: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    description: z.string().max(300).optional(),
    fields: Fields.optional(),
    related: Related.optional(),
    sections: z
      .array(z.object({ heading: z.string().min(1).max(120), text: z.string().max(4000) }).strict())
      .max(8),
    update_line: z.string().max(300).optional(),
  })
  .strict();

export const replySchema = z
  .object({
    updates: z.array(Update).max(MAX_UPDATES),
    new_pages: z.array(NewPage).max(MAX_NEW_PAGES),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type Reply = z.infer<typeof replySchema>;
type Linked = { readonly fields: Record<string, string | number>; readonly related: readonly string[] };
export type PlannedUpdate = Omit<z.infer<typeof Update>, "related" | "identities"> & Linked & {
  readonly identities?: readonly string[];
  /** Names to add to the page's aliases (a name match, curate.ts). */
  readonly aliases?: readonly string[];
};
export type PlannedNewPage = Omit<z.infer<typeof NewPage>, "related"> & Linked;

export type Plan = {
  readonly updates: readonly PlannedUpdate[];
  readonly newPages: readonly PlannedNewPage[];
  readonly notes: string;
  /** What the check left out of the reply, one line each with why. */
  readonly dropped?: readonly string[];
  /** Patches and keys the check rewrote to fit (a missing section, a loose key). */
  readonly repaired?: readonly string[];
};

/** A page on the shortlist, as the curator read it. */
export type Candidate = {
  readonly id: string;
  readonly drawer: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly fields: Record<string, unknown>;
  readonly body: string;
  readonly content_hash: string;
  readonly aliases?: readonly string[];
};

/** A page index row, as the check needs it to map a loose key to a page. */
export type IndexEntry = Pick<IndexRow, "key" | "drawer" | "title" | "aliases" | "identities">;

export type CheckContext = {
  readonly shortlist: readonly Candidate[];
  readonly schema: EntitySchema;
  /** The item's raw text (title and body), for the leak check. */
  readonly sourceText: string;
  /** Keys in the page index the curator was shown: links to them are allowed. */
  readonly indexKeys?: readonly string[];
  /** The page index rows: a new page on a known name is filed on that page's key. */
  readonly index?: readonly IndexEntry[];
};

export type CheckResult = { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly reason: string };

const MAX_TOTAL_CHARS = 16000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATED = /^\s*(?:[-*]\s+)?(?:\*\*)?\d{4}-\d{2}-\d{2}\b/;
const LEAK_MIN_CHARS = 25;

/** The JSON object in a reply that may be fenced or wrapped in prose. */
export function extractJsonObject(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1).join("\n");
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? text : text.slice(start, end + 1);
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Why a field value does not fit its drawer, or null when it does. */
export function fieldProblem(drawer: DrawerDef, name: string, value: string | number): string | null {
  const def = drawer.fields.find((f) => f.name === name);
  if (!def) return `"${name}" is not a field of ${drawer.id}`;
  if (def.kind === "number") return typeof value === "number" ? null : `"${name}" must be a number`;
  if (typeof value !== "string") return `"${name}" must be text`;
  if (/[\r\n]/.test(value) || value.trim() === "") return `"${name}" must be one non-empty line`;
  switch (def.kind) {
    case "date":
      return validDate(value) ? null : `"${name}" must be a date YYYY-MM-DD`;
    case "enum":
      return (def.values ?? []).includes(value) ? null : `"${name}" must be one of ${(def.values ?? []).join(", ")}`;
    case "key":
      return /^[^\sA-Z]{1,200}$/.test(value) ? null : `"${name}" must be a lower-case key`;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(value) ? null : `"${name}" must be an email address`;
    case "url":
      return /^https?:\/\/\S+$/.test(value) ? null : `"${name}" must be a web address`;
    default:
      return null;
  }
}

/** Why a new page key breaks its drawer's key rule, or null. */
export function keyProblem(drawer: DrawerDef, key: string): string | null {
  if (key !== key.toLowerCase() || /\s/.test(key)) return "a key is lower case with no spaces";
  const fallback = fallbackPrefix(drawer);
  if (fallback && new RegExp(`^${fallback}:[a-z0-9][a-z0-9._-]*$`).test(key)) return null;
  switch (drawer.key_rule.kind) {
    case "email":
      return /^[^@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(key) ? null : `a ${drawer.id} key is an email address`;
    case "domain":
      return /^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(key) ? null : `a ${drawer.id} key is a web domain`;
    default: {
      const prefix = keyPrefix(drawer);
      return prefix && new RegExp(`^${prefix}:[a-z0-9][a-z0-9._-]*$`).test(key)
        ? null
        : `a ${drawer.id} key starts with "${prefix ?? "?"}:" then a short name`;
    }
  }
}

function patchTexts(p: Patch): readonly string[] {
  switch (p.op) {
    case "append-bullet":
    case "append-paragraph":
      return [p.text];
    case "replace-line":
      return [p.new];
    case "new-section-after":
      return [p.heading, p.text ?? ""];
  }
}

function isDated(p: Patch): boolean {
  switch (p.op) {
    case "append-bullet":
    case "append-paragraph":
      return DATED.test(p.text);
    case "new-section-after":
      return DATED.test(p.heading) || DATED.test(p.text ?? "");
    case "replace-line":
      return true;
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Lines of pages the reply does not target that appear inside `text` and are
 * not in the source: text carried from one page to another.
 */
function leakedLines(text: string, others: readonly Candidate[], source: string): readonly string[] {
  const out = norm(text);
  const src = norm(source);
  return others
    .flatMap((o) => o.body.split("\n"))
    .map((l) => norm(l.replace(/^\s*(?:[-*]|#+)\s+/, "")))
    .filter((l) => l.length >= LEAK_MIN_CHARS && out.includes(l) && !src.includes(l));
}

function drawerOf(schema: EntitySchema, id: string): DrawerDef | undefined {
  return schema.drawers.find((d) => d.id === id);
}

/** The fields that fit the drawer, and one line per field left out. */
function keepFields(drawer: DrawerDef, fields: Record<string, string | number>, who: string): Entry<Record<string, string | number>> {
  const dropped: string[] = [];
  const kept: Record<string, string | number> = {};
  for (const [n, v] of Object.entries(fields)) {
    const problem = fieldProblem(drawer, n, v);
    if (problem) dropped.push(`${who}: field left out: ${problem}`);
    else kept[n] = v;
  }
  return { value: kept, dropped };
}

/** A checked value, or none, with one line per thing dropped on the way. */
type Entry<T> = { readonly value: T | null; readonly dropped: readonly string[]; readonly repaired?: readonly string[] };

const nameOf = (s: string): string => s.toLowerCase().replace(/^[a-z-]+:/, "").replace(/[^\p{L}\p{N}@.]+/gu, " ").trim();

/** The shortlist page an update names: by key, any case, an alias or a known address. */
function pageFor(key: string, ctx: CheckContext): Candidate | undefined {
  const k = key.trim().toLowerCase();
  const exact = ctx.shortlist.find((c) => c.key === key) ?? ctx.shortlist.find((c) => c.key.toLowerCase() === k);
  if (exact) return exact;
  return ctx.shortlist.find((c) => {
    const ids = [...(c.aliases ?? []), ...Object.values(c.fields).flatMap((v) => (Array.isArray(v) ? v.map(String) : []))];
    return ids.some((i) => i.trim().toLowerCase() === k);
  });
}

/** Where dated events go (rules.page_shape), for the section check. */
export function eventsRule(schema: EntitySchema): EventsRule {
  const shape = rulesOf(schema).pageShape;
  return shape ? { sections: shape.eventsSections, updatesHeading: shape.updatesHeading } : { sections: DEFAULT_EVENTS_SECTIONS };
}

function checkUpdate(u: PlannedUpdate, ctx: CheckContext): Entry<PlannedUpdate> & { readonly repaired: readonly string[] } {
  const page = pageFor(u.key, ctx);
  if (!page) return { value: null, dropped: [`update "${u.key}": not on the shortlist`], repaired: [] };
  const who = `update "${page.key}"`;
  const drawer = drawerOf(ctx.schema, page.drawer);
  if (!drawer) return { value: null, dropped: [`${who}: drawer ${page.drawer} is not in this Engine's templates`], repaired: [] };
  const fields = keepFields(drawer, u.fields, who);
  const dropped: string[] = [...fields.dropped];
  const others = ctx.shortlist.filter((c) => c.key !== page.key);
  const usable = u.patches.filter((p) => {
    if (!isDated(p)) {
      dropped.push(`${who}: a patch was left out: every added bullet, paragraph or section starts with a date YYYY-MM-DD`);
      return false;
    }
    if (patchTexts(p).some((t) => leakedLines(t, others, ctx.sourceText).length > 0)) {
      dropped.push(`${who}: a patch was left out: it copies text from another page`);
      return false;
    }
    return true;
  });
  const fixed = repairPatches(page.body, usable, drawer, eventsRule(ctx.schema));
  dropped.push(...fixed.dropped.map((d) => `${who}: a patch was left out: ${d}`));
  const repaired = fixed.repaired.map((r) => `${who}: ${r}`);
  return { value: { ...u, key: page.key, fields: fields.value ?? {}, patches: [...fixed.patches] }, dropped, repaired };
}

/**
 * A new page key written loosely, made to fit the drawer's key rule: lower
 * case, no spaces, no "www." on a domain, a slug after the prefix.
 */
export function normaliseNewKey(drawer: DrawerDef, key: string): string {
  const k = key.trim().toLowerCase();
  const prefixed = /^([a-z][a-z-]*):(.*)$/.exec(k);
  if (prefixed && !k.includes("@")) {
    const slug = (prefixed[2] ?? "").replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    return `${prefixed[1]}:${slug}`;
  }
  if (drawer.key_rule.kind === "domain") return k.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/\s+/g, "");
  if (drawer.key_rule.kind === "email") return k.replace(/\s+/g, "");
  return k.replace(/\s+/g, "-");
}

/** A page this drawer already has under the new page's key or title (name, alias, known address). */
function existingFor(n: PlannedNewPage, ctx: CheckContext): string | null {
  const wanted = new Set([nameOf(n.key), nameOf(n.title)].filter((s) => s !== ""));
  const rows = [
    ...ctx.shortlist.filter((c) => c.drawer === n.drawer).map((c) => ({ key: c.key, names: [c.title, ...(c.aliases ?? [])] })),
    ...(ctx.index ?? []).filter((r) => r.drawer === n.drawer).map((r) => ({ key: r.key, names: [r.title, ...r.aliases, ...r.identities] })),
  ];
  return rows.find((r) => [r.key, ...r.names].some((x) => wanted.has(nameOf(x))))?.key ?? null;
}

function checkNewPage(n: PlannedNewPage, ctx: CheckContext): Entry<PlannedNewPage> {
  const who = `new page "${n.key}"`;
  const drawer = drawerOf(ctx.schema, n.drawer);
  if (!drawer) return { value: null, dropped: [`${who}: drawer ${n.drawer} is not in this Engine's templates`] };
  const normal = normaliseNewKey(drawer, n.key);
  const problem = keyProblem(drawer, normal);
  const key = problem === null ? normal : existingFor(n, ctx);
  if (key === null) return { value: null, dropped: [`${who} (as "${normal}"): ${problem}`] };
  const repaired = key === n.key ? [] : [`${who} filed as "${key}"`];
  // A new page on a shortlist key is not a reason to drop it: before saving
  // it becomes an update of that page (resolve.ts).
  if (/[\r\n]/.test(n.title) || /[\r\n]/.test(n.description ?? "")) return { value: null, dropped: [`${who}: title and description are one line`] };
  const fields = keepFields(drawer, n.fields, who);
  const headings = n.sections.map((s) => norm(s.heading));
  if (new Set(headings).size !== headings.length) return { value: null, dropped: [`${who}: section headings must differ`] };
  if (n.sections.some((s) => /[\r\n#]/.test(s.heading))) return { value: null, dropped: [`${who}: a section heading is one line of plain text`] };
  // The page on this same key is the page this create becomes a patch of.
  const others = ctx.shortlist.filter((c) => c.key !== key);
  if (n.sections.some((s) => leakedLines(s.text, others, ctx.sourceText).length > 0)) {
    return { value: null, dropped: [`${who}: the new page copies text from another page`] };
  }
  return { value: { ...n, key, fields: fields.value ?? {} }, dropped: fields.dropped, repaired };
}

function dedupe(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)];
}

/**
 * A page may link only to pages the curator was shown or creates in the same
 * reply: it never points at a page outside the item's reach. Other links are
 * left out (and said).
 */
/**
 * Every spelling a link may use for a page the reply can link to: its key,
 * any case, the key a new page was written with before it was normalised,
 * and the key with its drawer id in front ("people:ann@example.com").
 */
export function linkResolver(
  linkable: Iterable<string>, written: ReadonlyMap<string, string>, schema: EntitySchema,
): (raw: string) => string | null {
  const byLower = new Map<string, string>();
  for (const k of linkable) byLower.set(k.toLowerCase(), k);
  for (const [raw, key] of written) byLower.set(raw.trim().toLowerCase(), key);
  const drawers = schema.drawers.map((d) => d.id);
  return (raw) => {
    const k = raw.trim().toLowerCase();
    const direct = byLower.get(k);
    if (direct) return direct;
    const prefix = /^([a-z][a-z0-9-]*):(.+)$/.exec(k);
    if (prefix && drawers.includes(prefix[1]!)) {
      const rest = prefix[2]!.trim();
      const drawer = schema.drawers.find((d) => d.id === prefix[1]);
      return byLower.get(rest) ?? (drawer ? byLower.get(normaliseNewKey(drawer, rest)) ?? null : null);
    }
    for (const d of schema.drawers) {
      const hit = byLower.get(normaliseNewKey(d, k));
      if (hit) return hit;
    }
    return null;
  };
}

function keepLinks<T extends PlannedUpdate | PlannedNewPage>(p: T, resolve: (raw: string) => string | null, dropped: string[]): T {
  const related = [...new Set(p.related.flatMap((r) => {
    const key = resolve(r);
    if (key === p.key) return [];
    if (key) return [key];
    dropped.push(`"${p.key}": link to "${r}" left out: it is not on the shortlist or in this reply`);
    return [];
  }))];
  return related.length === p.related.length && related.every((r, i) => r === p.related[i]) ? p : { ...p, related };
}

function totalChars(reply: Reply): number {
  return JSON.stringify(reply).length;
}

const hasContent = (u: PlannedUpdate): boolean =>
  u.patches.length > 0 || Object.keys(u.fields).length > 0 || u.related.length > 0 || (u.identities ?? []).length > 0;

/** Keep the first entry per key; a repeat is left out and said. */
function firstPerKey<T extends { readonly key: string }>(entries: readonly T[], what: string, dropped: string[]): T[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (!seen.has(e.key)) {
      seen.add(e.key);
      return true;
    }
    dropped.push(`${what} "${e.key}" was named twice; the first is kept`);
    return false;
  });
}

/**
 * Parse and check one model reply. Never throws. A reply that is not JSON,
 * breaks the contract or is too large is refused whole. Otherwise one bad
 * patch, field, link or page is left out alone, with the reason in
 * `plan.dropped`; patches to a section the page lacks are repaired
 * (repair.ts) and said in `plan.repaired`. A reply whose every change was
 * left out is refused, with the first reasons.
 */
export function checkReply(raw: string, ctx: CheckContext): CheckResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(extractJsonObject(raw));
  } catch {
    return { ok: false, reason: "the reply is not JSON" };
  }
  const parsed = replySchema.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `the reply does not fit the contract: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
  }
  const reply = parsed.data;
  if (totalChars(reply) > MAX_TOTAL_CHARS) return { ok: false, reason: "the reply is too large" };

  const dropped: string[] = [];
  const repaired: string[] = [];
  const checkedUpdates = reply.updates
    .map((u) => ({ ...u, fields: u.fields ?? {}, related: dedupe(u.related ?? []), identities: dedupe(u.identities ?? []) }))
    .filter(hasContent)
    .flatMap((u) => {
      const r = checkUpdate(u, ctx);
      dropped.push(...r.dropped);
      repaired.push(...r.repaired);
      return r.value ? [r.value] : [];
    });
  const written = new Map<string, string>();
  const checkedPages = reply.new_pages.flatMap((n) => {
    const r = checkNewPage({ ...n, fields: n.fields ?? {}, related: dedupe(n.related ?? []) }, ctx);
    dropped.push(...r.dropped);
    repaired.push(...(r.repaired ?? []));
    if (r.value) written.set(n.key, r.value.key);
    return r.value ? [r.value] : [];
  });
  const updates0 = firstPerKey(checkedUpdates, "update", dropped);
  const pages0 = firstPerKey(checkedPages, "new page", dropped);
  const linkable = new Set([...ctx.shortlist.map((c) => c.key), ...pages0.map((n) => n.key), ...(ctx.indexKeys ?? [])]);
  const resolve = linkResolver(linkable, written, ctx.schema);
  const updates = updates0.map((u) => keepLinks(u, resolve, dropped)).filter((u) => {
    if (hasContent(u)) return true;
    dropped.push(`update "${u.key}": nothing left to change`);
    return false;
  });
  const newPages = pages0.map((n) => keepLinks(n, resolve, dropped));
  const asked = reply.updates.length + reply.new_pages.length;
  if (updates.length === 0 && newPages.length === 0 && asked > 0 && dropped.length > 0) {
    return { ok: false, reason: dropped.slice(0, 3).join("; ") };
  }
  return { ok: true, plan: { updates, newPages, notes: reply.notes ?? "", dropped, repaired } };
}
