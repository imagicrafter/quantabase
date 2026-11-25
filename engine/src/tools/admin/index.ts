import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { addPersonTool } from "./add-person.js";
import { deactivatePersonTool } from "./deactivate-person.js";
import { grantTopicTool } from "./grant-topic.js";
import { listIssuesTool } from "./list-issues.js";
import { listPeopleTool } from "./list-people.js";
import { reactivatePersonTool } from "./reactivate-person.js";
import { revokeTopicTool } from "./revoke-topic.js";
import { addTicketNoteTool, getTicketTool, listTicketsTool } from "./tickets.js";

/** Listed only for administrators (see mcp/server.ts and is-admin.ts). */
export const adminTools: readonly ToolSpec[] = [
  listPeopleTool,
  addPersonTool,
  grantTopicTool,
  revokeTopicTool,
  deactivatePersonTool,
  reactivatePersonTool,
  listIssuesTool,
  listTicketsTool,
  getTicketTool,
  addTicketNoteTool,
];

export { isAdministrator } from "./is-admin.js";
