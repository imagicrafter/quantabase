/**
 * DigitalOcean serverless inference list prices, USD per million tokens.
 * Source: PRICES_SOURCE, read on PRICES_AS_OF (the page's own last_updated
 * was 2026-11-18). When DigitalOcean changes a price, change it here and the
 * date with it. Used only to report cost (run stats, the Indexing screen);
 * nothing is billed from it, and the invoice is the final word.
 *
 * A model without a cache price is charged its input rate for cache reads
 * and writes (DigitalOcean lists none, so none are expected).
 */

export const PRICES_SOURCE = "https://docs.digitalocean.com/products/inference/details/pricing/";
export const PRICES_AS_OF = "2026-11-22";

export type Price = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Rates for a call whose input is above `above` tokens (Haiku's long context). */
  readonly long?: { readonly above: number; readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number };
};

export const MODEL_PRICES: Readonly<Record<string, Price>> = {
  "openai-gpt-oss-120b": { input: 0.1, output: 0.7 },
  "deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48, cacheRead: 0.348 },
  "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "anthropic-claude-sonnet-5.5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  "anthropic-claude-5.5-haiku": {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
};

export type Tokens = { readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number };

/** USD for one call (or a sum of calls at one rate); null for a model not in the table. */
export function costOf(model: string, t: Tokens): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const total = t.input + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
  const r = p.long && total > p.long.above ? p.long : p;
  const read = r.cacheRead ?? r.input;
  const write = r.cacheWrite ?? r.input;
  return (t.input * r.input + t.output * r.output + (t.cacheRead ?? 0) * read + (t.cacheWrite ?? 0) * write) / 1_000_000;
}
