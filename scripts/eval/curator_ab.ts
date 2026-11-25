/**
 * Blind A/B harness: the Engine's curator against /update-docs wiki.
 *
 *   cd engine && npx tsx ../scripts/eval/curator_ab.ts \
 *     --items DIR --pages pages.json --out OUT [--other DIR] [--templates consulting] \
 *     [--model NAME] [--consensus] [--tiebreak-model NAME] [--strong-model NAME] \
 *     [--max-tokens N] [--writer-model NAME] [--triage on|off] [--triage-model NAME]
 *     [--account "Name <email>"]... [--mock]
 *
 *   --items          a folder of source items, one JSON file each:
 *                    {"id", "title", "body", "source"?, "source_created_at"?, "owner_email"?}
 *   --pages          the page snapshot: a JSON list of {"key", "drawer", "title", "body",
 *                    "aliases"?, "description"?, "fields"?}. Every item is curated against
 *                    this same snapshot; nothing is saved anywhere.
 *   --out            where OUT/curator/<id>.md and OUT/stats.json are written
 *   --other          a folder of <id>.md written by /update-docs wiki for the same items:
 *                    then OUT/blind/<id>.md pairs both as Version A / Version B in a random
 *                    order, and OUT/blind-key.json (kept away from the reader) says which is which
 *   --model          the primary model (default KBE_MODEL, else openai-gpt-oss-120b)
 *   --consensus      two primary runs per item, and a tiebreak run when they disagree,
 *                    exactly as the curator runs with curator_settings.consensus on
 *   --tiebreak-model the tiebreak model (default deepseek-v4.1-flash)
 *   --strong-model   the strong model for judgement drawers and low agreement
 *                    (default KBE_STRONG_MODEL; none when neither is set)
 *   --max-tokens     output tokens for every model (default: each model's own limit,
 *                    engine/src/curator/model.ts)
 *   --writer-model   the single writer, as the curator runs with consensus off
 *                    (anthropic-claude-sonnet-5.5 or anthropic-claude-5.5-haiku); without
 *                    it, --model runs the older single prompt (or consensus)
 *   --triage         on (default) or off: a cheap first read before the writer
 *   --triage-model   the triage model (default openai-gpt-oss-120b)
 *   --account        an account user ("Name <email>", repeatable), as the Engine reads
 *                    them from workspace.principals: never given a person page. The
 *                    item's owner_email always counts.
 *   --mock           no model call: every item answers "no change" (to check the wiring)
 *
 * OUT/stats.json holds each item's outcome, consensus label, agreement, routing,
 * what was left out or repaired, tokens and USD per model (engine prices.ts),
 * and the totals (agree rate, failures, tokens, USD, USD per item).
 *
 * Live runs call DigitalOcean with the key in KBE_MODEL_KEY (set it in your own
 * shell; it is never read from a file or printed).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import type { EvalItem, SnapshotPage } from "../../engine/src/eval/ab.js";
import type { ModelBackend } from "../../engine/src/curator/model.js";

// The Engine's modules check their service settings when loaded. This
// harness never reaches the database, so placeholders are enough.
for (const [name, value] of [
  ["SUPABASE_URL", "https://eval.invalid"],
  ["SUPABASE_JWT_SECRET", "eval-harness-placeholder-not-a-secret"],
  ["SUPABASE_ANON_KEY", "eval-harness-placeholder"],
] as const) process.env[name] ??= value;

const MOCK: ModelBackend = {
  complete: async () => ({ text: '{"updates":[],"new_pages":[],"notes":"mock run"}', finish: "stop", inputTokens: 0, outputTokens: 0 }),
};

async function main(): Promise<void> {
  const { blindPair, runAbDetailed } = await import("../../engine/src/eval/ab.js");
  const { abStats, parseAbArgs } = await import("../../engine/src/eval/ab-args.js");
  const { doInference } = await import("../../engine/src/curator/model.js");
  const { entitySchema } = await import("../../engine/src/entities/templates.js");
  const args = parseAbArgs(process.argv.slice(2), process.env);
  const pages = JSON.parse(readFileSync(args.pages, "utf8")) as SnapshotPage[];
  const items = readdirSync(args.items).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(args.items, f), "utf8")) as EvalItem);
  const schema = entitySchema(args.templates);
  const key = process.env["KBE_MODEL_KEY"] ?? "";
  if (!args.mock && !key) throw new Error("set KBE_MODEL_KEY in your shell, or pass --mock");
  const opts = args.maxTokens !== undefined ? { maxOutputTokens: args.maxTokens } : {};
  const make = (name: string): ModelBackend => (args.mock ? MOCK : doInference(name, key, opts));
  const writer = args.writerModel && !args.consensus ? args.writerModel : undefined;
  const { markdown, results } = await runAbDetailed(items, pages, writer
    ? {
        schema, modelName: writer, model: make(writer),
        writer: args.triage ? { triage: { model: make(args.triageModel), name: args.triageModel } } : {},
        people: args.accounts,
      }
    : {
        schema, modelName: args.model, model: make(args.model),
        ...(args.consensus ? { consensus: { tiebreak: make(args.tiebreakModel), tiebreakName: args.tiebreakModel } } : {}),
        ...(args.strongModel ? { strong: { model: make(args.strongModel), name: args.strongModel } } : {}),
      });
  mkdirSync(join(args.out, "curator"), { recursive: true });
  for (const [id, md] of markdown) writeFileSync(join(args.out, "curator", `${id}.md`), md);
  const setup = {
    model: args.model, consensus: args.consensus, tiebreak_model: args.consensus ? args.tiebreakModel : null,
    strong_model: args.strongModel ?? null, max_tokens: args.maxTokens ?? null, templates: args.templates,
    writer_model: writer ?? null, triage_model: writer && args.triage ? args.triageModel : null,
  };
  writeFileSync(join(args.out, "stats.json"), JSON.stringify({ setup, totals: abStats(results), items: results }, null, 2));
  if (args.other) {
    mkdirSync(join(args.out, "blind"), { recursive: true });
    const keyFile: Record<string, string> = {};
    for (const [id, md] of markdown) {
      let other: string;
      try {
        other = readFileSync(join(args.other, `${id}.md`), "utf8");
      } catch {
        continue;
      }
      const pair = blindPair(id, md, other, randomInt(2) === 1);
      writeFileSync(join(args.out, "blind", `${id}.md`), pair.text);
      keyFile[id] = pair.key;
    }
    writeFileSync(join(args.out, "blind-key.json"), JSON.stringify(keyFile, null, 2));
  }
  const t = abStats(results);
  const rate = t.agree_rate === null ? "n/a" : `${Math.round(t.agree_rate * 100)}%`;
  const cost = `$${t.usd.toFixed(4)}${t.usd_per_item === null ? "" : `, $${t.usd_per_item.toFixed(4)} per item`}`;
  process.stdout.write(`curated ${markdown.size} items into ${args.out} (failed ${t.failed}, agree rate ${rate}, cost ${cost})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`curator_ab: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
