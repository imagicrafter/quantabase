import { z } from "zod";
import { db } from "../db.js";
import { embedText } from "../supabase.js";
import { McpAppError } from "../mcp/errors.js";
import { logger } from "../log/logger.js";
import { searchPages, type PageHits } from "./pages/search-pages.js";

export const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  match_count: z.number().int().min(1).max(50).default(10),
  require_approved: z.boolean().default(false),
});

export type SearchInput = z.infer<typeof searchSchema>;

export type SearchResult = {
  id: string;
  title: string;
  source: string;
  url: string | null;
  author: string | null;
  domains: string[];
  tier: number;
  review_status: string;
  distillation: string | null;
  snippet: string;
  score: number;
};

export async function search(
  input: SearchInput,
  sub: string,
): Promise<{
  results: SearchResult[];
  /** Wiki pages, one entry per entity key, the caller's own page first. */
  entities?: PageHits["entities"];
  /** Pages one link away from those entities. */
  related?: PageHits["related"];
  message?: string;
}> {
  // Log query_length, never query text (queries against this store are as sensitive
  // as the documents — financial queries must not appear in run logs).
  logger.info(
    { sub, query_length: input.query.length, match_count: input.match_count },
    "search tool called",
  );

  let embedding: number[];
  try {
    embedding = await embedText(input.query);
  } catch (err) {
    if (err instanceof McpAppError) throw err;
    throw new McpAppError("internal_error", "Failed to embed query");
  }

  const [{ data, error }, pages] = await Promise.all([
    db().rpc("documents_search_by_oauth_subject", {
      p_oauth_subject: sub,
      query_text: input.query,
      query_embedding: embedding,
      match_count: input.match_count,
      require_approved: input.require_approved,
    }),
    searchPages(input.query, embedding, input.match_count, sub),
  ]);

  if (error) {
    logger.error({ err: error, sub }, "documents_search_by_oauth_subject failed");
    throw new McpAppError("internal_error", "Search failed");
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  if (rows.length === 0 && pages.entities.length === 0) {
    // Distinguish "no matching documents" from "no domain grants at all".
    const { data: countData } = await db()
      .rpc("resolved_domain_count_for_oauth_subject", { p_sub: sub });

    const domainCount = typeof countData === "number" ? countData : 0;
    logger.info({ sub, domain_count: domainCount }, "search returned empty");

    if (domainCount === 0) {
      return {
        results: [],
        message:
          "No results: this principal has no domain grants. Contact the administrator.",
      };
    }
    return { results: [] };
  }

  const results: SearchResult[] = rows.map((row) => ({
    id: String(row["id"] ?? ""),
    title: String(row["title"] ?? ""),
    source: String(row["source"] ?? ""),
    url: row["url"] != null ? String(row["url"]) : null,
    author: row["author"] != null ? String(row["author"]) : null,
    domains: Array.isArray(row["domains"]) ? (row["domains"] as string[]) : [],
    tier: Number(row["tier"] ?? 4),
    review_status: String(row["review_status"] ?? ""),
    distillation:
      row["distillation"] != null ? String(row["distillation"]) : null,
    snippet: String(row["distillation"] ?? row["title"] ?? "").slice(0, 400),
    score: Number(row["fused_score"] ?? 0),
  }));

  logger.info(
    { sub, result_count: results.length, entity_count: pages.entities.length },
    "search completed",
  );
  return { results, entities: pages.entities, related: pages.related };
}
