import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  embedText: vi.fn(),
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { pageTools } = await import("../../src/tools/pages/index.js");

const CTX = { sub: "sub-ann", email: "ann@example.com" };
const tool = () => {
  const t = pageTools.find((x) => x.name === "report_mail_contacts");
  if (!t) throw new Error("no report_mail_contacts tool");
  return t;
};

const REPORT = {
  account: " Ann@Work.example ",
  days: 90,
  messages_read: 12,
  addresses: [
    { address: "bob@acme.example", sent_to: 4, received_from: 2, threads: 3, replied: 1, last_seen: "2026-11-20T10:00:00Z", free_mail: false },
    { address: "noreply@acme.example", sent_to: 0, received_from: 9, threads: 9, replied: 0, last_seen: null },
  ],
  domains: [
    { domain: "acme.example", sent_to: 4, received_from: 2, threads: 3, replied: 1, last_seen: "2026-11-20T10:00:00Z", people: 1 },
    { domain: "gmail.com", sent_to: 2, received_from: 0, threads: 2, replied: 0, last_seen: null, people: 2 },
  ],
  dropped: { bulk: 1, category: 4 },
};

beforeEach(() => rpcMock.mockReset());

describe("report_mail_contacts", () => {
  it("is offered to every signed-in person and says it stores counts only", () => {
    expect(tool().description).toMatch(/counts/i);
    expect(tool().description).toMatch(/never/i);
  });

  it("sends counts for the caller's own account, by signed-in subject, minus bulk and free-mail domains", async () => {
    rpcMock.mockResolvedValue({ data: { addresses: 1, domains: 1 }, error: null });
    const out = (await tool().run(REPORT, CTX)) as Record<string, unknown>;
    const [fn, args] = rpcMock.mock.calls[0]!;
    expect(fn).toBe("source_contacts_report");
    expect(args).toMatchObject({ p_oauth_subject: "sub-ann", p_account: "ann@work.example", p_days: 90, p_messages: 12 });
    const rows = (args as { p_contacts: Array<Record<string, unknown>> }).p_contacts;
    expect(rows.map((r) => `${String(r["kind"])}:${String(r["value"])}`)).toEqual(["address:bob@acme.example", "domain:acme.example"]);
    expect(JSON.stringify(rows)).not.toMatch(/subject|snippet|message_id|body/);
    expect(out).toMatchObject({ addresses: 1, domains: 1, left_out: 2 });
    expect(String(out["next"])).toMatch(/Sources/);
    expect(String(out["next"])).not.toMatch(/Subscriptions/);
  });

  it("passes the person's picks on as chosen, and says they are ticked on the Sources screen", async () => {
    rpcMock.mockResolvedValue({ data: { addresses: 1, domains: 1 }, error: null });
    const picked = { ...REPORT, domains: [{ ...REPORT.domains[0], chosen: true }] };
    const out = (await tool().run(picked, CTX)) as Record<string, unknown>;
    const rows = (rpcMock.mock.calls[0]![1] as { p_contacts: Array<Record<string, unknown>> }).p_contacts;
    expect(rows.map((r) => r["chosen"])).toEqual([null, true]);
    expect(String(out["next"])).toMatch(/ticked/);
    expect(String(out["next"])).toMatch(/save/i);
  });

  it("refuses anything that is not a count, before any database call", async () => {
    for (const bad of [
      { ...REPORT, addresses: [{ ...REPORT.addresses[0], subject: "Q3" }] },
      { ...REPORT, snippets: ["hi"] },
      { ...REPORT, account: "nobody" },
      { ...REPORT, days: 0 },
    ]) {
      await expect(tool().run(bad, CTX)).rejects.toThrow();
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("passes the database's own refusal on", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "22023", message: "suggestions exist for gmail accounts only" } });
    await expect(tool().run(REPORT, CTX)).rejects.toThrow(/gmail accounts only/);
  });
});
