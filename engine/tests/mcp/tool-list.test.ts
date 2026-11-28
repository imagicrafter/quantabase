import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  embedText: vi.fn(),
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { createMcpServer, authContextStore } =
  await import("../../src/mcp/server.js");

const READER = { sub: "sub-reader", email: "rita@example.com" };
const ADMIN_TOOLS = [
  "add_ticket_note",
  "admin_add_person",
  "admin_deactivate_person",
  "admin_grant_topic",
  "admin_list_issues",
  "admin_list_people",
  "admin_reactivate_person",
  "admin_revoke_topic",
  "get_ticket",
  "list_tickets",
];
const EVERYONE_TOOLS = [
  "find_entity",
  "get_document",
  "get_entity_schema",
  "get_ingest_plan",
  "get_source_item",
  "get_wiki_page",
  "list_entities",
  "record_source_item",
  "related",
  "report_ingest_candidates",
  "report_issue",
  "report_mail_contacts",
  "save_page",
  "search",
  "update_page",
  "who_knows",
];

async function connect(options?: { isAdmin?: boolean }) {
  const server = createMcpServer("instructions", options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function toolNames(options?: { isAdmin?: boolean }): Promise<string[]> {
  const client = await connect(options);
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

describe("tool list per caller", () => {
  beforeEach(() => rpcMock.mockReset());

  it("hides every admin tool unless the caller is an administrator", async () => {
    expect(await toolNames()).toEqual(EVERYONE_TOOLS);
    expect(await toolNames({})).toEqual(EVERYONE_TOOLS);
    expect(await toolNames({ isAdmin: false })).toEqual(EVERYONE_TOOLS);
  });

  it("lists the admin tools for an administrator", async () => {
    expect(await toolNames({ isAdmin: true })).toEqual(
      [...ADMIN_TOOLS, ...EVERYONE_TOOLS].sort(),
    );
  });

  it("a non-administrator cannot call a hidden admin tool, and no database call is made", async () => {
    const client = await connect({ isAdmin: false });
    const outcome = await authContextStore.run(READER, () =>
      client
        .callTool({
          name: "admin_grant_topic",
          arguments: { person_email: "rita@example.com", topic: "consulting" },
        })
        .then(
          (r) => ({ isError: r.isError === true }),
          () => ({ isError: true }),
        ),
    );
    expect(outcome.isError).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("report_issue reaches the database with the session's email and returns the id", async () => {
    rpcMock.mockResolvedValue({ data: "issue-id-1", error: null });
    const client = await connect();
    const result = await authContextStore.run(READER, () =>
      client.callTool({
        name: "report_issue",
        arguments: { category: "feature_gap", title: "A real title" },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("issue-id-1");
    expect(rpcMock.mock.calls[0]![1].p_email).toBe("rita@example.com");
  });

  it("a refused admin call comes back as a tool error, not a crash", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "x" },
    });
    const client = await connect({ isAdmin: true });
    const result = await authContextStore.run(READER, () =>
      client.callTool({ name: "admin_list_people", arguments: {} }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "[forbidden] Administrators only",
    );
  });
});
