import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { currentSettings } from "../config/settings.js";
import { logger } from "../log/logger.js";
import { isAdministrator } from "../tools/admin/index.js";
import { buildInstructions } from "./instructions.js";
import {
  authContextStore,
  createMcpServer,
  type McpAuthContext,
} from "./server.js";

/**
 * Instruction text for this Engine. If the settings cannot be read the generic
 * text is used: the wording is not a security control, so a database blip must
 * not take the connector down with it.
 */
async function instructionsNow(): Promise<string> {
  try {
    return buildInstructions((await currentSettings()).config);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "engine config unavailable; using generic MCP instructions",
    );
    return buildInstructions(null);
  }
}

export async function handleMcpRequest(
  request: Request,
  ctx: McpAuthContext,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // A new server is built for every request, so the tool list can differ per
  // caller: the admin tools are registered only for administrators.
  const [instructions, isAdmin] = await Promise.all([
    instructionsNow(),
    isAdministrator(ctx.email),
  ]);
  const server = createMcpServer(instructions, { isAdmin });

  try {
    await server.connect(transport);
    const response = await authContextStore.run(ctx, () =>
      transport.handleRequest(request),
    );
    return response;
  } catch (err) {
    logger.error({ err, sub: ctx.sub }, "MCP request handling failed");
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    void server
      .close()
      .catch((err) => logger.warn({ err }, "MCP server close failed"));
  }
}
