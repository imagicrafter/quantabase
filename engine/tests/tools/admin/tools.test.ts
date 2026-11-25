import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../../src/supabase.js", () => ({
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { adminTools } = await import("../../../src/tools/admin/index.js");
const { NEXT_STEP } = await import("../../../src/tools/admin/rpc.js");

const CTX = { sub: "sub-admin", email: "admin-a@example.com" };
const CODE = "0123456789abcdef0123456789abcdef";
const EXPIRES = "2026-01-01T00:10:00+00:00";

function tool(name: string) {
  const found = adminTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function previewAnswer(text: string) {
  return {
    data: { preview: text, confirm_code: CODE, expires_at: EXPIRES },
    error: null,
  };
}

type Case = {
  name: string;
  fn: string;
  input: Record<string, unknown>;
  args: Record<string, unknown>;
};

const CASES: Case[] = [
  {
    name: "admin_add_person",
    fn: "admin_person_add",
    input: {
      email: " New@Example.com ",
      display_name: " New Person ",
      role: "reader",
    },
    args: {
      p_new_email: "new@example.com",
      p_display_name: "New Person",
      p_role: "reader",
      p_admin_ack: false,
    },
  },
  {
    name: "admin_grant_topic",
    fn: "admin_grant",
    input: { person_email: "Rita@Example.com", topic: "consulting" },
    args: {
      p_person_email: "rita@example.com",
      p_topic: "consulting",
      p_sensitive_ack: false,
    },
  },
  {
    name: "admin_revoke_topic",
    fn: "admin_revoke",
    input: { person_email: "rita@example.com", topic: "consulting" },
    args: { p_person_email: "rita@example.com", p_topic: "consulting" },
  },
  {
    name: "admin_deactivate_person",
    fn: "admin_person_deactivate",
    input: { person_email: "rita@example.com" },
    args: { p_person_email: "rita@example.com" },
  },
  {
    name: "admin_reactivate_person",
    fn: "admin_person_reactivate",
    input: { person_email: " Rita@Example.com " },
    args: { p_person_email: "rita@example.com" },
  },
];

describe("admin tools: the set", () => {
  it("is the ten tools, each marked administrators only", () => {
    expect(adminTools.map((t) => t.name)).toEqual([
      "admin_list_people",
      "admin_add_person",
      "admin_grant_topic",
      "admin_revoke_topic",
      "admin_deactivate_person",
      "admin_reactivate_person",
      "admin_list_issues",
      "list_tickets",
      "get_ticket",
      "add_ticket_note",
    ]);
    for (const t of adminTools) {
      expect(t.description).toContain("Administrators only");
    }
  });

  it("every changing tool tells the model never to invent or reuse a code", () => {
    for (const c of CASES) {
      const description = tool(c.name).description;
      expect(description).toContain(
        "Never invent, guess or reuse a confirmation code",
      );
      expect(description).toContain("explicit yes");
      expect(Object.keys(tool(c.name).shape)).toContain("confirm_code");
    }
  });
});

describe.each(CASES)("$name", ({ name, fn, input, args }) => {
  beforeEach(() => rpcMock.mockReset());

  it("without a code: calls the preview function only and returns the code with instructions", async () => {
    rpcMock.mockResolvedValue(previewAnswer("What will change."));
    const result = await tool(name).run(input, CTX);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(`${fn}_preview`, {
      p_email: "admin-a@example.com",
      ...args,
    });
    expect(result).toEqual({
      status: "confirmation_required",
      preview: "What will change.",
      confirm_code: CODE,
      expires_at: EXPIRES,
      next_step: NEXT_STEP,
    });
    expect(NEXT_STEP).toContain("NOTHING HAS CHANGED YET");
    expect(NEXT_STEP).toContain("explicit yes");
    expect(NEXT_STEP).toContain("Never invent");
  });

  it("with a code: calls the apply function only, with the same arguments plus the code", async () => {
    rpcMock.mockResolvedValue({
      data: { applied: true, summary: "Done thing." },
      error: null,
    });
    const result = await tool(name).run({ ...input, confirm_code: CODE }, CTX);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(`${fn}_apply`, {
      p_email: "admin-a@example.com",
      ...args,
      p_code: CODE,
    });
    expect(result).toEqual({ status: "applied", summary: "Done thing." });
  });

  it("maps 42501 to forbidden without passing on database text", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied for function x" },
    });
    await expect(tool(name).run(input, CTX)).rejects.toMatchObject({
      code: "forbidden",
      message: "Administrators only",
    });
    await expect(
      tool(name).run({ ...input, confirm_code: CODE }, CTX),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Administrators only",
    });
  });

  it.each([
    ["KB001", "forbidden", "refused by a guard"],
    [
      "KB002",
      "invalid_argument",
      "confirmation code is not valid for this change; ask for a new preview",
    ],
    ["22023", "invalid_argument", "unknown topic"],
  ])("passes on the message of %s as %s", async (code, expected, message) => {
    rpcMock.mockResolvedValue({ data: null, error: { code, message } });
    await expect(
      tool(name).run({ ...input, confirm_code: CODE }, CTX),
    ).rejects.toMatchObject({ code: expected, message });
  });

  it("hides any other database error", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: "duplicate key value (rita@example.com)",
      },
    });
    await expect(tool(name).run(input, CTX)).rejects.toMatchObject({
      code: "internal_error",
      message: "The admin request failed",
    });
  });

  it("refuses a code that is not in the shape a preview returns, before any database call", async () => {
    for (const bad of ["", "yes", "1234", CODE.toUpperCase(), `${CODE}0`]) {
      await expect(
        tool(name).run({ ...input, confirm_code: bad }, CTX),
      ).rejects.toThrow();
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("refuses unknown arguments, so the acting administrator cannot be set by the caller", async () => {
    await expect(
      tool(name).run({ ...input, p_email: "someone@example.com" }, CTX),
    ).rejects.toThrow();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed answer", async () => {
    rpcMock.mockResolvedValue({ data: { preview: "x" }, error: null });
    await expect(tool(name).run(input, CTX)).rejects.toMatchObject({
      code: "internal_error",
    });
    rpcMock.mockResolvedValue({ data: { applied: false }, error: null });
    await expect(
      tool(name).run({ ...input, confirm_code: CODE }, CTX),
    ).rejects.toMatchObject({ code: "internal_error" });
    rpcMock.mockResolvedValue({ data: null, error: null });
    await expect(tool(name).run(input, CTX)).rejects.toMatchObject({
      code: "internal_error",
    });
  });
});

describe("admin tools: acknowledgements and input checks", () => {
  beforeEach(() => rpcMock.mockReset());

  it("passes the acknowledgements through on both steps", async () => {
    rpcMock.mockResolvedValue(previewAnswer("x"));
    await tool("admin_grant_topic").run(
      {
        person_email: "rita@example.com",
        topic: "private",
        sensitive_ack: true,
      },
      CTX,
    );
    expect(rpcMock.mock.calls[0]![1].p_sensitive_ack).toBe(true);

    rpcMock.mockResolvedValue({
      data: { applied: true, summary: "s" },
      error: null,
    });
    await tool("admin_add_person").run(
      {
        email: "new@example.com",
        display_name: "New",
        role: "administrator",
        admin_ack: true,
        confirm_code: CODE,
      },
      CTX,
    );
    expect(rpcMock.mock.calls[1]![0]).toBe("admin_person_add_apply");
    expect(rpcMock.mock.calls[1]![1].p_admin_ack).toBe(true);
  });

  it.each([
    [
      "admin_add_person",
      { email: "not-an-email", display_name: "N", role: "reader" },
    ],
    [
      "admin_add_person",
      { email: "a@example.com", display_name: "", role: "reader" },
    ],
    [
      "admin_add_person",
      { email: "a@example.com", display_name: "N", role: "owner" },
    ],
    [
      "admin_add_person",
      {
        email: "a@example.com",
        display_name: "N",
        role: "reader",
        admin_ack: "yes",
      },
    ],
    [
      "admin_grant_topic",
      { person_email: "a@example.com", topic: "Not A Topic" },
    ],
    [
      "admin_grant_topic",
      { person_email: "a@example.com", topic: "x'; drop table" },
    ],
    ["admin_grant_topic", { person_email: "nope", topic: "consulting" }],
    ["admin_revoke_topic", { person_email: "a@example.com" }],
    ["admin_deactivate_person", {}],
    ["admin_reactivate_person", {}],
    ["admin_reactivate_person", { person_email: "nope" }],
    ["admin_list_issues", { all: true }],
    ["admin_list_people", { extra: 1 }],
    ["list_tickets", { status: "maybe" }],
    ["get_ticket", { ref: "12; drop" }],
    ["get_ticket", {}],
    ["add_ticket_note", { ref: "QB-0001", note: "" }],
    ["add_ticket_note", { ref: "QB-0001", note: "x".repeat(2001) }],
  ])(
    "%s rejects bad input %j before any database call",
    async (name, input) => {
      await expect(tool(name).run(input, CTX)).rejects.toThrow();
      expect(rpcMock).not.toHaveBeenCalled();
    },
  );
});

describe("admin_list_people", () => {
  beforeEach(() => rpcMock.mockReset());

  it("returns the people the database lists", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          handle: "rita",
          display_name: "Rita Reader",
          email: "rita@example.com",
          role: "reader",
          active: true,
          topics: ["consulting"],
        },
        {
          handle: "svc",
          display_name: "Service",
          email: null,
          role: "reader",
          active: false,
        },
      ],
      error: null,
    });
    const result = await tool("admin_list_people").run({}, CTX);
    expect(rpcMock).toHaveBeenCalledWith("admin_people_list", {
      p_email: "admin-a@example.com",
    });
    expect(result).toEqual({
      people: [
        {
          handle: "rita",
          display_name: "Rita Reader",
          email: "rita@example.com",
          role: "reader",
          active: true,
          topics: ["consulting"],
        },
        {
          handle: "svc",
          display_name: "Service",
          email: null,
          role: "reader",
          active: false,
          topics: [],
        },
      ],
    });
  });

  it("maps 42501 to forbidden and a malformed answer to an internal error", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "x" },
    });
    await expect(tool("admin_list_people").run({}, CTX)).rejects.toMatchObject({
      code: "forbidden",
      message: "Administrators only",
    });
    rpcMock.mockResolvedValue({ data: { not: "a list" }, error: null });
    await expect(tool("admin_list_people").run({}, CTX)).rejects.toMatchObject({
      code: "internal_error",
    });
  });
});

