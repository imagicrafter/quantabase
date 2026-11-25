import { logger } from "../../log/logger.js";
import { groupByKey, type KeyGroup, type PageRow } from "../../entities/group.js";
import { pageRpc, rowsOf } from "./rpc.js";
import { relatedFor, type RelatedEntry } from "./read.js";

/** Related pages added to a search, one step from the hits. No model call. */
const RELATED_LIMIT = 10;

export type PageHits = {
  readonly entities: KeyGroup<PageRow>[];
  readonly related: RelatedEntry[];
};

/**
 * Page side of search: hits grouped by key (own page first) and up to ten
 * pages one link away. Pages are additive to document results, so a failure
 * here is logged and yields no pages rather than failing the whole search;
 * nothing is shown that the database did not clear.
 */
export async function searchPages(
  query: string,
  embedding: readonly number[],
  matchCount: number,
  sub: string,
): Promise<PageHits> {
  try {
    const data = await pageRpc(
      "pages_search_by_oauth_subject",
      sub,
      { query_text: query, query_embedding: embedding, match_count: matchCount },
      "Page search failed",
    );
    const entities = groupByKey(rowsOf(data) as unknown as PageRow[]).slice(0, matchCount);
    const keys = entities.map((e) => e.key);
    const related = keys.length > 0 ? await relatedFor(keys, RELATED_LIMIT, sub) : [];
    return { entities, related };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "page search skipped");
    return { entities: [], related: [] };
  }
}
