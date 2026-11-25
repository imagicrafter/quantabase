import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../log/logger.js";
import { formatToolError, registerJsonTool } from "./tool-helpers.js";
import { search, searchSchema } from "../tools/search.js";
import { getDocument, getDocumentSchema } from "../tools/get-document.js";
import { whoKnows, whoKnowsSchema } from "../tools/who-knows.js";
import { getWikiPage, getWikiPageSchema } from "../tools/get-wiki-page.js";
import { reportIssueTool } from "../tools/report-issue.js";
import { adminTools } from "../tools/admin/index.js";
import { pageTools } from "../tools/pages/index.js";
import type { AuthContext } from "../auth/middleware.js";
import { ENGINE_VERSION } from "../version.js";

export type McpAuthContext = AuthContext;

export const authContextStore = new AsyncLocalStorage<McpAuthContext>();

export function getAuthContext(): McpAuthContext {
  const ctx = authContextStore.getStore();
  if (!ctx) {
    throw new Error(
      "No auth context — request outside AsyncLocalStorage scope",
    );
  }
  return ctx;
}

const SERVER_INFO = {
  name: "kb-engine",
  version: ENGINE_VERSION,
} as const;

export type McpServerOptions = {
  /**
   * List the admin tools for this caller. Listing is a courtesy, not the
   * guard: every admin function re-checks the caller in the database.
   */
  readonly isAdmin?: boolean;
};

/** `instructions` is the text from buildInstructions (mcp/instructions.ts). */
export function createMcpServer(
  instructions: string,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions });

  // ── report_issue (everyone) and the admin tools (administrators only) ──────
  registerJsonTool(server, getAuthContext, reportIssueTool);
  // ── page tools (everyone; the database limits writes to the caller's own) ──
  pageTools.forEach((tool) => registerJsonTool(server, getAuthContext, tool));
  if (options.isAdmin === true) {
    adminTools.forEach((tool) =>
      registerJsonTool(server, getAuthContext, tool),
    );
  }

  // ── search ─────────────────────────────────────────────────────────────────
  server.tool(
    "search",
    "Hybrid semantic + keyword search over your granted knowledge domains. Returns evidence: id, title, source, distillation, domains, tier, review_status, and score. Use match_count (1-50, default 10) to control result set size. Set require_approved=true for human-reviewed documents only.",
    {
      query: searchSchema.shape.query,
      match_count: searchSchema.shape.match_count,
      require_approved: searchSchema.shape.require_approved,
    },
    async (params) => {
      const ctx = getAuthContext();
      try {
        const input = searchSchema.parse(params);
        const result = await search(input, ctx.sub);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        logger.warn({ err, sub: ctx.sub }, "search tool error");
        return {
          content: [{ type: "text" as const, text: formatToolError(err) }],
          isError: true,
        };
      }
    },
  );

  // ── get_document ───────────────────────────────────────────────────────────
  server.tool(
    "get_document",
    "Fetch the full body and metadata of a document by its UUID. Access is enforced in the database — out-of-domain documents return not_found. Use when a distillation from search is insufficient or verbatim content is needed.",
    { id: getDocumentSchema.shape.id },
    async (params) => {
      const ctx = getAuthContext();
      try {
        const input = getDocumentSchema.parse(params);
        const doc = await getDocument(input, ctx.sub);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(doc, null, 2) },
          ],
        };
      } catch (err) {
        logger.warn({ err, sub: ctx.sub }, "get_document tool error");
        return {
          content: [{ type: "text" as const, text: formatToolError(err) }],
          isError: true,
        };
      }
    },
  );

  // ── who_knows ──────────────────────────────────────────────────────────────
  server.tool(
    "who_knows",
    "Find people (authors and participants) in documents matching a topic query. Returns people ranked by how many in-domain documents mention them, each with evidence (document ids + titles). Results are derived from your access-filtered search — only people appearing in documents you can see are returned.",
    { topic: whoKnowsSchema.shape.topic },
    async (params) => {
      const ctx = getAuthContext();
      try {
        const input = whoKnowsSchema.parse(params);
        const result = await whoKnows(input, ctx.sub);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        logger.warn({ err, sub: ctx.sub }, "who_knows tool error");
        return {
          content: [{ type: "text" as const, text: formatToolError(err) }],
          isError: true,
        };
      }
    },
  );

  // ── get_wiki_page ──────────────────────────────────────────────────────────
  server.tool(
    "get_wiki_page",
    'Fuzzy-fetch wiki pages by title or file path. Returns up to 5 matches (best-match first) with full body. The database escapes wildcards in your input — searching for "%" or "_" matches literally. Access is enforced in the database.',
    { title_or_path: getWikiPageSchema.shape.title_or_path },
    async (params) => {
      const ctx = getAuthContext();
      try {
        const input = getWikiPageSchema.parse(params);
        const pages = await getWikiPage(input, ctx.sub);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(pages, null, 2) },
          ],
        };
      } catch (err) {
        logger.warn({ err, sub: ctx.sub }, "get_wiki_page tool error");
        return {
          content: [{ type: "text" as const, text: formatToolError(err) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