describe("admin_reactivate_person", () => {
  it("says in its description that it gives access back", () => {
    const description = tool("admin_reactivate_person").description;
    expect(description).toContain("deactivated");
    expect(description).toContain("role and topics");
  });
});

describe("admin_list_issues", () => {
  beforeEach(() => rpcMock.mockReset());

  it("returns the open issues and the fixed count the database gives", async () => {
    rpcMock.mockResolvedValue({
      data: {
        open: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            category: "source_failure",
            source: "drive",
            title: "Drive job failed",
            status: "open",
            opened_at: "2026-01-01T00:00:00+00:00",
            occurrences: 3,
            has_card: false,
            detail: "must not be passed on",
          },
          { id: "22222222-2222-4222-8222-222222222222" },
        ],
        fixed_last_30_days: 4,
      },
      error: null,
    });
    const result = await tool("admin_list_issues").run({}, CTX);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("issues_summary", {
      p_email: "admin-a@example.com",
    });
    expect(result).toEqual({
      open_count: 2,
      open: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          category: "source_failure",
          source: "drive",
          title: "Drive job failed",
          status: "open",
          opened_at: "2026-01-01T00:00:00+00:00",
          occurrences: 3,
          has_card: false,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          category: "",
          source: null,
          title: "",
          status: "",
          opened_at: "",
          occurrences: 0,
          has_card: false,
        },
      ],
      fixed_last_30_days: 4,
    });
  });

  it("an Engine with no issues answers with an empty list", async () => {
    rpcMock.mockResolvedValue({
      data: { open: [], fixed_last_30_days: 0 },
      error: null,
    });
    expect(await tool("admin_list_issues").run({}, CTX)).toEqual({
      open_count: 0,
      open: [],
      fixed_last_30_days: 0,
    });
  });

  it("maps 42501 to forbidden and a malformed answer to an internal error", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "x" },
    });
    await expect(tool("admin_list_issues").run({}, CTX)).rejects.toMatchObject({
      code: "forbidden",
      message: "Administrators only",
    });
    for (const data of [null, [], { open: "nope" }, "text"]) {
      rpcMock.mockResolvedValue({ data, error: null });
      await expect(
        tool("admin_list_issues").run({}, CTX),
      ).rejects.toMatchObject({ code: "internal_error" });
    }
  });
});

