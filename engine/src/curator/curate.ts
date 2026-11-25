import type { EntitySchema } from "../entities/templates.js";
import { alreadyHas, newPage, sourceRef, updatedPage, withUpdateLine, type Generated } from "./apply.js";
import { inline, screen } from "./guard.js";
import { itemKeys, sourceKeyRules } from "./keys.js";
import { MAX_OUTPUT_TOKENS, OUTPUT_TOKENS_CEILING, type ModelBackend } from "./model.js";
import { checkReply, eventsRule, type CheckResult, type PlannedNewPage, type PlannedUpdate } from "./output.js";
import { judgeNewPage, judgeUpdate } from "./policy.js";
import { removalShare, type Tuning } from "./tuning.js";
import { dropRepeats } from "./dedupe.js";
import { normKey, resolveCreates } from "./resolve.js";
import { consult, type ConsultLabel } from "./consult.js";
import { preferOpen } from "./consensus.js";
import { logger } from "../log/logger.js";
import { SYSTEM_PROMPT, buildPrompt, itemDate, requiredHint } from "./prompt.js";
import { StoreError, type ClaimedItem, type PageRow, type Store } from "./store.js";
import { INDEX_ROWS, type IndexRow } from "./page-index.js";
import { rulesOf, strongRouting } from "./quality.js";
import { acceptedIdentities } from "./identity.js";
import { fileByName } from "./namematch.js";
import { writeItem } from "./writer.js";
import { accountPeople, dropAccountPages, ownerPerson, type AccountPerson } from "./accounts.js";
import { factCheck } from "./factcheck.js";
import { factSource } from "./session-note.js";
import { addUsage, emptyUsage, mergeUsage, totalTokens, totalUsd, type Usage } from "./usage.js";

/**
 * One item through the curator: screen, match, ask, check, apply or queue,
 * close. Every write goes through the 0053 functions, which hold the item to
 * its owner's pages and its own topics whatever happens here.
 *
 * Two ways to decide (curator_settings.consensus, 0069 default off):
 *   off  one strong writer, after an optional cheap triage (writer.ts)
 *   on   consensus runs, tiebreak and strong-model routing (consult.ts)
 * A template's required_when pattern is a hint in the prompt, never a failure.
 */

export type CurateDeps = {
  readonly store: Store;
  readonly model: ModelBackend;
  readonly modelName: string;
  readonly schema: EntitySchema;
  readonly now: () => Date;
  /** Consensus curation: present when on (curator_settings.consensus). */
  readonly consensus?: { readonly tiebreak: ModelBackend; readonly tiebreakName: string };
  /** The strong model (curator_settings.strong_model): judgement drawers and uncertain items. */
  readonly strong?: { readonly model: ModelBackend; readonly name: string };
  /** Embeds text for the page index and name matching; keyword-only without it. */
  readonly embed?: (text: string) => Promise<number[]>;
  /**
   * The single-writer curator (consensus off): `model` is the writer, and
   * `triage`, when set, reads every item first (writer.ts).
   */
  readonly writer?: { readonly triage?: { readonly model: ModelBackend; readonly name: string } };
  /**
   * The Engine's owner and account users (curator_account_people, 0070):
   * never given a person page. The item's owner is always added.
   */
  readonly people?: readonly AccountPerson[];
  /** The owner's safe choices from the Pipeline screen (tuning.ts, 0071). Absent: the defaults. */
  readonly tuning?: Tuning;
};

export type ItemOutcome = "flagged" | "applied" | "queued" | "mixed" | "no_change" | "failed";

export type ItemResult = {
  readonly outcome: ItemOutcome;
  readonly pages: readonly string[];
  readonly queued: number;
  readonly reason?: string;
  /** single (consensus off), agreed, tiebreak or uncertain. */
  readonly consensus?: ConsultLabel;
  /** Model tokens (input + output, cache included) spent on this item. */
  readonly tokens?: number;
  /** The strong model decided this item. */
  readonly escalated?: boolean;
  /** Consensus on: share of decisions the two primary runs agreed on, 0 to 1. */
  readonly agreement?: number;
  /** Why the strong model was, or was not, asked (or how the writer was fed). */
  readonly routing?: string;
  /** Patches, fields, links or pages left out of the reply, one line each with why (output.ts). */
  readonly dropped?: readonly string[];
  /** Patches and keys rewritten to fit (a section the page lacks, a loose key). */
  readonly repaired?: readonly string[];
  /** Tokens and USD per model spent on this item (usage.ts). */
  readonly usage?: Usage;
  /** USD spent on this item, from the price table (prices.ts). */
  readonly usd?: number;
  /** Triage stopped the item: nothing durable. */
  readonly triaged?: boolean;
};

