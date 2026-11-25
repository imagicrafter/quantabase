import { z } from "zod";
import { db } from "../db.js";
import { McpAppError } from "../mcp/errors.js";
import { logger } from "../log/logger.js";
import type { ToolSpec } from "../mcp/tool-helpers.js";
import { mapDbError } from "./db-error.js";

export const ISSUE_CATEGORIES = [
  "data_quality_issue",
  "feature_gap",
  "friction_point",
] as const;

export const reportIssueSchema = z
  .object({
    category: z.enum(ISSUE_CATEGORIES),
    title: z.string().trim().min(5).max(120),
    detail: z.string().trim().max(1000).optional(),
  })
  .strict();

export type ReportIssueInput = z.infer<typeof reportIssueSchema>;

export type ReportIssueResult = {
  readonly id: string;
  readonly message: string;
};

const NOT_ACTIVE = "Your account is not active on this Engine";

/**
 * Log a problem on behalf of the signed-in person.
 *
 * `email` is the verified address from the sign-in assertion, never a tool
 * argument. The database resolves it to an active person, refuses anyone
 * else, and enforces the hourly limit -- this function adds no check the
 * database does not also make.
 */
export async function reportIssue(
  input: ReportIssueInput,
  email: string,
): Promise<ReportIssueResult> {
  const { data, error } = await db()
    .rpc("issue_report", {
      p_email: email,
      p_category: input.category,
      p_title: input.title,
      p_detail: input.detail && input.detail.length > 0 ? input.detail : null,
    });

  if (error) {
    logger.warn({ code: error.code }, "issue_report RPC failed");
    throw mapDbError(error, NOT_ACTIVE, "The issue could not be logged");
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new McpAppError("internal_error", "The issue could not be logged");
  }

  return {
    id: data,
    message: `Logged. Issue ${data} is now open for the Engine's administrators.`,
  };
}

export const reportIssueTool: ToolSpec = {
  name: "report_issue",
  description:
    "Log a problem with this knowledge Engine for its administrators: wrong or missing knowledge (data_quality_issue), something it cannot do (feature_gap), or something that works but is awkward (friction_point). Use it when the person asks to report a problem, or agrees after you offer. Write the title and detail in your own words; do NOT paste document text, document titles or other people's names. Limited to 10 reports per person per hour.",
  shape: reportIssueSchema.shape,
  run: async (params, ctx) =>
    reportIssue(reportIssueSchema.parse(params), ctx.email),
};
