import { z } from "zod";
import { McpAppError } from "../../mcp/errors.js";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { callAdmin } from "./rpc.js";

export const listPeopleSchema = z.object({}).strict();

export type Person = {
  readonly handle: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly role: string;
  readonly active: boolean;
  readonly topics: readonly string[];
};

function toPerson(row: unknown): Person {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    handle: String(r["handle"] ?? ""),
    display_name: String(r["display_name"] ?? ""),
    email: r["email"] != null ? String(r["email"]) : null,
    role: String(r["role"] ?? ""),
    active: r["active"] === true,
    topics: Array.isArray(r["topics"]) ? r["topics"].map(String) : [],
  };
}

export async function listPeople(email: string): Promise<{ people: Person[] }> {
  const data = await callAdmin("admin_people_list", email);
  if (!Array.isArray(data)) {
    throw new McpAppError("internal_error", "The admin request failed");
  }
  return { people: data.map(toPerson) };
}

export const listPeopleTool: ToolSpec = {
  name: "admin_list_people",
  description:
    "Administrators only. List everyone on this Engine: name, email, role, whether they are active, and the topics granted to them. Read-only. Note: an administrator also sees every topic that is not marked sensitive, whether or not it is listed for them.",
  shape: listPeopleSchema.shape,
  run: async (params, ctx) => {
    listPeopleSchema.parse(params);
    return listPeople(ctx.email);
  },
};