const SHORTLIST_SIZE = 8;

function outcomeOf(applied: number, queued: number): ItemOutcome {
  if (applied > 0 && queued > 0) return "mixed";
  if (applied > 0) return "applied";
  if (queued > 0) return "queued";
  return "no_change";
}

function searchText(item: ClaimedItem): string {
  return inline(item.title ?? "", 200).replace(/[^\p{L}\p{N}\s.@-]/gu, " ");
}

type Step = { readonly applied: readonly string[]; readonly queued: number };

/**
 * A save the database refused with 22023 (invalid value: a stale hash, a
 * topic or key rule). Logged with the item id and the database's own
 * message (fixed texts, never page keys, page or mail content), so a failure
 * can be diagnosed from the log alone.
 */
function refused(err: unknown, item: ClaimedItem): err is StoreError {
  if (!(err instanceof StoreError) || err.code !== "22023") return false;
  logger.warn({ item: item.id, fn: err.fn, code: err.code, error: err.message }, "curator: save refused");
  return true;
}

/**
 * Queue a change for the owner's yes. Counts as queued only when a review
 * row was made: a repeat of an open review is ignored by the database and
 * the log says so, so the run summary and the log never disagree.
 */
async function toReview(item: ClaimedItem, deps: CurateDeps, args: Parameters<Store["queueReview"]>[0]): Promise<Step> {
  const id = await deps.store.queueReview(args);
  if (id) logger.info({ item: item.id, review: id, kind: args.kind }, "curator: change sent for review");
  else logger.info({ item: item.id, kind: args.kind }, "curator: change already waiting for review");
  return { applied: [], queued: id ? 1 : 0 };
}

type Identity = { readonly field: string; readonly add: readonly string[] };

/** The identities of an update the item clearly ties to the page (identity.ts); refusals are logged. */
function identityFor(item: ClaimedItem, u: PlannedUpdate, page: PageRow, deps: CurateDeps): Identity | undefined {
  if (!u.identities || u.identities.length === 0) return undefined;
  const drawer = deps.schema.drawers.find((d) => d.id === page.drawer);
  const got = acceptedIdentities(u.identities, page, drawer, `${item.title ?? ""}\n${item.body}`);
  if (got.refused.length > 0) logger.info({ item: item.id, refused: got.refused.map((r) => r.why) }, "curator: identities not added");
  const field = drawer?.key_rule.identities;
  return field && got.add.length > 0 ? { field, add: got.add } : undefined;
}

/** The page with its dated updates line (rules.page_shape), when the reply gave one. */
function shaped(page: Record<string, unknown>, line: string | undefined, item: ClaimedItem, deps: CurateDeps): Record<string, unknown> {
  const shape = rulesOf(deps.schema).pageShape;
  if (!shape || !line || typeof page["body"] !== "string") return page;
  return { ...page, body: withUpdateLine(page["body"], { heading: shape.updatesHeading, max: shape.updatesMax, date: itemDate(item), text: line }) };
}

async function handleUpdate(item: ClaimedItem, u: PlannedUpdate, page: PageRow, deps: CurateDeps, gen: Generated, identity?: Identity): Promise<Step> {
  const ref = sourceRef(item);
  const verdict = judgeUpdate(u, page, deps.schema, item.released, removalShare(deps.tuning?.publisherAsk));
  let reasons: readonly string[] = verdict.apply ? [] : verdict.reasons;
  if (verdict.apply) {
    try {
      const next = shaped(updatedPage(page, u, ref, gen, identity), u.update_line, item, deps);
      const saved = await deps.store.savePage(item.id, next, page.content_hash);
      return { applied: [saved.id], queued: 0 };
    } catch (err) {
      // The database refused this change (the page changed since it was
      // read, a rule on the page): a person decides; the item does not fail.
      if (!refused(err, item)) throw err;
      reasons = [`could not apply: ${err.message}`];
    }
  }
  return toReview(item, deps, {
    itemId: item.id,
    pageId: page.id,
    pageKey: page.key,
    kind: "update",
    reasons,
    proposal: { ref, generated: gen, update: { key: u.key, patches: u.patches, fields: u.fields, related: u.related } },
    baseHash: page.content_hash,
  });
}

