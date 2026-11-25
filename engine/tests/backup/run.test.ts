import { describe, expect, it, vi } from "vitest";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { drawerLabels, runBackup, type BackupStore } from "../../src/backup/run.js";
import type { BackupPage } from "../../src/backup/render.js";
import { fakeGitHub } from "./fake-github.js";

const pageRow = (i: number): BackupPage => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  key: `concept:p${i}`,
  drawer: "concepts",
  template: null,
  title: `Page ${i}`,
  aliases: [],
  description: null,
  fields: {},
  topics: [],
  status: "unreviewed",
  reviewed: null,
  tags: [],
  related: [],
  sources: [],
  generated: null,
  verified: [],
  body: `Body ${i}`,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  owner: "ann@example.com",
  links: [],
});

function store(over: Partial<BackupStore> = {}, total = 3) {
  const rows = Array.from({ length: total }, (_, i) => pageRow(i + 1));
  const s = {
    claim: vi.fn(async () => ({ repo: "acme/kb-backup", branch: "main" })),
    token: vi.fn(async () => "ghp_faketoken000000000000" as string | null),
    pages: vi.fn(async (after: string | null, limit: number) => rows.filter((r) => after === null || r.id > after).slice(0, limit)),
    log: vi.fn(async () => []),
    finish: vi.fn(async () => undefined),
    ...over,
  };
  return s;
}

const NOW = () => new Date("2026-11-19T03:00:00Z");

describe("runBackup", () => {
  it("does nothing but ask when no backup is due", async () => {
    const s = store({ claim: vi.fn(async () => null) });
    const gh = fakeGitHub();
    expect(await runBackup({ store: s, fetch: gh.fetch, now: NOW, allowHost: () => undefined })).toBe("not_due");
    expect(s.token).not.toHaveBeenCalled();
    expect(gh.requests).toHaveLength(0);
  });

  it("writes every page, index and log, then records the commit", async () => {
    const s = store();
    const gh = fakeGitHub();
    const allowHost = vi.fn();
    expect(await runBackup({ store: s, fetch: gh.fetch, now: NOW, allowHost })).toBe("done");
    expect(allowHost).toHaveBeenCalledWith("api.github.com");
    expect([...gh.filesOn("main").keys()].sort()).toEqual([
      "concepts/Page 1.md", "concepts/Page 2.md", "concepts/Page 3.md", "index.md", "log.md",
    ]);
    expect(s.finish).toHaveBeenCalledWith(true, "done", expect.stringMatching(/^c/), 5, null);
  });

  it("reads pages a page of rows at a time", async () => {
    const s = store({}, 450);
    const gh = fakeGitHub();
    await runBackup({ store: s, fetch: gh.fetch, now: NOW, allowHost: () => undefined });
    expect(s.pages).toHaveBeenCalledTimes(3);
    expect(s.pages.mock.calls[1]?.[0]).toBe(pageRow(200).id);
    expect(gh.filesOn("main").size).toBe(452);
  });

  it("records 'unchanged' when the repository already matches", async () => {
    const s = store();
    const gh = fakeGitHub();
    await runBackup({ store: s, fetch: gh.fetch, now: NOW, allowHost: () => undefined });
    expect(await runBackup({ store: s, fetch: gh.fetch, now: NOW, allowHost: () => undefined })).toBe("unchanged");
    expect(s.finish).toHaveBeenLastCalledWith(true, "unchanged", expect.any(String), 5, null);
  });

  it("fails without a token and says why, without touching GitHub", async () => {
    const s = store({ token: vi.fn(async () => null) });
    const gh = fakeGitHub();
    expect(await runBackup({ store: s, fetch: gh.fetch, now: NOW, allowHost: () => undefined })).toBe("failed");
    expect(s.finish).toHaveBeenCalledWith(false, null, null, null, expect.stringMatching(/kbe_backup_token/));
    expect(gh.requests).toHaveLength(0);
  });

  it("never puts the token in a log line or the stored error", async () => {
    const logs = _captureLogsForTests();
    try {
      const token = "ghp_sekrit_token_value_0000";
      const s = store({ token: vi.fn(async () => token) });
      const gh = fakeGitHub({ token: "ghp_other_token_value_00000" });
      expect(await runBackup({ store: s, fetch: gh.fetch, now: NOW, allowHost: () => undefined })).toBe("failed");
      const stored = JSON.stringify(s.finish.mock.calls);
      expect(stored).toMatch(/HTTP 401/);
      expect(stored).not.toContain(token);
      expect(logs.lines().join("\n")).toMatch(/backup failed/);
      expect(logs.lines().join("\n")).not.toContain(token);
    } finally {
      logs.stop();
    }
  });
});

describe("drawerLabels", () => {
  it("reads labels from the templates", () => {
    expect(drawerLabels()).toMatchObject({ people: "People", organisations: "Organisations" });
  });
});