describe("ticket tools", () => {
  beforeEach(() => rpcMock.mockReset());
  const ROW = {
    ref: "QB-0012", step: "author", kind: "curator_failed", title: "The curator's last run failed",
    what_happened: "It stopped.", what_to_do: "Look.", status: "open", opened_at: "2026-11-22T10:00:00Z",
    last_seen_at: "2026-11-22T11:00:00Z", cleared_at: "2026-11-22T12:00:00Z", closed_at: null, closed_by: null,
    dedupe_key: "must not be passed on",
  };

  it("list_tickets passes the status (all = null) and returns only the named fields", async () => {
    rpcMock.mockResolvedValue({ data: [ROW], error: null });
    const result = (await tool("list_tickets").run({}, CTX)) as { count: number; tickets: Record<string, unknown>[] };
    expect(rpcMock).toHaveBeenCalledWith("admin_tickets_list", { p_email: "admin-a@example.com", p_status: "open" });
    expect(result.count).toBe(1);
    expect(result.tickets[0]).toMatchObject({ ref: "QB-0012", looks_fixed_since: "2026-11-22T12:00:00Z" });
    expect(result.tickets[0]).not.toHaveProperty("dedupe_key");
    await tool("list_tickets").run({ status: "all" }, CTX);
    expect(rpcMock).toHaveBeenLastCalledWith("admin_tickets_list", { p_email: "admin-a@example.com", p_status: null });
  });

  it("get_ticket upper-cases the id, returns the notes, and says not_found for none", async () => {
    rpcMock.mockResolvedValue({ data: { ...ROW, notes: [{ at: "2026-11-22T13:00:00Z", by: "a@example.com", body: "Checked." }] }, error: null });
    const result = (await tool("get_ticket").run({ ref: " qb-0012 " }, CTX)) as Record<string, unknown>;
    expect(rpcMock).toHaveBeenCalledWith("admin_ticket_get", { p_email: "admin-a@example.com", p_ref: "QB-0012" });
    expect(result["notes"]).toEqual([{ at: "2026-11-22T13:00:00Z", by: "a@example.com", note: "Checked." }]);
    rpcMock.mockResolvedValue({ data: null, error: null });
    await expect(tool("get_ticket").run({ ref: "QB-9" }, CTX)).rejects.toMatchObject({ code: "not_found" });
  });

  it("add_ticket_note adds a note and never closes; a refusal maps to forbidden", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    expect(await tool("add_ticket_note").run({ ref: "QB-0012", note: " Found it. " }, CTX)).toEqual({ status: "added", ref: "QB-0012" });
    expect(rpcMock).toHaveBeenCalledWith("admin_ticket_note", { p_email: "admin-a@example.com", p_ref: "QB-0012", p_body: "Found it." });
    expect(tool("add_ticket_note").description).toContain("never closes");
    rpcMock.mockResolvedValue({ data: false, error: null });
    await expect(tool("add_ticket_note").run({ ref: "QB-1", note: "x" }, CTX)).rejects.toMatchObject({ code: "not_found" });
    rpcMock.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    await expect(tool("list_tickets").run({}, CTX)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("no tool closes a ticket", () => {
    expect(adminTools.some((t) => /close/i.test(t.name))).toBe(false);
  });
});
