import { z } from "zod";
import { groupByKey, type PageRow } from "../entities/group.js";
import { costOf } from "../curator/prices.js";
import { card, esc, hidden } from "./html.js";
import { usd } from "./ledger-view.js";
import type { Light } from "./pipeline-view.js";
import type { Row } from "./store.js";

/**
 * The Cataloguer and Index clerk cards on the Pipeline screen (migration
 * 0075): the step after publishing, where each page gets its short summary
 * and is filed in the search index. Their counts, the Index clerk's
 * try-a-search box and its results, the "Details for experts" card, and the
 * redo-summaries-and-index confirm page. Plain words; numbers only in the
 * counts.
 */

/** The search model, as the experts card names it. Not a setting: changing it would break search. */
export const EMBEDDING_MODEL_NAME = "gte-small (384 dimensions, Supabase embed function)";
/** How many pages the try-a-search box shows. */
export const TRY_SEARCH_COUNT = 5;
const MAX_QUERY = 200;
/** A rough page summary call when no cost has been seen yet: the page plus the prompt, and the reply. */
const PROMPT_TOKENS = 400;
const REPLY_TOKENS = 150;
const CHARS_PER_TOKEN = 4;

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const count = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export type CardState = { readonly status: string; readonly light: Light };

/** The Cataloguer: pages waiting, and what the last run that wrote summaries did. */
export function cataloguerState(p: Row, runLight: Light): CardState {
  const run = object(p["summary_run"]);
  const failed = count(run["summary_failed"]);
  const done = `${count(run["summaries"]).toLocaleString("en-US")} done and ${failed.toLocaleString("en-US")} failed in the last run.`;
  return {
    status: `${plural(count(p["summaries_pending"]), "page")} waiting for a summary; ${done}`,
    light: failed > 0 && runLight !== "off" ? "warn" : runLight,
  };
}

/** The Index clerk: pages in the index, waiting, and any missing that nothing will file. */
export function indexClerkState(p: Row, runLight: Light): CardState {
  const failed = count(object(p["summary_run"])["index_failed"]);
  const missing = count(p["index_missing"]);
  const parts = [
    `${plural(count(p["pages_indexed"]), "page")} in the search index`,
    `${count(p["summaries_pending"]).toLocaleString("en-US")} waiting`,
    ...(missing > 0 ? [`${missing.toLocaleString("en-US")} missing`] : []),
  ];
  return { status: `${parts.join("; ")}.`, light: (failed > 0 || missing > 0) && runLight !== "off" ? "warn" : runLight };
}

const QUERY = z.string().trim().min(1).max(MAX_QUERY);

/** The try-a-search question: trimmed, 1 to 200 characters, else null. */
export function parseSearchQuery(v: unknown): string | null {
  const r = QUERY.safeParse(v);
  return r.success ? r.data : null;
}

/** The box at the bottom of the Index clerk card. Any administrator may use it; it only reads. */
export function searchBoxHtml(csrf: string, query = ""): string {
  const box = `<input type="search" name="q" maxlength="${MAX_QUERY}" required aria-label="A question to search for" placeholder="Ask a question" value="${esc(query)}">`;
  return `<div class="tune"><span class="tune-label">Try a search</span><form class="try" method="post" action="/setup/pipeline/search">${hidden("csrf", csrf)}${box}<button type="submit">Search</button></form>` +
    `<p class="effect">Shows the top pages you may see. Read only.</p></div>`;
}

/** The results card; its id is the anchor the search form returns to. */
const resultsCard = (inner: string): string => `<div class="card" id="try-search">${inner}</div>`;

