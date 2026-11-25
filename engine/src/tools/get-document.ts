import { z } from "zod";
import { db } from "../db.js";
import { McpAppError } from "../mcp/errors.js";
import { logger } from "../log/logger.js";

export const getDocumentSchema = z.object({
  id: z.string().uuid(),
});

export type GetDocumentInput = z.infer<typeof getDocumentSchema>;

export type DocumentDetail = {
  id: string;
  title: string;
  body: string;
  source: string;
  url: string | null;
  author: string | null;
  domains: string[];
  tier: number;
  review_status: string;
  distillation: string | null;
  metadata: Record<string, unknown>;
  source_created_at: string | null;
};

// A document id is not a capability. The RPC's WHERE clause enforces domain
// access — out-of-domain rows never leave the database. The not_found message
// is byte-identical whether the id doesn't exist or is out of domain, so the
// caller cannot distinguish them.
const NOT_FOUND_MESSAGE = "Document not found";

export async function getDocument(
  input: GetDocumentInput,
  sub: string,
): Promise<DocumentDetail> {
  logger.info({ sub, doc_id: input.id }, "get_document tool called");

  const { data, error } = await db()
    .rpc("document_get", {
      p_oauth_subject: sub,
      p_id: input.id,
    });

  if (error) {
    logger.error(
      { err: error, sub, doc_id: input.id },
      "document_get RPC failed",
    );
    throw new McpAppError("internal_error", "Document fetch failed");
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    // Out-of-domain and truly nonexistent both produce the same response.
    // Do NOT fall back to a raw table query — the role has no table grants.
    throw new McpAppError("not_found", NOT_FOUND_MESSAGE);
  }

  const row = rows[0]!;
  return {
    id: String(row["id"] ?? ""),
    title: String(row["title"] ?? ""),
    body: String(row["body"] ?? ""),
    source: String(row["source"] ?? ""),
    url: row["url"] != null ? String(row["url"]) : null,
    author: row["author"] != null ? String(row["author"]) : null,
    domains: Array.isArray(row["domains"]) ? (row["domains"] as string[]) : [],
    tier: Number(row["tier"] ?? 4),
    review_status: String(row["review_status"] ?? ""),
    distillation:
      row["distillation"] != null ? String(row["distillation"]) : null,
    metadata:
      row["metadata"] != null && typeof row["metadata"] === "object"
        ? (row["metadata"] as Record<string, unknown>)
        : {},
    source_created_at:
      row["source_created_at"] != null
        ? String(row["source_created_at"])
        : null,
  };
}
