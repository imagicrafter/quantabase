import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { entitySchemaTool, findEntityTool, listEntitiesTool, relatedTool } from "./read.js";
import { getIngestPlanTool, reportCandidatesTool } from "./ingest-plan.js";
import { getSourceItemTool, recordSourceItemTool } from "./source.js";
import { savePageTool, updatePageTool } from "./write.js";

/**
 * The page tools, for every signed-in person. Writes only ever touch the
 * caller's own pages and items; reads follow the page access rule. Both are
 * enforced in the database from the signed-in subject.
 */
export const pageTools: readonly ToolSpec[] = [
  entitySchemaTool,
  findEntityTool,
  listEntitiesTool,
  relatedTool,
  getIngestPlanTool,
  reportCandidatesTool,
  recordSourceItemTool,
  getSourceItemTool,
  savePageTool,
  updatePageTool,
];
