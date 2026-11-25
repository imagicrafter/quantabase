import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { logger } from "../log/logger.js";
import type { AuthContext } from "../auth/middleware.js";
import { isMcpAppError } from "./errors.js";

export function formatToolError(err: unknown): string {
  if (isMcpAppError(err)) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly shape: ZodRawShape;
  /** Validates `params` itself and returns the value to send back as JSON. */
  readonly run: (params: unknown, ctx: AuthContext) => Promise<unknown>;
};

/**
 * Register a tool that answers with JSON text and reports any failure as a
 * tool error. The log line carries the opaque `sub` only -- never the
 * arguments, which for admin tools hold other people's email addresses.
 */
export function registerJsonTool(
  server: McpServer,
  getContext: () => AuthContext,
  spec: ToolSpec,
): void {
  server.tool(spec.name, spec.description, spec.shape, async (params) => {
    const ctx = getContext();
    try {
      const result = await spec.run(params, ctx);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      logger.warn(
        { err: formatToolError(err), sub: ctx.sub },
        `${spec.name} tool error`,
      );
      return {
        content: [{ type: "text" as const, text: formatToolError(err) }],
        isError: true,
      };
    }
  });
}
