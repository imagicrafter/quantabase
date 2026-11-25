import { fieldsFor, splitAddresses, without, type LabelRef, type Rule, type RuleMatch, type RuleSource } from "../sources/rules.js";

/**
 * Edits to one account's ordered rule list, as pure functions: each returns a
 * NEW list (or a reason it cannot), never changes the one it was given. The
 * database checks the result again in full when it is saved (0063).
 */

export type Target = { readonly kind: "topic"; readonly topic: string } | { readonly kind: "private" };

export type RuleOp =
  | { readonly op: "add"; readonly rule: Rule }
  | { readonly op: "delete"; readonly index: number }
  | { readonly op: "up"; readonly index: number }
  | { readonly op: "down"; readonly index: number }
  | { readonly op: "target"; readonly index: number; readonly target: Target };

/** What the form sent for a new rule: one string per text box, a list per label box. */
export type RuleForm = {
  readonly kind: string;
  readonly name: string;
  readonly target: string;
  readonly text: Readonly<Record<string, string>>;
  readonly labels: readonly string[];
};

const ADDRESS_FIELDS = ["any_address", "from", "to", "cc", "participants"] as const;

export function parseTarget(value: string, topics: readonly string[]): Target | string {
  if (value === "private") return { kind: "private" };
  const topic = value.startsWith("topic:") ? value.slice(6) : "";
  if (!topics.includes(topic)) return "Choose one of your topics, or private.";
  return { kind: "topic", topic };
}

/** A new rule from the form, or the reason it is not one. */
export function ruleFromForm(
  source: RuleSource,
  form: RuleForm,
  picker: readonly LabelRef[],
  topics: readonly string[],
): Rule | string {
  if (form.kind !== "include" && form.kind !== "exclude") return "Choose include or exclude.";
  const allowed = fieldsFor(source);
  const labelField = source === "gmail" ? "labels" : "channels";
  const known = new Map(picker.map((l) => [l.id, l]));
  const bad: string[] = [];
  const match: Record<string, readonly unknown[]> = {};
  for (const f of ADDRESS_FIELDS) {
    if (!allowed.includes(f)) continue;
    const { values, bad: wrong } = splitAddresses(form.text[f] ?? "");
    bad.push(...wrong);
    if (values.length > 50) return "A field takes at most 50 values.";
    if (values.length > 0) match[f] = values;
  }
  const chosen = [...new Set(form.labels)].filter((id) => known.has(id)).map((id) => ({ id, name: known.get(id)?.name ?? id }));
  if (form.labels.some((id) => !known.has(id))) return `Choose ${labelField} from the list.`;
  if (chosen.length > 0) match[labelField] = chosen;
  if (bad.length > 0) return `Not an email address or domain: ${bad.slice(0, 3).join(", ")}`;
  if (Object.keys(match).length === 0) return "Fill in at least one field.";
  const name = form.name.trim().slice(0, 80);
  if (form.kind === "exclude") return { kind: "exclude", name, match: match as RuleMatch };
  const target = parseTarget(form.target, topics);
  if (typeof target === "string") return target;
  return target.kind === "private"
    ? { kind: "include", name, match: match as RuleMatch, private: true }
    : { kind: "include", name, match: match as RuleMatch, topic: target.topic };
}

/** A rule as it goes back to the database: no display-only keys. */
export function forSave(rule: Rule): Rule {
  const rest = without(rule, ["broken"]);
  const match = Object.fromEntries(
    Object.entries(rest.match).map(([k, v]) => [
      k,
      (v as readonly unknown[]).map((x) => (typeof x === "object" && x !== null ? { id: (x as LabelRef).id } : x)),
    ]),
  ) as RuleMatch;
  return { ...rest, match };
}

const swap = <T>(list: readonly T[], i: number, j: number): readonly T[] =>
  list.map((x, k) => (k === i ? list[j]! : k === j ? list[i]! : x));

/** Apply one edit. Returns the new list, or a reason. */
export function applyOp(rules: readonly Rule[], op: RuleOp): readonly Rule[] | string {
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < rules.length;
  switch (op.op) {
    case "add":
      return rules.length >= 100 ? "An account has at most 100 rules." : [...rules, op.rule];
    case "delete":
      return inRange(op.index) ? rules.filter((_, k) => k !== op.index) : "No such rule.";
    case "up":
      return inRange(op.index) && op.index > 0 ? swap(rules, op.index, op.index - 1) : "That rule is already first.";
    case "down":
      return inRange(op.index) && op.index < rules.length - 1 ? swap(rules, op.index, op.index + 1) : "That rule is already last.";
    case "target": {
      if (!inRange(op.index)) return "No such rule.";
      const r = rules[op.index]!;
      if (r.kind !== "include") return "Only an include rule has a topic.";
      const base = without(r, ["topic", "private"]);
      const next: Rule = op.target.kind === "private" ? { ...base, private: true } : { ...base, topic: op.target.topic };
      return rules.map((x, k) => (k === op.index ? next : x));
    }
  }
}

/**
 * Does this edit need the person's explicit yes after a dry-run? Anything that
 * could let MORE people see new items does (a new include rule to a topic,
 * moving a rule, a rule moved to a topic, removing any rule). Edits that only
 * narrow (a new exclude, a private rule, moving a rule to private) apply at
 * once.
 */
export function needsYes(rules: readonly Rule[], op: RuleOp): boolean {
  switch (op.op) {
    case "add":
      return op.rule.kind === "include" && op.rule.private !== true;
    case "delete":
      // Removing an exclude widens; removing an include can let items fall
      // through to a lower rule with a wider topic.
      return true;
    case "up":
    case "down":
      return true;
    case "target":
      return op.target.kind === "topic";
  }
}

/** One line in plain words for a rule (used in lists and confirmations). */
export function describeRule(rule: Rule): string {
  const parts = Object.entries(rule.match).flatMap(([field, values]) => {
    const vals = (values as readonly unknown[]).map((v) =>
      typeof v === "object" && v !== null ? ((v as LabelRef).name ?? (v as LabelRef).id) : String(v),
    );
    if (vals.length === 0) return [];
    const label = FIELD_LABEL[field] ?? field;
    return [`${label} ${vals.join(" or ")}`];
  });
  const what = parts.join(" and ");
  if (rule.kind === "exclude") return `Leave out items where ${what}`;
  return `Keep where ${what}, filed under ${rule.private ? "private (only you)" : (rule.topic ?? "?")}`;
}

export const FIELD_LABEL: Readonly<Record<string, string>> = {
  any_address: "any address (from, to or cc) is",
  from: "from is",
  to: "to is",
  cc: "cc is",
  labels: "label is",
  participants: "a participant is",
  channels: "channel is",
};
