import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  embedText: vi.fn(),
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { pageTools } = await import("../../src/tools/pages/index.js");
const { INGEST_SOURCES } = await import("../../src/tools/pages/ingest-plan.js");

const CTX = { sub: "sub-ann", email: "ann@example.com" };
const NOW = new Date("2026-11-19T12:00:00Z");

function tool(name: string) {
  const t = pageTools.find((x) => x.name === name);
  if (!t) throw new Error(`no ${name} tool`);
  return t;
}
const plan = () => tool("get_ingest_plan");

const ACME = { id: "r1", version: 1, kind: "include", name: "Acme", match: { any_address: ["@acme.com"] }, topic: "clients", private: false, broken: false };
const BOARD = { id: "r2", version: 1, kind: "include", name: "Board", match: { labels: [{ id: "Label_2", name: "Board Pack" }] }, topic: "board", private: false, broken: false };
const PERSONAL = { id: "r3", version: 1, kind: "exclude", name: "Personal", match: { labels: [{ id: "Label_9", name: "Personal" }] }, private: false, broken: false };

function rulesPlanRow(over: Record<string, unknown> = {}) {
  return {
    account_id: "a1",
    source: "gmail",
    account: "ann@work.example",
    version: 3,
    rules: [PERSONAL, ACME, BOARD],
    cursor: { last_seen: "2026-11-18T09:30:00Z", last_received_at: "2026-11-18T10:00:00Z", items_received: 7, items_saved: 5, items_skipped: 2 },
    sample_requested: false,
    backfill: false,
    backfill_from: null,
    ...over,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("get_ingest_plan: Gmail and Fireflies use the caller's rules", () => {
  it("needs an account, and asks the database by signed-in subject, never by an argument", async () => {
    await expect(plan().run({ source: "gmail" }, CTX)).rejects.toThrow(/account/);
    await expect(plan().run({ source: "fireflies" }, CTX)).rejects.toThrow(/account/);
    expect(rpcMock).not.toHaveBeenCalled();

    rpcMock.mockResolvedValue({ data: rulesPlanRow(), error: null });
    await plan().run({ source: "gmail", account: " Ann@Work.example " }, CTX);
    const [fn, args] = rpcMock.mock.calls[0]!;
    expect(fn).toBe("source_ingest_plan");
    expect(args).toEqual({ p_oauth_subject: "sub-ann", p_source: "gmail", p_account: "ann@work.example" });
  });

  it("returns a Gmail query narrowed by the rules: OR of includes, minus excludes, after since", async () => {
    rpcMock.mockResolvedValue({ data: rulesPlanRow(), error: null });
    const out = (await plan().run({ source: "gmail", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    expect(out["query"]).toBe("((from:acme.com OR to:acme.com OR cc:acme.com) OR label:board-pack) -label:personal after:2026/11/17");
    expect(out["fallback_query"]).toBe("((from:acme.com OR to:acme.com OR cc:acme.com) OR label:board-pack) -label:personal newer_than:3d");
    expect(String(out["fallback_rule"])).toMatch(/listed 0/);
    expect(out["nothing_to_record"]).toBe(false);
    expect(out["rules_version"]).toBe(3);
    expect(out["account"]).toBe("ann@work.example");
    expect((out["cursor"] as Record<string, unknown>)["items_skipped"]).toBe(2);
  });

  it("leaves broken rules out of the query, and says there is nothing to record when no include works", async () => {
    rpcMock.mockResolvedValue({ data: rulesPlanRow({ rules: [PERSONAL, { ...BOARD, broken: true }] }), error: null });
    const out = (await plan().run({ source: "gmail", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    expect(out["query"]).toBeNull();
    expect(out["nothing_to_record"]).toBe(true);
    expect((out["rules"] as Array<Record<string, unknown>>)[1]!["broken"]).toBe(true);
  });

  it("tells the run never to pass topics or an owner, and to pass account and provider", async () => {
    rpcMock.mockResolvedValue({ data: rulesPlanRow(), error: null });
    const out = (await plan().run({ source: "gmail", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    expect(String(out["record_rule"])).toMatch(/never pass topics or an owner/i);
    expect(String(out["record_rule"])).toMatch(/account = "ann@work.example"/);
    const scope = out["scope"] as Record<string, unknown>;
    expect(String(scope["source_id"])).toMatch(/message id/);
    expect(String(scope["provider"])).toMatch(/label_ids/);
  });

  it("asks for a metadata-only sample when the owner wanted one", async () => {
    rpcMock.mockResolvedValue({ data: rulesPlanRow({ sample_requested: true }), error: null });
    const out = (await plan().run({ source: "gmail", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    expect(out["sample_wanted"]).toBe(true);
    expect(String(out["report_rule"])).toMatch(/metadata ONLY \(no subject, no text\)/);
    expect(String(out["report_rule"])).toMatch(/"newer_than:7d"/);
    expect(String(out["report_rule"])).not.toMatch(/after:\d{6,}/);
    expect(String(out["report_rule"])).toMatch(/get_message|get_thread/);
    expect(out["report_with"]).toBe("report_ingest_candidates");
  });

  it("a backfill the owner asked for moves since back", async () => {
    rpcMock.mockResolvedValue({ data: rulesPlanRow({ backfill: true, backfill_from: "2026-10-01T00:00:00Z" }), error: null });
    const out = (await plan().run({ source: "gmail", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    expect(out["since"]).toBe("2026-10-01T00:00:00.000Z");
    expect(out["backfill"]).toBe(true);
  });

  it("first run looks back the default window", async () => {
    rpcMock.mockResolvedValue({ data: rulesPlanRow({ cursor: { last_seen: null, last_received_at: null } }), error: null });
    const out = (await plan().run({ source: "gmail", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    expect(out["first_run"]).toBe(true);
    expect(out["since"]).toBe("2026-11-12T12:00:00.000Z");
    expect(out["max_items"]).toBe(25);
  });

  it("Fireflies gets a filter of channels and participants from working include rules", async () => {
    rpcMock.mockResolvedValue({
      data: rulesPlanRow({
        source: "fireflies",
        rules: [
          { id: "f1", version: 1, kind: "include", match: { channels: [{ id: "ch-1", name: "Sales" }] }, topic: "clients", broken: false },
          { id: "f2", version: 1, kind: "include", match: { participants: ["@acme.com"] }, private: true, broken: false },
          { id: "f3", version: 1, kind: "include", match: { channels: [{ id: "ch-gone" }] }, topic: "clients", broken: true },
        ],
      }),
      error: null,
    });
    const out = (await plan().run({ source: "fireflies", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    expect(out["filter"]).toEqual({ channel_ids: ["ch-1"], participants: ["@acme.com"] });
    expect((out["rules"] as Array<Record<string, unknown>>)[1]!["topic"]).toBe("private (owner only)");
  });

  it("hides an unexpected database error behind a plain message", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom internal" } });
    await expect(plan().run({ source: "gmail", account: "ann@work.example" }, CTX)).rejects.toThrow(/could not be read/);
  });
});

describe("get_ingest_plan: Drive and Calendar keep the cursor plan", () => {
  it("reads the caller's own cursor by signed-in subject", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await plan().run({ source: "drive" }, CTX);
    const [fn, args] = rpcMock.mock.calls[0]!;
    expect(fn).toBe("source_cursor_get");
    expect(args).toEqual({ p_oauth_subject: "sub-ann", p_source: "drive" });
  });

  it("later run: since is the saved cursor when it is a date and time; falls back to the received time", async () => {
    rpcMock.mockResolvedValue({
      data: [{ last_seen_id: "2026-11-18T09:30:00Z", last_received_at: "2026-11-18T10:00:00Z", items_received: 7, items_saved: 6 }],
      error: null,
    });
    const out = (await plan().run({ source: "drive" }, CTX)) as Record<string, unknown>;
    expect(out["since"]).toBe("2026-11-18T09:30:00.000Z");
    rpcMock.mockResolvedValue({
      data: [{ last_seen_id: "file-abc", last_received_at: "2026-11-17T08:00:00Z", items_received: 1, items_saved: 1 }],
      error: null,
    });
    const again = (await plan().run({ source: "calendar" }, CTX)) as Record<string, unknown>;
    expect(again["since"]).toBe("2026-11-17T08:00:00.000Z");
  });

  it("gives every source a scope with a list step, a source_id rule and a body rule", async () => {
    for (const source of INGEST_SOURCES) {
      rpcMock.mockResolvedValue(
        source === "gmail" || source === "fireflies" ? { data: rulesPlanRow({ source }), error: null } : { data: [], error: null },
      );
      const out = (await plan().run({ source, account: "ann@work.example" }, CTX)) as Record<string, unknown>;
      const scope = out["scope"] as Record<string, unknown>;
      expect(typeof scope["list"]).toBe("string");
      expect(typeof scope["source_id"]).toBe("string");
      expect(typeof scope["body"]).toBe("string");
    }
  });

  it("a Fireflies item carries the summary and the full transcript, never the summary alone", async () => {
    rpcMock.mockResolvedValue({ data: rulesPlanRow({ source: "fireflies" }), error: null });
    const out = (await plan().run({ source: "fireflies", account: "ann@work.example" }, CTX)) as Record<string, unknown>;
    const body = String((out["scope"] as Record<string, unknown>)["body"]);
    expect(body).toMatch(/summary/i);
    expect(body).toMatch(/full transcript/);
    expect(body).toMatch(/never the summary alone/i);
    const skill = readFileSync(new URL("../../../plugin/qb-engine/skills/ingest/SKILL.md", import.meta.url), "utf8");
    expect(skill).toMatch(/fireflies[^\n]*summary/i);
    expect(skill).toMatch(/full transcript/);
  });

  it("refuses an unknown source or extra arguments before any database call", async () => {
    await expect(plan().run({ source: "slack" }, CTX)).rejects.toThrow();
    await expect(plan().run({ source: "drive", owner: "eve" }, CTX)).rejects.toThrow();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("report_ingest_candidates", () => {
  it("sends labels and a metadata sample for the caller's own account", async () => {
    rpcMock.mockResolvedValue({ data: { labels: 2, candidates: 1 }, error: null });
    const out = await tool("report_ingest_candidates").run(
      {
        source: "gmail",
        account: "Ann@Work.example",
        labels: [{ id: "Label_1", name: "Clients" }, { id: "Label_9", name: "Personal" }],
        labels_complete: true,
        candidates: [{ message_id: "m1", thread_id: "t1", from: "bob@acme.com", label_ids: ["Label_1"], date: "2026-11-18T10:00:00Z" }],
      },
      CTX,
    );
    const [fn, args] = rpcMock.mock.calls[0]!;
    expect(fn).toBe("source_candidates_report");
    expect(args.p_oauth_subject).toBe("sub-ann");
    expect(args.p_account).toBe("ann@work.example");
    expect(args.p_complete).toBe(true);
    expect(args.p_labels).toHaveLength(2);
    expect(out).toMatchObject({ labels: 2, candidates: 1, labels_sent: 2, system_labels_skipped: 0 });
  });

  it("says plainly that Gmail's own system labels are skipped on purpose, and counts them", async () => {
    rpcMock.mockResolvedValue({ data: { labels: 2, candidates: 0 }, error: null });
    const out = (await tool("report_ingest_candidates").run(
      {
        source: "gmail",
        account: "ann@work.example",
        labels: [
          { id: "INBOX", name: "INBOX" },
          { id: "SENT", name: "SENT" },
          { id: "UNREAD", name: "UNREAD" },
          { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS" },
          { id: "Label_1", name: "Clients" },
          { id: "Label_2", name: "Quantabase-test" },
        ],
        labels_complete: true,
      },
      CTX,
    )) as Record<string, unknown>;
    expect(out["labels_sent"]).toBe(6);
    expect(out["system_labels_skipped"]).toBe(4);
    expect(out["labels"]).toBe(2);
    expect(String(out["note"])).toMatch(/system labels .* skipped on purpose/i);
    expect(String(out["note"])).toMatch(/all 2 of your own labels are stored/i);
  });

  it("flags it when fewer of the person's own labels were stored than sent", async () => {
    rpcMock.mockResolvedValue({ data: { labels: 1, candidates: 0 }, error: null });
    const out = (await tool("report_ingest_candidates").run(
      { source: "gmail", account: "ann@work.example", labels: [{ id: "Label_1", name: "A" }, { id: "Label_2", name: "B" }], labels_complete: true },
      CTX,
    )) as Record<string, unknown>;
    expect(String(out["note"])).toMatch(/1 of your 2 own labels/i);
  });

  it("refuses a subject, body or any text in a candidate", async () => {
    for (const extra of [{ subject: "Hi" }, { body: "secret" }, { snippet: "x" }]) {
      await expect(
        tool("report_ingest_candidates").run(
          { source: "gmail", account: "ann@work.example", candidates: [{ message_id: "m1", ...extra }] },
          CTX,
        ),
      ).rejects.toThrow();
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("Fireflies channels are sent as the picker list", async () => {
    rpcMock.mockResolvedValue({ data: { labels: 1, candidates: 0 }, error: null });
    await tool("report_ingest_candidates").run(
      { source: "fireflies", account: "ann@work.example", channels: [{ id: "ch-1", name: "Sales" }], channels_complete: true },
      CTX,
    );
    expect(rpcMock.mock.calls[0]![1].p_labels).toEqual([{ id: "ch-1", name: "Sales" }]);
    expect(rpcMock.mock.calls[0]![1].p_complete).toBe(true);
  });
});
