import { ruleCovering, type Suggestion } from "../sources/mail-contacts.js";
import type { LabelRef, Rule } from "../sources/rules.js";
import { ruleFromForm } from "./sources-edit.js";

/**
 * Turning ticked mail suggestions (0080) into ordinary rules, as pure
 * functions. Each ticked domain becomes its own include rule (named after the
 * domain), so it can be moved or removed alone; the ticked people go into one
 * rule, "People from your mail" (more than 50 are split, a field takes 50).
 * Every rule is built by ruleFromForm, the same as the rule builder's, and
 * the whole list is checked again by the database when it is saved.
 */

export const PEOPLE_RULE = "People from your mail";
const PER_FIELD = 50;

/** "domain:acme.example" or "address:bob@acme.example". */
export const pickValue = (s: Suggestion): string => `${s.kind}:${s.value}`;

/** The ticked boxes as suggestions on file, or the reason they are not. */
export function parsePicks(
  raw: readonly string[],
  suggestions: readonly Suggestion[],
  rules: readonly Rule[],
): readonly Suggestion[] | string {
  const wanted = [...new Set(raw.map((v) => v.trim().toLowerCase()))].filter((v) => v !== "");
  if (wanted.length === 0) return "Tick at least one suggestion.";
  const known = new Map(suggestions.map((s) => [pickValue(s), s]));
  const chosen = wanted.map((v) => known.get(v));
  if (chosen.some((s) => s === undefined)) return "Tick only suggestions from the list. Open the rules again.";
  const picked = chosen as readonly Suggestion[];
  const covered = picked.find((s) => ruleCovering(rules, s) !== null);
  if (covered) return `${covered.value} already has a rule.`;
  return picked;
}

function chunks<T>(list: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
}

/** The new include rules for the picks, filed under `target`, or the reason they cannot be made. */
export function rulesFromPicks(
  picks: readonly Suggestion[],
  target: string,
  topics: readonly string[],
  picker: readonly LabelRef[],
): readonly Rule[] | string {
  const domains = picks.filter((s) => s.kind === "domain");
  const people = picks.filter((s) => s.kind === "address").map((s) => s.value);
  const peopleGroups = chunks(people, PER_FIELD);
  const forms = [
    ...domains.map((d) => ({ name: d.value, values: [d.value] })),
    ...peopleGroups.map((g, i) => ({ name: peopleGroups.length > 1 ? `${PEOPLE_RULE} (${i + 1})` : PEOPLE_RULE, values: g })),
  ];
  const built = forms.map((f) =>
    ruleFromForm("gmail", { kind: "include", name: f.name, target, text: { any_address: f.values.join(", ") }, labels: [] }, picker, topics),
  );
  const failed = built.find((r): r is string => typeof r === "string");
  return failed ?? (built as readonly Rule[]);
}