async function handleNewPage(item: ClaimedItem, n: PlannedNewPage, deps: CurateDeps, gen: Generated): Promise<Step> {
  const drawer = deps.schema.drawers.find((d) => d.id === n.drawer);
  const page = shaped(newPage(n, drawer?.sections ?? [], item.topics, sourceRef(item), gen), n.update_line, item, deps);
  const verdict = judgeNewPage(n, deps.schema, item.released);
  if (verdict.apply) {
    try {
      const saved = await deps.store.savePage(item.id, page, null);
      return { applied: [saved.id], queued: 0 };
    } catch (err) {
      // Creates on a key the owner already has in these topics became
      // patches before saving (resolve.ts); a refusal here is a page made
      // since, or another rule: a person decides.
      if (!refused(err, item)) throw err;
      return toReview(item, deps, {
        itemId: item.id, pageId: null, pageKey: n.key, kind: "new_page",
        reasons: [`could not create: ${err.message}`], proposal: { ref: sourceRef(item), page }, baseHash: null,
      });
    }
  }
  return toReview(item, deps, {
    itemId: item.id, pageId: null, pageKey: n.key, kind: "new_page",
    reasons: verdict.reasons, proposal: { ref: sourceRef(item), page }, baseHash: null,
  });
}

async function ask(item: ClaimedItem, shortlist: readonly PageRow[], index: readonly IndexRow[], deps: CurateDeps, note = "") {
  const prompt = buildPrompt(item, shortlist, deps.schema, undefined, index, accountPeople(deps.people ?? [], item.owner_email));
  const user = note ? `${prompt}\n\n${note}` : prompt;
  let reply = await deps.model.complete(SYSTEM_PROMPT, user);
  let usage = addUsage(emptyUsage(), deps.modelName, reply);
  // A reply cut off at the output limit (finish_reason=length) is never
  // parsed: its JSON is incomplete. Ask once more with twice the room.
  if (reply.finish === "length") {
    const first = deps.model.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
    const more = Math.min(first * 2, OUTPUT_TOKENS_CEILING);
    logger.warn({ item: item.id, model: deps.modelName, max_tokens: first, retry_with: more }, "curator: model reply cut off; asking once more");
    reply = await deps.model.complete(SYSTEM_PROMPT, user, more);
    usage = addUsage(usage, deps.modelName, reply);
    if (reply.finish === "length") {
      return { ok: false as const, reason: `the model reply was cut off at ${more} output tokens (finish_reason=length)`, tokens: totalTokens(usage), usage };
    }
  }
  const result = checkReply(reply.text, {
    shortlist, schema: deps.schema, sourceText: `${item.title ?? ""}\n${item.body}`, indexKeys: index.map((r) => r.key), index,
  });
  return { ...result, tokens: totalTokens(usage), usage };
}

/** The owner's page index for this item; empty when it cannot be read. */
async function pageIndex(item: ClaimedItem, keys: readonly string[], deps: CurateDeps): Promise<readonly IndexRow[]> {
  const text = `${item.title ?? ""}\n${item.body}`.slice(0, 2000);
  const vector = deps.embed ? await deps.embed(text).catch(() => null) : null;
  return deps.store.pageIndex(item.id, keys, searchText(item), vector, INDEX_ROWS).catch((err: unknown) => {
    logger.warn({ item: item.id, error: err instanceof Error ? err.message : "error" }, "curator: page index not read");
    return [];
  });
}

async function fail(item: ClaimedItem, deps: CurateDeps, reason: string, pages: readonly string[] = [], queued = 0): Promise<ItemResult> {
  await deps.store.done(item.id, "failed", pages, reason);
  return { outcome: "failed", pages, queued, reason };
}

/** The owner's page on exactly this key in the item's topics, if any. */
function lookupFor(item: ClaimedItem, deps: CurateDeps) {
  return async (key: string): Promise<PageRow | null> => {
    const rows = await deps.store.candidates(item.id, [key], "", 1);
    return rows.find((p) => normKey(p.key) === key) ?? null;
  };
}

const spent = (usage: Usage) => ({ usage, tokens: totalTokens(usage), usd: Math.round(totalUsd(usage) * 1e6) / 1e6 });

