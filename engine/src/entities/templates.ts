import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { McpAppError } from "../mcp/errors.js";

/**
 * Entity templates: one YAML file per business type in engine/templates/entities.
 *
 * `base` holds the eight drawers every Engine has. A business template adds
 * drawers. An Engine uses base plus one or more business templates; when two
 * templates define the same drawer, the first one named wins. Skills read the
 * composed schema with get_entity_schema and never hard-code a business type.
 */

const DIR = fileURLToPath(new URL("../../templates/entities/", import.meta.url));

const Slug = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const Threshold = z.number().min(0.5).max(1);

const Field = z
  .object({
    name: Slug,
    kind: z.enum(["text", "date", "number", "enum", "key", "email", "url"]),
    values: z.array(z.string()).optional(),
    text: z.string().optional(),
  })
  .strict()
  .refine((f) => (f.kind === "enum") === (f.values !== undefined && f.values.length > 0), {
    message: "an enum field needs values, and only an enum field has them",
  });

const ListView = z
  .object({
    name: Slug,
    filter: Slug.optional(),
    sort: Slug.optional(),
    desc: z.boolean().optional(),
  })
  .strict();

const Drawer = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    key_rule: z
      .object({
        kind: z.enum(["email", "domain", "slug", "source_id"]),
        text: z.string().min(1),
        // source_id keys only: the sources whose items carry this key
        // ("<prefix>:<the item's source id>"), e.g. [fireflies, calendar].
        sources: z.array(Slug).optional(),
        // slug keys only: the field naming what a page belongs to (a deal's
        // organisation). Consensus runs name slugs freely, so the vote
        // compares these pages by drawer + anchor value, not by key.
        // single_open: at most one open page per anchor value; an open page
        // there is updated instead of a new one made. A page is closed when
        // its single_open.field holds one of single_open.closed.
        anchor: z
          .object({
            field: Slug,
            single_open: z.object({ field: Slug, closed: z.array(z.string().min(1)).min(1) }).strict().optional(),
          })
          .strict()
          .optional(),
        // email and domain keys only: the field holding every other address
        // (or domain) the page is known by; key matching checks them all.
        identities: z.enum(["emails", "domains"]).optional(),
        // email and domain keys only: the slug prefix for a page whose
        // address or domain is not known yet (person:<name>, org:<name>).
        // Such a page has no strong key, so it is matched by name first.
        fallback: z.string().regex(/^[a-z][a-z-]*$/).optional(),
      })
      .strict()
      .refine((r) => r.anchor === undefined || r.kind === "slug", { message: "only a slug key has an anchor" })
      .refine((r) => (r.identities === undefined && r.fallback === undefined) || r.kind === "email" || r.kind === "domain", {
        message: "only an email or domain key has identities or a fallback",
      }),
    // The app's icon for this drawer (a name from engine/src/app/icons.ts).
    icon: Slug.optional(),
    fields: z.array(Field),
    sections: z.array(z.string().min(1)),
    signals: z.array(z.string().min(1)),
    update_rules: z
      .object({ auto: z.array(Slug), needs_yes: z.array(Slug) })
      .strict(),
    default_topic: z.string().nullable().optional(),
    // How the curator treats a NEW page in this drawer: made on its own
    // ("auto", the default) or held for a person's yes ("needs_yes").
    // links_to: drawers this drawer's pages link to ("related") when one item
    // names both. notes: extra one-line rules for the curator about this drawer.
    curator: z
      .object({
        new_page: z.enum(["auto", "needs_yes"]).optional(),
        // high: a new page here needs judgement, so the strong model is asked
        // (curator_settings.strong_model).
        judgement: z.enum(["high", "normal"]).optional(),
        // Replaces the template-wide durability rules for this drawer.
        durability: z.array(z.string().min(1)).optional(),
        // Name/embedding score (0.5-1) at which a new page without a strong
        // key is filed on an existing page instead.
        match_threshold: Threshold.optional(),
        links_to: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
        notes: z.array(z.string().min(1)).optional(),
        // Case-insensitive regular expressions on the item's text: a match
        // means the reply must make or update a page in this drawer.
        required_when: z
          .array(
            z.string().min(1).max(300).refine((s) => {
              try {
                new RegExp(s, "i");
                return true;
              } catch {
                return false;
              }
            }, "required_when must be a valid regular expression"),
          )
          .optional(),
      })
      .strict()
      .optional(),
    list_views: z.array(ListView),
  })
  .strict();

