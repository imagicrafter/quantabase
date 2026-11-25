import type { Candidate, Plan, PlannedUpdate } from "./output.js";

/**
 * Repeated facts. A re-sent copy of an email (or the same facts from another
 * source) must not add a second line saying the same thing. An added bullet
 * or paragraph whose words are near-identical to a line already on the page,
 * ignoring dates, case and punctuation, is skipped. Field changes stay.
 */

/** Share of shared words above which two lines say the same thing. */
export const SAME_SHARE = 0.8;

const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

function words(line: string): Set<string> {
  const clean = line.replace(/^\s*[-*]\s+/, "").replace(DATE, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return new Set(clean ? clean.split(" ") : []);
}

/** Share of words two texts have in common (0 to 1), ignoring dates, case and punctuation. */
export function wordShare(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

export function nearSame(a: string, b: string): boolean {
  if (words(a).size < 3 || words(b).size < 3) return false;
  return wordShare(a, b) >= SAME_SHARE;
}

type Patch = PlannedUpdate["patches"][number];

const isAdd = (p: Patch): p is Patch & { readonly text: string } =>
  (p.op === "append-bullet" || p.op === "append-paragraph") && typeof (p as { text?: unknown }).text === "string";

function keep(update: PlannedUpdate, body: string): PlannedUpdate {
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  const added: string[] = [];
  const patches = update.patches.filter((p) => {
    if (!isAdd(p)) return true;
    const repeat = [...lines, ...added].some((l) => nearSame(p.text, l));
    if (!repeat) added.push(p.text);
    return !repeat;
  });
  return { ...update, patches };
}

/** The plan with repeated lines dropped from updates to shortlist pages. */
export function dropRepeats<P extends Pick<Plan, "updates">>(plan: P, shortlist: readonly Pick<Candidate, "key" | "body">[]): P {
  return {
    ...plan,
    updates: plan.updates.map((u) => {
      const page = shortlist.find((p) => p.key === u.key);
      return page ? keep(u, page.body) : u;
    }),
  };
}
