import { costOf } from "./prices.js";
import type { ModelReply } from "./model.js";

/**
 * Tokens and USD per model, for one item or one run. Immutable: every
 * function returns a new object. USD is priced per call (prices.ts), so a
 * long-context rate applies only to the calls that crossed it.
 */

export type ModelUsage = {
  readonly calls: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** null when the model is not in the price table. */
  readonly usd: number | null;
};

export type Usage = Readonly<Record<string, ModelUsage>>;

export const emptyUsage = (): Usage => ({});

type Counted = Pick<ModelReply, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;

const plus = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

export function addUsage(u: Usage, model: string, reply: Counted): Usage {
  const call = {
    input: reply.inputTokens ?? 0,
    output: reply.outputTokens ?? 0,
    cacheRead: reply.cacheReadTokens ?? 0,
    cacheWrite: reply.cacheWriteTokens ?? 0,
  };
  const before = u[model] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  return {
    ...u,
    [model]: {
      calls: before.calls + 1,
      input: before.input + call.input,
      output: before.output + call.output,
      cacheRead: before.cacheRead + call.cacheRead,
      cacheWrite: before.cacheWrite + call.cacheWrite,
      usd: plus(before.usd, costOf(model, call)),
    },
  };
}

export function mergeUsage(a: Usage, b: Usage): Usage {
  const out: Record<string, ModelUsage> = { ...a };
  for (const [m, x] of Object.entries(b)) {
    const y = out[m];
    out[m] = y
      ? {
          calls: y.calls + x.calls, input: y.input + x.input, output: y.output + x.output,
          cacheRead: y.cacheRead + x.cacheRead, cacheWrite: y.cacheWrite + x.cacheWrite, usd: plus(y.usd, x.usd),
        }
      : x;
  }
  return out;
}

/** Sum of the priced models (an unpriced model adds nothing). */
export function totalUsd(u: Usage): number {
  return Object.values(u).reduce((n, m) => n + (m.usd ?? 0), 0);
}

/** Total input + output tokens. */
export function totalTokens(u: Usage): number {
  return Object.values(u).reduce((n, m) => n + m.input + m.output + m.cacheRead + m.cacheWrite, 0);
}

const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/** Flat run-stat keys: tokens_in:<model>, tokens_out:<model>, cache_read:<model>, cache_write:<model>, usd:<model>, usd. */
export function usageStats(u: Usage): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [m, x] of Object.entries(u)) {
    out[`tokens_in:${m}`] = x.input;
    out[`tokens_out:${m}`] = x.output;
    if (x.cacheRead > 0) out[`cache_read:${m}`] = x.cacheRead;
    if (x.cacheWrite > 0) out[`cache_write:${m}`] = x.cacheWrite;
    if (x.usd !== null) out[`usd:${m}`] = round(x.usd);
  }
  out["usd"] = round(totalUsd(u));
  return out;
}
