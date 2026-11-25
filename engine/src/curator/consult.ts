import { agree, agreement, decisionsOf, merge, type Uncertain, type VoteContext } from "./consensus.js";
import type { CurateDeps } from "./curate.js";
import type { CheckResult, Plan } from "./output.js";
import { emptyUsage, mergeUsage, type Usage } from "./usage.js";

/**
 * How one item's decisions are reached. Consensus off: one run. On: two
 * primary runs in parallel; if their decisions agree, run 1 is used; if not,
 * one tiebreak run and a majority per decision (consensus.ts). A decision
 * with no majority is dropped (never queued) and returned as uncertain.
 */

export type ConsultLabel = "single" | "agreed" | "tiebreak" | "uncertain";

export type Asked = CheckResult & { readonly tokens: number; readonly usage?: Usage };
export type Ask = (deps: CurateDeps, note?: string) => Promise<Asked>;

export type Consulted = {
  readonly result: CheckResult;
  readonly label: ConsultLabel;
  readonly uncertain: readonly Uncertain[];
  readonly tokens: number;
  /** Tokens and USD per model over every run asked. */
  readonly usage: Usage;
  /** Consensus on: share of decisions the two primary runs agreed on (consensus.ts agreement). */
  readonly agreement?: number;
  /** Consensus on and a tiebreak was asked: whether its reply was usable. */
  readonly tiebreakOk?: boolean;
};

const plans = (runs: readonly Asked[]): Plan[] => runs.flatMap((r) => (r.ok ? [r.plan] : []));

export async function consult(deps: CurateDeps, ask: Ask, ctx?: VoteContext): Promise<Consulted> {
  if (!deps.consensus) {
    const one = await ask(deps);
    return { result: one, label: "single", uncertain: [], tokens: one.tokens, usage: one.usage ?? emptyUsage() };
  }
  const [a, b] = await Promise.all([ask(deps), ask(deps)]);
  let tokens = a.tokens + b.tokens;
  let usage = mergeUsage(a.usage ?? emptyUsage(), b.usage ?? emptyUsage());
  // Share of decisions the two primary runs agree on; 0 when either failed.
  const share = a.ok && b.ok ? agreement(decisionsOf(a.plan, ctx), decisionsOf(b.plan, ctx)) : 0;
  if (a.ok && b.ok && agree(decisionsOf(a.plan, ctx), decisionsOf(b.plan, ctx))) {
    return { result: a, label: "agreed", uncertain: [], tokens, usage, agreement: share };
  }
  // A tiebreak reply that was cut off is a failed run (ask), never parsed.
  const c = await ask({ ...deps, model: deps.consensus.tiebreak, modelName: deps.consensus.tiebreakName });
  tokens += c.tokens;
  usage = mergeUsage(usage, c.usage ?? emptyUsage());
  const ok = plans([a, b, c]);
  const base = { label: "tiebreak" as const, uncertain: [], tokens, usage, agreement: share, tiebreakOk: c.ok };
  if (ok.length === 0) return { ...base, result: a };
  if (ok.length === 1) return { ...base, result: { ok: true, plan: ok[0]! } };
  const merged = merge(ok, ctx);
  return {
    ...base,
    result: { ok: true, plan: merged.plan },
    label: merged.uncertain.length > 0 ? "uncertain" : "tiebreak",
    uncertain: merged.uncertain,
  };
}