// Template-wide curator rules; the first template (base first) that sets a
// value wins. See docs/templates.md.
const Rules = z
  .object({
    durability: z.array(z.string().min(1)).optional(),
    skip: z.array(z.string().min(1)).optional(),
    match_threshold: Threshold.optional(),
    duplicate_threshold: Threshold.optional(),
    index_tokens: z.number().int().min(0).max(20000).optional(),
    low_agreement: z.number().min(0).max(1).optional(),
    // A dated "updates" list at the top of every changed page, and the
    // longest title a new page may have. updates_heading "" turns it off.
    page_shape: z
      .object({
        updates_heading: z.string().max(60),
        updates_max: z.number().int().min(1).max(50).default(5),
        title_max: z.number().int().min(20).max(200).default(60),
        // Where dated events go on a page, first one the page has wins
        // (an imported wiki page's "Key Interactions", else the template's
        // "Timeline"). The curator never adds another such section.
        events_sections: z.array(z.string().min(1).max(60)).min(1).max(8).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const Template = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    description: z.string().min(1),
    curator: Rules.optional(),
    drawers: z.array(Drawer),
  })
  .strict();

/** The schema one template file must fit (exported for tests). */
export const templateSchema = Template;

export type DrawerDef = z.infer<typeof Drawer>;
export type TemplateDef = z.infer<typeof Template>;

/** The composed curator rules (defaults when no template sets one). */
export type CuratorRules = {
  readonly durability: readonly string[];
  readonly skip: readonly string[];
  readonly matchThreshold: number;
  readonly duplicateThreshold: number;
  readonly indexTokens: number;
  /** Primary runs agreeing on less than this share of decisions go to the strong model. */
  readonly lowAgreement: number;
  /** The dated updates list and title length (rules.page_shape); absent when off. */
  readonly pageShape?: PageShape;
};

export type PageShape = {
  readonly updatesHeading: string;
  readonly updatesMax: number;
  readonly titleMax: number;
  /** Sections dated events go in, most preferred first (rules.page_shape.events_sections). */
  readonly eventsSections: readonly string[];
};

/** Where dated events go when no template names a list. */
export const DEFAULT_EVENTS_SECTIONS: readonly string[] = ["Key Interactions", "Timeline"];

export const DEFAULT_RULES: CuratorRules = {
  durability: [], skip: [], matchThreshold: 0.9, duplicateThreshold: 0.92, indexTokens: 1500, lowAgreement: 0.5,
};

function shapeOf(
  raw: { updates_heading: string; updates_max: number; title_max: number; events_sections?: string[] | undefined } | undefined,
): PageShape | undefined {
  const heading = raw?.updates_heading.trim() ?? "";
  return raw && heading
    ? { updatesHeading: heading, updatesMax: raw.updates_max, titleMax: raw.title_max, eventsSections: raw.events_sections ?? DEFAULT_EVENTS_SECTIONS }
    : undefined;
}

export type EntitySchema = {
  readonly templates: readonly string[];
  readonly drawers: readonly DrawerDef[];
  readonly rules?: CuratorRules;
};

function composeRules(templates: readonly TemplateDef[]): CuratorRules {
  const pick = <K extends keyof z.infer<typeof Rules>>(k: K) => templates.map((t) => t.curator?.[k]).find((v) => v !== undefined);
  return {
    durability: pick("durability") ?? DEFAULT_RULES.durability,
    skip: pick("skip") ?? DEFAULT_RULES.skip,
    matchThreshold: pick("match_threshold") ?? DEFAULT_RULES.matchThreshold,
    duplicateThreshold: pick("duplicate_threshold") ?? DEFAULT_RULES.duplicateThreshold,
    indexTokens: pick("index_tokens") ?? DEFAULT_RULES.indexTokens,
    lowAgreement: pick("low_agreement") ?? DEFAULT_RULES.lowAgreement,
    ...(shapeOf(pick("page_shape")) ? { pageShape: shapeOf(pick("page_shape"))! } : {}),
  };
}

function readAll(): ReadonlyMap<string, TemplateDef> {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml")).sort();
  const entries = files.map((file) => {
    const parsed = Template.safeParse(parse(readFileSync(`${DIR}${file}`, "utf8")));
    if (!parsed.success) {
      throw new Error(`Template ${file} is not valid: ${parsed.error.message}`);
    }
    if (`${parsed.data.name}.yaml` !== file) {
      throw new Error(`Template ${file} names itself ${parsed.data.name}`);
    }
    return [parsed.data.name, parsed.data] as const;
  });
  return new Map(entries);
}

let cache: ReadonlyMap<string, TemplateDef> | null = null;

/** Every template file, parsed and checked once. */
export function loadTemplates(): ReadonlyMap<string, TemplateDef> {
  cache = cache ?? readAll();
  return cache;
}

export const TEMPLATE_NAMES: readonly string[] = [...loadTemplates().keys()];

export const BASE_DRAWERS: readonly string[] = (loadTemplates().get("base")?.drawers ?? []).map(
  (d) => d.id,
);

/** Base plus the named templates, in order; first definition of a drawer wins. */
export function entitySchema(names: readonly string[]): EntitySchema {
  const all = loadTemplates();
  const chosen = ["base", ...names.filter((n) => n !== "base")];
  const unknown = chosen.filter((n) => !all.has(n));
  if (unknown.length > 0) {
    throw new McpAppError(
      "invalid_argument",
      `Unknown template: ${unknown.join(", ")}. Available: ${TEMPLATE_NAMES.join(", ")}`,
    );
  }
  const drawers = chosen
    .flatMap((n) => all.get(n)?.drawers ?? [])
    .filter((d, i, list) => list.findIndex((x) => x.id === d.id) === i);
  const rules = composeRules(chosen.flatMap((n) => (all.has(n) ? [all.get(n)!] : [])));
  return { templates: [...new Set(chosen)], drawers, rules };
}

/** Every drawer id any template defines: what save_page accepts. */
export function allDrawerIds(): ReadonlySet<string> {
  return new Set([...loadTemplates().values()].flatMap((t) => t.drawers.map((d) => d.id)));
}

/**
 * The fixed prefix of a slug or source-id key ("deal" for "deal:..."), taken
 * from the key rule's text; null for email and domain keys.
 */
export function keyPrefix(drawer: DrawerDef): string | null {
  if (drawer.key_rule.kind === "email" || drawer.key_rule.kind === "domain") return null;
  const m = /^"?([a-z][a-z-]*):/.exec(drawer.key_rule.text.trim());
  return m ? (m[1] ?? null) : null;
}

/** The fallback slug prefix of an email or domain drawer ("person"), else null. */
export function fallbackPrefix(drawer: DrawerDef): string | null {
  return drawer.key_rule.fallback ?? null;
}
