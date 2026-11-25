import { z } from "zod";
import { db } from "../db.js";
import { McpAppError } from "../mcp/errors.js";
import { logger } from "../log/logger.js";

export const getWikiPageSchema = z.object({
  title_or_path: z.string().min(1).max(500),
});

export type GetWikiPageInput = z.infer<typeof getWikiPageSchema>;

export type WikiPageResult = {
  id: string;
  title: string;
  body: string;
  url: string | null;
  author: string | null;
  domains: string[];
  tier: number;
  review_status: string;
  distillation: string | null;
  source_created_at: string | null;
};

export async function getWikiPage(
  input: GetWikiPageInput,
  sub: string,
): Promise<WikiPageResult[]> {
  logger.info(
    { sub, title_length: input.title_or_path.length },
    "get_wiki_page tool called",
  );

  // The RPC (wiki_page_get in migration 0017) escapes % and _ before ILIKE.
  // No additional escaping is needed here; the DB function owns that contract.
  const { data, error } = await db()
    .rpc("wiki_page_get", {
      p_oauth_subject: sub,
      p_title_or_path: input.title_or_path,
    });

  if (error) {
    logger.error({ err: error, sub }, "wiki_page_get RPC failed");
    throw new McpAppError("internal_error", "Wiki page fetch failed");
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return [];
  }

  return rows.map((row) => ({
    id: String(row["id"] ?? ""),
    title: String(row["title"] ?? ""),
    body: String(row["body"] ?? ""),
    url: row["url"] != null ? String(row["url"]) : null,
    author: row["author"] != null ? String(row["author"]) : null,
    domains: Array.isArray(row["domains"]) ? (row["domains"] as string[]) : [],
    tier: Number(row["tier"] ?? 4),
    review_status: String(row["review_status"] ?? ""),
    distillation:
      row["distillation"] != null ? String(row["distillation"]) : null,
    source_created_at:
      row["source_created_at"] != null
        ? String(row["source_created_at"])
        : null,
  }));
}
