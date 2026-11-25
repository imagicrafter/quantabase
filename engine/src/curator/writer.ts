import { logger } from "../log/logger.js";
import { accountPeople } from "./accounts.js";
import type { CurateDeps } from "./curate.js";
import { MAX_OUTPUT_TOKENS, OUTPUT_TOKENS_CEILING, type ModelBackend, type ModelReply } from "./model.js";
import { checkReply, extractJsonObject, type CheckResult } from "./output.js";
import type { IndexRow } from "./page-index.js";
import { buildWriterPrompt, writerSystem } from "./prompt.js";
import type { ClaimedItem, PageRow } from "./store.js";
import { noteOf, withNoteHints } from "./session-note.js";
import { NOTE_MAX_CHARS } from "../sources/session-note.js";
import { MAX_TARGETS, TRIAGE_SYSTEM, buildTriagePrompt, itemLines, parseTriage, writerSource, type Triage } from "./triage.js";
import { addUsage, emptyUsage, mergeUsage, type Usage } from "./usage.js";

/**
 * The default curator (consensus off): an optional cheap triage, then one
 * strong writer that sees only what it needs. The writer reads the pages
 * triage pointed to (plus pages the item's own addresses match), a short
 * list of other page titles, and the item whole when short or as triage's
 * excerpts and summary when long. Its system prompt holds everything that
 * depends only on the templates, so the provider caches it across items.
 */

/** Pages whose key, address or alias the item names: always shown, whatever triage said. */
const STRONG_MATCH = new Set(["key", "identity", "alias"]);

export type Written =
  | { readonly stop: true; readonly reason: string; readonly usage: Usage }
  | {
      readonly stop: false;
      readonly checked: CheckResult;
      readonly pages: readonly PageRow[];
      readonly usage: Usage;
      readonly note: string;
    };

function asIndexRow(p: PageRow): IndexRow {
  return {
    key: p.key, drawer: p.drawer, title: p.title, aliases: p.aliases, description: p.description,
    identities: [], score: 1, matched_on: p.matched_on || "search",
  };
}

/** Triage over the matched pages and the index; null when it failed or could not be read. */
async function runTriage(
  item: ClaimedItem, shortlist: readonly PageRow[], index: readonly IndexRow[], deps: CurateDeps, t: { readonly model: ModelBackend; readonly name: string },
): Promise<{ readonly triage: Triage | null; readonly usage: Usage; readonly rows: readonly IndexRow[] }> {
  const seen = new Set<string>();
  const rows = [...shortlist.map(asIndexRow), ...index].filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  try {
    const reply = await t.model.complete(TRIAGE_SYSTEM, buildTriagePrompt(item, rows, deps.schema, undefined, deps.tuning?.deskEditor));
    const usage = addUsage(emptyUsage(), t.name, reply);
    const triage = reply.finish === "length" ? null : parseTriage(reply.text, {
      keys: rows.map((r) => r.key), drawers: deps.schema.drawers.map((d) => d.id), lines: itemLines(item.body).length,
    });
    if (!triage) logger.warn({ item: item.id, model: t.name }, "curator: triage reply not usable; the writer reads the item as is");
    return { triage, usage, rows };
  } catch (err) {
    logger.warn({ item: item.id, model: t.name, error: err instanceof Error ? err.message : "error" }, "curator: triage failed; the writer reads the item as is");
    return { triage: null, usage: emptyUsage(), rows };
  }
}

/** The pages the writer reads: strong matches first, then triage's targets; without triage, the shortlist. */
async function pagesFor(
  shortlist: readonly PageRow[], triage: Triage | null, lookup: (key: string) => Promise<PageRow | null>,
): Promise<PageRow[]> {
  if (!triage) return [...shortlist];
  const out: PageRow[] = shortlist.filter((p) => STRONG_MATCH.has(p.matched_on));
  for (const key of triage.targets) {
    if (out.length >= MAX_TARGETS + 2) break;
    if (out.some((p) => p.key === key)) continue;
    const page = shortlist.find((p) => p.key === key) ?? (await lookup(key).catch(() => null));
    if (page) out.push(page);
  }
  return out;
}

