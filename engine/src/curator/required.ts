import type { EntitySchema } from "../entities/templates.js";
import type { Candidate, Plan } from "./output.js";

/**
 * Drawers an item must reach, from the templates' `curator.required_when`
 * patterns. The patterns live in the YAML; this only runs them. A drawer is
 * missing when one of its patterns matches the item's text and the reply
 * neither makes a page in it nor updates a shortlist page in it.
 */

const compiled = new Map<string, RegExp>();
function re(pattern: string): RegExp {
  const hit = compiled.get(pattern);
  if (hit) return hit;
  const made = new RegExp(pattern, "i");
  compiled.set(pattern, made);
  return made;
}

export function missingRequired(
  text: string,
  plan: Pick<Plan, "updates" | "newPages">,
  schema: EntitySchema,
  shortlist: readonly Pick<Candidate, "key" | "drawer">[],
): string[] {
  const touched = new Set([
    ...plan.newPages.map((n) => n.drawer),
    ...plan.updates.flatMap((u) => shortlist.filter((p) => p.key === u.key).map((p) => p.drawer)),
  ]);
  return schema.drawers
    .filter((d) => (d.curator?.required_when ?? []).some((p) => re(p).test(text)))
    .filter((d) => !touched.has(d.id))
    .map((d) => d.id);
}

/** The note added to the prompt on the one retry. */
export function requiredNote(missing: readonly string[], schema: EntitySchema): string {
  return missing
    .map((id) => {
      const label = schema.drawers.find((d) => d.id === id)?.label ?? id;
      return `CHECK: this item matches the ${label} signal; create or update the ${label.toLowerCase().replace(/s$/, "")} page (drawer ${id}).`;
    })
    .join("\n");
}