/** The top pages for a question, one per key with the person's own page first: title and score. */
export function searchResultsHtml(query: string, rows: readonly Row[]): string {
  const groups = groupByKey(rows.filter((r) => typeof r["key"] === "string") as unknown as PageRow[]).slice(0, TRY_SEARCH_COUNT);
  const head = `<h2>Try a search</h2><p>Top pages for <strong>${esc(query)}</strong>, as Claude's search would rank them for you.</p>`;
  if (!groups.length) return resultsCard(`${head}<p class="hint">No pages came back. A page waiting for its summary is not in the index yet.</p>`);
  const items = groups
    .map((g) => {
      const top = g.pages[0] as PageRow & { readonly score?: unknown };
      return `<li><strong>${esc(top.title)}</strong> <span class="hint">${esc(g.drawer)}</span> <span class="score">score ${esc(count(top.score).toFixed(4))}</span></li>`;
    })
    .join("");
  return resultsCard(`${head}<ol class="hits">${items}</ol><p class="hint">A higher score is a closer match. Nothing was changed.</p>`);
}

/**
 * The cost of redoing every page: the cost a summary has had over the last
 * 30 days when there is one, else the price table for the summary model with
 * the average page length. Null when neither is known.
 */
export function redoEstimate(preview: Row): number | null {
  const pages = count(preview["pages"]);
  if (pages === 0) return 0;
  const seen = count(preview["summaries_30d"]);
  const spent = count(preview["usd_30d"]);
  if (seen > 0 && spent > 0) return (spent / seen) * pages;
  const one = costOf(String(preview["summary_model"] ?? ""), {
    input: Math.ceil(count(preview["avg_chars"]) / CHARS_PER_TOKEN) + PROMPT_TOKENS,
    output: REPLY_TOKENS,
  });
  return one === null ? null : one * pages;
}

/** The confirm page: how many pages, what it may cost, and one confirm button. */
export function redoConfirmHtml(preview: Row, csrf: string): string {
  const pages = count(preview["pages"]);
  const estimate = redoEstimate(preview);
  const cost = estimate === null ? "not known (the summary model is not in the price table)" : `about ${usd(estimate)}`;
  return card(`<h2>Redo summaries and index</h2>
<p>This queues <strong>${esc(plural(pages, "page"))}</strong> for a new summary and a new search index entry. The curator does them on its normal runs, a few at a time; each page keeps its old summary until then.</p>
<table class="stats"><tbody>
<tr><th scope="row">Pages</th><td>${esc(pages.toLocaleString("en-US"))}</td></tr>
<tr><th scope="row">Estimated cost</th><td>${esc(cost)}</td></tr>
<tr><th scope="row">Summary model</th><td>${esc(preview["summary_model"] ?? "")}</td></tr>
</tbody></table>
<form method="post" action="/setup/pipeline/redo">${hidden("csrf", csrf)}${hidden("confirm", "yes")}<p><button type="submit">Yes, redo ${esc(plural(pages, "page"))}</button> <a href="/setup/pipeline">Cancel</a></p></form>
<p class="hint">Use this after changing the summary length, or if search seems to miss pages. It never changes a page's text.</p>`);
}

/** Under "Details for experts": the two steps' model, cost and search model; the redo link for the owner. */
export function cataloguerExpertsHtml(p: Row | null): string {
  if (!p) return "";
  const cost = p["summary_usd_30d"];
  const redo = p["is_owner"] === true
    ? `<p><a href="/setup/pipeline/redo">Redo summaries and index</a></p><p class="hint">Shows how many pages and the cost first; nothing happens until you confirm.</p>`
    : `<p class="hint">Only the Engine owner can redo summaries and index.</p>`;
  return card(`<h2>Cataloguer and Index clerk</h2><table class="stats"><tbody>
<tr><th scope="row">Summary model</th><td>${esc(p["summary_model"] ?? "not known yet")}</td></tr>
<tr><th scope="row">Cost of summaries, last 30 days</th><td>${cost === undefined || cost === null ? "not known yet" : esc(`$${count(cost).toFixed(4)}`)}</td></tr>
<tr><th scope="row">Search model</th><td>${esc(EMBEDDING_MODEL_NAME)}</td></tr>
</tbody></table>${redo}`);
}
