import type { ItemResult } from "../curator/curate.js";
import { DEFAULT_TRIAGE } from "../curator/model.js";
import { mergeUsage, totalUsd, type Usage } from "../curator/usage.js";

/**
 * The A/B harness's command line (scripts/eval/curator_ab.ts) and its run
 * statistics. The flags set up the same pipeline the curator runs in
 * production (consensus, tiebreak model, strong model, output limit), so no
 * wrapper script is needed.
 */

export const DEFAULT_PRIMARY = "openai-gpt-oss-120b";
export const DEFAULT_TIEBREAK = "deepseek-v4.1-flash";

export type AbArgs = {
  readonly items: string;
  readonly pages: string;
  readonly out: string;
  readonly other?: string;
  readonly templates: readonly string[];
  readonly mock: boolean;
  readonly model: string;
  /** Two primary runs, then a tiebreak when they disagree (as curator_settings.consensus). */
  readonly consensus: boolean;
  readonly tiebreakModel: string;
  /** The strong model for judgement drawers and low agreement; none when not given. */
  readonly strongModel?: string;
  /** Output tokens for every model; each model's own limit when not given. */
  readonly maxTokens?: number;
  /** The single writer (as curator_settings with consensus off); the old single run when not given. */
  readonly writerModel?: string;
  /** Triage before the writer (default on). */
  readonly triage: boolean;
  readonly triageModel: string;
  /** Account users as "Name <email>" (--account, repeatable): never a person page. */
  readonly accounts: readonly { readonly email: string | null; readonly name: string | null }[];
};

function value(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
}

function need(argv: readonly string[], name: string): string {
  const v = value(argv, name);
  if (!v) throw new Error(`--${name} is required (see the header of scripts/eval/curator_ab.ts)`);
  return v;
}

function tokens(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 256 || n > 65536) throw new Error("--max-tokens must be a whole number from 256 to 65536");
  return n;
}

function onOff(raw: string | undefined): boolean {
  if (raw === undefined || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error("--triage must be on or off");
}

/** Parse the harness flags. Model names may also come from KBE_MODEL / KBE_STRONG_MODEL (env). */
export function parseAbArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): AbArgs {
  const strong = value(argv, "strong-model") ?? env["KBE_STRONG_MODEL"];
  const other = value(argv, "other");
  const maxTokens = tokens(value(argv, "max-tokens"));
  const writer = value(argv, "writer-model");
  return {
    items: need(argv, "items"),
    pages: need(argv, "pages"),
    out: need(argv, "out"),
    ...(other ? { other } : {}),
    templates: (value(argv, "templates") ?? "").split(",").filter(Boolean),
    mock: argv.includes("--mock"),
    model: value(argv, "model") ?? env["KBE_MODEL"] ?? DEFAULT_PRIMARY,
    consensus: argv.includes("--consensus"),
    tiebreakModel: value(argv, "tiebreak-model") ?? DEFAULT_TIEBREAK,
    ...(strong ? { strongModel: strong } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(writer ? { writerModel: writer } : {}),
    triage: onOff(value(argv, "triage")),
    triageModel: value(argv, "triage-model") ?? DEFAULT_TRIAGE,
    accounts: accountsOf(argv),
  };
}

/** Every --account "Name <email>" (or a bare name or email). */
export function accountsOf(argv: readonly string[]): { readonly email: string | null; readonly name: string | null }[] {
  return argv.flatMap((a, i) => (a === "--account" && argv[i + 1] !== undefined ? [argv[i + 1]!] : [])).map((raw) => {
    const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw.trim());
    if (m) return { name: m[1]!.trim() || null, email: m[2]!.trim().toLowerCase() };
    return raw.includes("@") ? { name: null, email: raw.trim().toLowerCase() } : { name: raw.trim(), email: null };
  });
}

export type AbRow = ItemResult & { readonly id: string };

export type AbStats = {
  readonly items: number;
  readonly failed: number;
  readonly by_outcome: Record<string, number>;
  readonly by_consensus: Record<string, number>;
  /** Items whose two primary runs agreed outright, of the items consensus ran on. */
  readonly agree_rate: number | null;
  /** Mean share of decisions the primary runs agreed on. */
  readonly mean_agreement: number | null;
  readonly escalated: number;
  readonly dropped: number;
  readonly repaired: number;
  readonly tokens: number;
  /** USD over every item, from the price table (prices.ts). */
  readonly usd: number;
  readonly usd_per_item: number | null;
  /** Items triage stopped as having nothing durable. */
  readonly triage_no_change: number;
  /** Tokens and USD per model. */
  readonly by_model: Usage;
};

const count = (xs: readonly string[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Run statistics over the item results; "agree rate" counts items with two primary runs. */
export function abStats(rows: readonly AbRow[]): AbStats {
  const byModel = rows.reduce<Usage>((u, r) => mergeUsage(u, r.usage ?? {}), {});
  const voted = rows.filter((r) => r.consensus !== undefined && r.consensus !== "single" && r.agreement !== undefined);
  return {
    items: rows.length,
    failed: rows.filter((r) => r.outcome === "failed").length,
    by_outcome: count(rows.map((r) => r.outcome)),
    by_consensus: count(rows.flatMap((r) => (r.consensus ? [r.consensus] : []))),
    agree_rate: voted.length === 0 ? null : voted.filter((r) => r.consensus === "agreed").length / voted.length,
    mean_agreement: mean(voted.map((r) => r.agreement!)),
    escalated: rows.filter((r) => r.escalated).length,
    dropped: rows.reduce((n, r) => n + (r.dropped?.length ?? 0), 0),
    repaired: rows.reduce((n, r) => n + (r.repaired?.length ?? 0), 0),
    tokens: rows.reduce((n, r) => n + (r.tokens ?? 0), 0),
    usd: totalUsd(byModel),
    usd_per_item: rows.length === 0 ? null : totalUsd(byModel) / rows.length,
    triage_no_change: rows.filter((r) => r.triaged).length,
    by_model: byModel,
  };
}