async function complete(model: ModelBackend, name: string, system: string, user: string, item: ClaimedItem): Promise<{ reply: ModelReply; usage: Usage }> {
  let reply = await model.complete(system, user);
  let usage = addUsage(emptyUsage(), name, reply);
  if (reply.finish === "length") {
    const first = model.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
    const more = Math.min(first * 2, OUTPUT_TOKENS_CEILING);
    logger.warn({ item: item.id, model: name, max_tokens: first, retry_with: more }, "curator: model reply cut off; asking once more");
    reply = await model.complete(system, user, more);
    usage = addUsage(usage, name, reply);
  }
  return { reply, usage };
}

/** Pages the reply updates that were only in the index (shown by title), read by key. */
async function indexPagesNamed(
  raw: string, shown: readonly PageRow[], index: readonly IndexRow[], lookup: (key: string) => Promise<PageRow | null>,
): Promise<PageRow[]> {
  let keys: string[] = [];
  try {
    const v = JSON.parse(extractJsonObject(raw)) as { updates?: Array<{ key?: unknown }> };
    keys = (v.updates ?? []).map((u) => (typeof u.key === "string" ? u.key.trim().toLowerCase() : "")).filter((k) => k !== "");
  } catch {
    return [];
  }
  const want = [...new Set(keys)].filter((k) => !shown.some((p) => p.key.toLowerCase() === k) && index.some((r) => r.key.toLowerCase() === k));
  const found = await Promise.all(want.slice(0, MAX_TARGETS).map((k) => lookup(k).catch(() => null)));
  return found.filter((p): p is PageRow => p !== null);
}

export async function writeItem(
  item: ClaimedItem,
  shortlist: readonly PageRow[],
  index: readonly IndexRow[],
  deps: CurateDeps,
  lookup: (key: string) => Promise<PageRow | null>,
): Promise<Written> {
  const t = deps.writer?.triage;
  const tri = t ? await runTriage(item, shortlist, index, deps, t) : { triage: null, usage: emptyUsage(), rows: index };
  // A session note is kept, and its page hints lead (curator/session-note.ts).
  const note = noteOf(item);
  const triage = note ? withNoteHints(note, tri.triage, deps.schema.drawers.map((d) => d.id)) : tri.triage;
  if (triage && !triage.durable) {
    return { stop: true, reason: `triage: ${triage.reason || "nothing durable"}`, usage: tri.usage };
  }
  const pages = await pagesFor(shortlist, triage, lookup);
  const source = writerSource(item.body, triage?.ranges ?? [], note ? NOTE_MAX_CHARS : undefined);
  const user = buildWriterPrompt({
    item, pages, index: tri.rows, schema: deps.schema, source: source.text, excerpted: source.excerpted,
    ...(triage?.summary ? { summary: triage.summary } : {}),
    ...(triage ? { expected: triage.newPages } : {}),
    people: accountPeople(deps.people ?? [], item.owner_email),
  });
  let usage = tri.usage;
  try {
    const done = await complete(deps.model, deps.modelName, writerSystem(deps.schema), user, item);
    usage = mergeUsage(usage, done.usage);
    if (done.reply.finish === "length") {
      return { stop: false, pages, usage, note: "writer", checked: { ok: false, reason: "the model reply was cut off twice (finish_reason=length)" } };
    }
    const ctx = (shown: readonly PageRow[]) => ({
      shortlist: shown, schema: deps.schema, sourceText: `${item.title ?? ""}\n${item.body}`,
      indexKeys: tri.rows.map((r) => r.key), index: tri.rows,
    });
    let checked = checkReply(done.reply.text, ctx(pages));
    // An update to a page the writer saw only in the index is not lost: the
    // page is read and the reply checked again against it (round 4).
    const extra = await indexPagesNamed(done.reply.text, pages, tri.rows, lookup);
    const shown = extra.length > 0 ? [...pages, ...extra] : pages;
    if (extra.length > 0) checked = checkReply(done.reply.text, ctx(shown));
    const how = note ? `session note (${pages.length} pages)` : triage ? `triage kept it (${pages.length} pages${source.excerpted ? ", excerpts" : ""})` : t ? "triage unusable" : "no triage";
    return { stop: false, checked, pages: shown, usage, note: `writer ${deps.modelName}; ${how}${extra.length > 0 ? `; ${extra.length} index pages read` : ""}` };
  } catch (err) {
    return { stop: false, pages, usage, note: "writer", checked: { ok: false, reason: err instanceof Error ? err.message : "model call failed" } };
  }
}