/** What was decided, and how: the plan and the facts the item result carries. */
type Decided = {
  readonly checked: CheckResult;
  readonly shortlist: readonly PageRow[];
  readonly label: ConsultLabel;
  readonly usage: Usage;
  readonly modelName: string;
  readonly routing: string;
  readonly agreed: { readonly agreement?: number };
  readonly escalated: boolean;
};

/** Consensus on: two runs, a tiebreak when they disagree, and the strong model where judgement matters. */
async function viaConsensus(item: ClaimedItem, shortlist: readonly PageRow[], index: readonly IndexRow[], deps: CurateDeps): Promise<Decided> {
  const hint = requiredHint(`${item.title ?? ""}\n${item.body}`, deps.schema);
  const safeAsk = (d: CurateDeps, note = hint) =>
    ask(item, shortlist, index, d, note).catch((err: unknown) => ({
      ok: false as const, reason: err instanceof Error ? err.message : "model call failed", tokens: 0, usage: emptyUsage(),
    }));
  const vote = { schema: deps.schema, shortlist };
  const consulted = await consult(deps, safeAsk, vote);
  let usage = consulted.usage;
  let checked: CheckResult = consulted.result;
  const agreed = consulted.agreement !== undefined ? { agreement: consulted.agreement } : {};
  const base = { shortlist, label: consulted.label, agreed, escalated: false, modelName: deps.modelName };
  if (!checked.ok) return { ...base, checked, usage, routing: "" };
  // Where judgement matters, the strong model decides (its plan replaces the
  // primary one; if it fails, the primary plan stands). Why, or why not, is logged.
  const routing = strongRouting(checked.plan, consulted.label, deps.schema, { shortlist, ...agreed }, deps.strong !== undefined);
  logger.info({ item: item.id, escalate: routing.why !== null, note: routing.note }, "curator: strong model routing");
  let escalated = false;
  let modelName = deps.modelName;
  if (routing.why && deps.strong) {
    const strong = await safeAsk({ ...deps, model: deps.strong.model, modelName: deps.strong.name });
    usage = mergeUsage(usage, strong.usage);
    escalated = strong.ok;
    logger.info({ item: item.id, why: routing.why, ok: strong.ok }, "curator: strong model asked");
    if (strong.ok) {
      checked = strong;
      modelName = deps.strong.name;
    }
  }
  if (!escalated) for (const u of consulted.uncertain) await deps.store.uncertain(item.id, u.decision, u.proposals);
  return { ...base, checked, usage, routing: routing.note, escalated, modelName };
}

/** Apply a checked plan: creates on known keys become updates, names are matched, then each change is saved or queued. */
async function applyPlan(
  item: ClaimedItem, deps: CurateDeps, d: Decided & { readonly checked: { ok: true } & CheckResult }, done: readonly string[], index: readonly IndexRow[] = [],
): Promise<ItemResult> {
  const gen: Generated = { by: "curator", model: d.modelName, at: deps.now().toISOString() };
  const steps: Step[] = [];
  const touched = [...done];
  // The owner and account users never get a person page.
  const own = dropAccountPages(d.checked.plan, accountPeople(deps.people ?? [], item.owner_email), deps.schema);
  const start = own.plan;
  const droppedAll = [...(start.dropped ?? []), ...own.dropped];
  const how = {
    consensus: d.label, ...spent(d.usage), routing: d.routing, ...d.agreed, ...(d.escalated ? { escalated: true } : {}),
    ...(droppedAll.length > 0 ? { dropped: droppedAll } : {}),
    ...((d.checked.plan.repaired ?? []).length > 0 ? { repaired: d.checked.plan.repaired } : {}),
  };
  try {
    // Every create on a key the owner already has here becomes a patch.
    const resolved = await resolveCreates(preferOpen(start, { schema: deps.schema, shortlist: d.shortlist }), d.shortlist, item.id, lookupFor(item, deps), eventsRule(deps.schema));
    if (resolved.converted.length > 0) {
      logger.info({ item: item.id, converted: resolved.converted.length }, "curator: new pages on existing keys became updates");
    }
    touched.push(...resolved.done.filter((id) => !touched.includes(id)));
    // A page without a strong key is filed on a page with the same name instead.
    // Update first: a page that is an existing page under another name is a patch to it.
    const named = await fileByName(resolved.plan, resolved.shortlist, item, deps, lookupFor(item, deps), index);
    touched.push(...named.done.filter((id) => !touched.includes(id)));
    const pagesShown = named.shortlist;
    const plan = dropRepeats(named.plan, pagesShown);
    for (const u of plan.updates) {
      const page = pagesShown.find((p) => p.key === u.key);
      if (!page) continue;
      const identity = identityFor(item, u, page, deps);
      const empty = u.patches.length === 0 && Object.keys(u.fields).length === 0 && u.related.length === 0
        && (u.aliases ?? []).length === 0 && !identity;
      if (!empty) steps.push(await handleUpdate(item, u, page, deps, gen, identity));
    }
    for (const n of plan.newPages) steps.push(await handleNewPage(item, n, deps, gen));
  } catch (err) {
    const written = [...touched, ...steps.flatMap((s) => s.applied)];
    const queuedSoFar = steps.reduce((n, s) => n + s.queued, 0);
    return { ...(await fail(item, deps, err instanceof Error ? err.message : "save failed", written, queuedSoFar)), ...how };
  }

  const pages = [...touched, ...steps.flatMap((s) => s.applied)];
  const queued = steps.reduce((n, s) => n + s.queued, 0);
  if (how.dropped || how.repaired) {
    // Counts only: the lines name page keys, which are never logged.
    logger.info({ item: item.id, dropped: how.dropped?.length ?? 0, repaired: how.repaired?.length ?? 0 }, "curator: parts of the reply left out or repaired");
  }
  const outcome = outcomeOf(pages.length, queued);
  await deps.store.done(item.id, outcome, pages);
  // Nothing durable in the item: the model's reason is kept on the result.
  const notes = d.checked.plan.notes;
  const reason = outcome === "no_change" && notes ? { reason: notes.slice(0, 300) } : {};
  return { outcome, pages, queued, ...how, ...reason };
}

