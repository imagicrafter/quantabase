import { z } from "zod";
import { McpAppError } from "../../mcp/errors.js";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { groupByKey, summariseEntities, type PageRow } from "../../entities/group.js";
import { TEMPLATE_NAMES, allDrawerIds, entitySchema } from "../../entities/templates.js";
import { chosenSchema, chosenTemplates } from "../../entities/chosen.js";
import { pageRpc, rowsOf } from "./rpc.js";
import {
  entitySchemaSchema,
  findEntitySchema,
  listEntitiesSchema,
  relatedSchema,
} from "./schemas.js";

const asRows = (data: unknown): PageRow[] => rowsOf(data) as unknown as PageRow[];

export async function findEntity(input: z.infer<typeof findEntitySchema>, sub: string) {
  const data = await pageRpc(
    "entity_find",
    sub,
    { p_query: input.query, p_drawer: input.drawer ?? null, p_limit: input.limit },
    "The lookup failed",
  );
  return { entities: groupByKey(asRows(data)) };
}

export async function listEntities(input: z.infer<typeof listEntitiesSchema>, sub: string) {
  if (!allDrawerIds().has(input.drawer)) {
    throw new McpAppError("invalid_argument", `Unknown drawer "${input.drawer}"`);
  }
  const data = await pageRpc(
    "entity_rows",
    sub,
    { p_drawer: input.drawer, p_limit: 2000 },
    "The list failed",
  );
  return { drawer: input.drawer, ...summariseEntities(asRows(data), input) };
}

export type RelatedEntry = {
  readonly key: string;
  readonly drawer: string;
  readonly title: string;
  readonly description: string | null;
  readonly reason: string;
  readonly pages: readonly { id: string; owner: string; is_own: boolean; updated_at: string }[];
};

/** Pages one link away from these keys, one entry per key, at most `limit`. */
export async function relatedFor(keys: readonly string[], limit: number, sub: string): Promise<RelatedEntry[]> {
  const wanted = [...new Set(keys.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0))];
  if (wanted.length === 0) return [];
  const data = await pageRpc("page_related", sub, { p_keys: wanted, p_limit: limit }, "Related pages failed");
  return groupByKey(asRows(data))
    .slice(0, limit)
    .map((g) => {
      const first = g.pages[0]!;
      return {
        key: g.key,
        drawer: g.drawer,
        title: first.title,
        description: first.description,
        reason: `${String(first["reason"])} (${String(first["direction"])})`,
        pages: g.pages.map((p) => ({
          id: p.id,
          owner: p.owner_handle,
          is_own: p.is_own,
          updated_at: p.updated_at,
        })),
      };
    });
}

export const findEntityTool: ToolSpec = {
  name: "find_entity",
  description:
    "Find pages by exact entity key, alias or title (any case). Returns one entry per key; your own page first, then other people's pages you may see, each with its full header, body and content_hash (needed to change your page with save_page).",
  shape: findEntitySchema.shape,
  run: async (params, ctx) => findEntity(findEntitySchema.parse(params), ctx.sub),
};

export const listEntitiesTool: ToolSpec = {
  name: "list_entities",
  description:
    "List the entities in one drawer (e.g. deals, organisations) with exact field filters and a sort field. Counts keys, not pages: an entity held on two people's pages is counted once. When their header fields disagree, the field shows both values and is listed under conflicts.",
  shape: listEntitiesSchema.shape,
  run: async (params, ctx) => listEntities(listEntitiesSchema.parse(params), ctx.sub),
};

export const relatedTool: ToolSpec = {
  name: "related",
  description:
    "Pages one link away from an entity key: what it links to (out) and what links to it (in), with the reason (related list, [[link]], tag). Only pages you may see.",
  shape: relatedSchema.shape,
  run: async (params, ctx) => {
    const input = relatedSchema.parse(params);
    return { key: input.key.toLowerCase(), related: await relatedFor([input.key], input.limit, ctx.sub) };
  },
};

export const entitySchemaTool: ToolSpec = {
  name: "get_entity_schema",
  description:
    "The drawers (entity types) pages are filed in: for each, the key rule, header fields, page sections, signals, which fields may change without a person's yes, and list views. Without arguments: the templates this Engine uses (chosen at setup; base is always on). save_page accepts only these drawers. Name other templates only to look at them.",
  shape: entitySchemaSchema.shape,
  run: async (params) => {
    const input = entitySchemaSchema.parse(params);
    const chosen = await chosenTemplates();
    const schema = input.templates ? entitySchema(input.templates) : await chosenSchema();
    return { available: TEMPLATE_NAMES, chosen: ["base", ...chosen], ...schema };
  },
};
