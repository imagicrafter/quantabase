import { DEFAULT_RULES, fallbackPrefix, type CuratorRules, type DrawerDef, type EntitySchema } from "../entities/templates.js";
import type { ConsultLabel } from "./consult.js";
import type { Plan } from "./output.js";

/**
 * The curator-quality rules read from the templates (docs/templates.md):
 * durability text, judgement drawers, name-match thresholds and which keys
 * are strong. Nothing here names a drawer.
 */

export function rulesOf(schema: EntitySchema): CuratorRules {
  return schema.rules ?? DEFAULT_RULES;
}

const drawerOf = (schema: EntitySchema, id: string): DrawerDef | undefined => schema.drawers.find((d) => d.id === id);

/** The durability rule for a drawer: its own, else the template-wide one. */
export function durabilityFor(schema: EntitySchema, drawerId: string): readonly string[] {
  return drawerOf(schema, drawerId)?.curator?.durability ?? rulesOf(schema).durability;
}

export function isJudgementDrawer(schema: EntitySchema, drawerId: string): boolean {
  return drawerOf(schema, drawerId)?.curator?.judgement === "high";
}

/** Score at which a new page in this drawer is filed on an existing page instead. */
export function matchThreshold(schema: EntitySchema, drawerId: string): number {
  return drawerOf(schema, drawerId)?.curator?.match_threshold ?? rulesOf(schema).matchThreshold;
}

/** Per-drawer duplicate thresholds for the nightly scan (drawers that set match_threshold). */
export function duplicateThresholds(schema: EntitySchema): { readonly fallback: number; readonly byDrawer: Record<string, number> } {
  const byDrawer: Record<string, number> = {};
  for (const d of schema.drawers) {
    const t = d.curator?.match_threshold;
    if (t !== undefined) byDrawer[d.id] = Math.max(t, rulesOf(schema).duplicateThreshold);
  }
  return { fallback: rulesOf(schema).duplicateThreshold, byDrawer };
}

/**
 * A key that names the entity for certain: an address, a domain or a source
 * id. A slug, or a person:/org: fallback, does not: such a page is matched
 * by name before it is made.
 */
export function hasStrongKey(drawer: DrawerDef, key: string): boolean {
  const fb = fallbackPrefix(drawer);
  if (fb && key.startsWith(`${fb}:`)) return false;
  return drawer.key_rule.kind !== "slug";
}

/** What routing knows besides the plan: the pages shown and how far the consensus runs agreed. */
export type RoutingContext = {
  readonly shortlist: readonly { readonly key: string; readonly drawer: string }[];
  /** Share of decisions the two primary runs agreed on (consensus on only). */
  readonly agreement?: number;
};

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Why this item needs the strong model, or null: a new page in a judgement
 * drawer, an update to a page in one, a consensus the runs could not settle,
 * or primary runs that agreed on less than `low_agreement` of their decisions.
 */
export function needsStrong(
  plan: Pick<Plan, "newPages"> & { readonly updates?: Plan["updates"] },
  label: ConsultLabel,
  schema: EntitySchema,
  ctx: RoutingContext = { shortlist: [] },
): string | null {
  const judged = plan.newPages.find((n) => isJudgementDrawer(schema, n.drawer));
  if (judged) return `a new page in ${judged.drawer}`;
  const touched = (plan.updates ?? [])
    .map((u) => ctx.shortlist.find((p) => p.key === u.key))
    .find((p) => p !== undefined && isJudgementDrawer(schema, p.drawer));
  if (touched) return `an update to a page in ${touched.drawer}`;
  if (label === "uncertain") return "the consensus runs were uncertain";
  const low = rulesOf(schema).lowAgreement;
  if (label !== "single" && ctx.agreement !== undefined && ctx.agreement < low) {
    return `the consensus runs agreed on ${pct(ctx.agreement)} of their decisions (below ${pct(low)})`;
  }
  return null;
}

/** The routing decision and a line saying why, or why not, for the log and the item result. */
export function strongRouting(
  plan: Pick<Plan, "newPages"> & { readonly updates?: Plan["updates"] },
  label: ConsultLabel,
  schema: EntitySchema,
  ctx: RoutingContext,
  hasStrong: boolean,
): { readonly why: string | null; readonly note: string } {
  const why = needsStrong(plan, label, schema, ctx);
  if (why && !hasStrong) return { why: null, note: `would escalate (${why}) but no strong model is set` };
  if (why) return { why, note: `strong model: ${why}` };
  const agreed = ctx.agreement === undefined ? `consensus ${label}` : `consensus ${label}, agreement ${pct(ctx.agreement)}`;
  return { why: null, note: `primary model kept: no judgement drawer touched; ${agreed}` };
}