export async function curateItem(item: ClaimedItem, deps: CurateDeps): Promise<ItemResult> {
  if (!item.released) {
    const held = screen(item.title, item.body);
    if (held.flagged) {
      await deps.store.flag(item.id, held.reason);
      return { outcome: "flagged", pages: [], queued: 0, reason: held.reason };
    }
  }

  const drawers = new Set(deps.schema.drawers.map((d) => d.id));
  const keys = itemKeys(item, sourceKeyRules(deps.schema.drawers));
  const found = await deps.store.candidates(item.id, keys, searchText(item), SHORTLIST_SIZE);
  const index = await pageIndex(item, keys, deps);
  // A page that already lists this item was written by an earlier, cut-short
  // run: it counts as touched and is not offered again.
  const done = found.filter((p) => alreadyHas(p, item.id)).map((p) => p.id);
  const shortlist = found.filter((p) => !alreadyHas(p, item.id) && drawers.has(p.drawer));

  let decided: Decided;
  if (deps.writer && !deps.consensus) {
    const w = await writeItem(item, shortlist, index, deps, lookupFor(item, deps));
    if (w.stop) {
      await deps.store.done(item.id, "no_change", done);
      logger.info({ item: item.id, tokens: totalTokens(w.usage), usd: spent(w.usage).usd }, "curator: triage found nothing durable");
      return { outcome: "no_change", pages: done, queued: 0, reason: w.reason, consensus: "single", triaged: true, routing: "triage: no change", ...spent(w.usage) };
    }
    // Fact check (the triage model): sentences the source does not support are
    // cut. For a session note the source is its labelled exact quotes.
    const t = deps.writer.triage;
    const fc = t && w.checked.ok ? await factCheck(w.checked.plan, factSource(item), t, item.id, ownerPerson(deps.people ?? [], item.owner_email)) : null;
    const checked: CheckResult = fc && w.checked.ok ? { ok: true, plan: fc.plan } : w.checked;
    const usage = fc ? mergeUsage(w.usage, fc.usage) : w.usage;
    decided = { checked, shortlist: w.pages, label: "single", usage, modelName: deps.modelName, routing: fc ? `${w.note}; fact checked` : w.note, agreed: {}, escalated: false };
  } else {
    decided = await viaConsensus(item, shortlist, index, deps);
  }
  logger.info({ item: item.id, consensus: decided.label, tokens: totalTokens(decided.usage), usd: spent(decided.usage).usd }, "curator: item decided");
  const checked = decided.checked;
  if (!checked.ok) {
    return { ...(await fail(item, deps, checked.reason, done)), consensus: decided.label, ...spent(decided.usage), ...decided.agreed };
  }
  return applyPlan(item, deps, { ...decided, checked }, done, index);
}
