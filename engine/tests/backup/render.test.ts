import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fileName, renderVault, type BackupPage, type LogEntry } from "../../src/backup/render.js";

const page = (over: Partial<BackupPage>): BackupPage => ({
  id: "00000000-0000-4000-8000-000000000001",
  key: "acme.com",
  drawer: "organisations",
  template: null,
  title: "Acme",
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
  body: "",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  owner: "ann@example.com",
  links: [],
  ...over,
});

const NOW = new Date("2026-11-19T03:00:00Z");

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return parse(m[1] ?? "") as Record<string, unknown>;
}

describe("file names", () => {
  it("are the title, made safe for every file system and Obsidian", () => {
    expect(fileName("Acme / Partners: 2026?")).toBe("Acme Partners 2026");
    expect(fileName("  ..hidden  ")).toBe("hidden");
    expect(fileName("a[[b]]#c^d|e")).toBe("a b c d e");
    expect(fileName("x".repeat(300))).toHaveLength(120);
    expect(fileName("///")).toBe("");
  });
});

describe("renderVault", () => {
  const acme = page({
    title: "Acme",
    aliases: ["Acme Inc"],
    description: "A client",
    tags: ["client", "big deal"],
    topics: ["clients"],
    fields: { role: "client", stage: "won" },
    related: ["bob@acme.com"],
    body: "Works with [[bob@acme.com]] and [[Bob Smith|Bob]] and [[Nobody Here]].",
    links: [
      { target_key: "bob@acme.com", reason: "related" },
      { target_key: "bob@acme.com", reason: "wikilink" },
      { target_key: "project:site", reason: "entity" },
    ],
  });
  const bob = page({
    id: "00000000-0000-4000-8000-000000000002",
    key: "bob@acme.com",
    drawer: "people",
    title: "Bob Smith",
  });
  const site = page({
    id: "00000000-0000-4000-8000-000000000003",
    key: "project:site",
    drawer: "projects",
    title: "Website rebuild",
    description: "New site",
  });

  const files = renderVault({ pages: [acme, bob, site], log: [], now: NOW, labels: { people: "People", organisations: "Organisations" } });

  it("puts each page in its drawer's folder, named by its title", () => {
    expect([...files.keys()].sort()).toEqual([
      "index.md",
      "log.md",
      "organisations/Acme.md",
      "people/Bob Smith.md",
      "projects/Website rebuild.md",
    ]);
  });

  it("writes the header as frontmatter", () => {
    const fm = frontmatter(files.get("organisations/Acme.md") ?? "");
    expect(fm).toMatchObject({
      title: "Acme",
      aliases: ["Acme Inc"],
      description: "A client",
      type: "organisations",
      key: "acme.com",
      owner: "ann@example.com",
      topics: ["clients"],
      status: "unreviewed",
      tags: ["client", "big-deal"],
      role: "client",
      stage: "won",
      created: "2026-11-01",
      updated: "2026-11-02",
    });
  });

  it("turns links into [[Title]] links and lists header-only links under related", () => {
    const text = files.get("organisations/Acme.md") ?? "";
    expect(text).toContain("Works with [[Bob Smith]] and [[Bob Smith|Bob]] and [[Nobody Here]].");
    const fm = frontmatter(text);
    expect(fm["related"]).toEqual(["[[Bob Smith]]", "[[Website rebuild]]"]);
  });

  it("builds index.md by drawer with descriptions", () => {
    const index = files.get("index.md") ?? "";
    expect(index).toContain("## Organisations\n- [[Acme]] -- A client");
    expect(index).toContain("## People\n- [[Bob Smith]]");
    expect(index).toContain("## Projects\n- [[Website rebuild]] -- New site");
    expect(index).toContain("3 pages");
  });

  it("is the same every time for the same pages", () => {
    const again = renderVault({ pages: [site, bob, acme], log: [], now: NOW, labels: { people: "People", organisations: "Organisations" } });
    expect([...again.entries()]).toEqual([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
  });

  it("keeps two pages with one title apart, case-insensitively, and links each owner to their own", () => {
    const mine = page({ title: "Acme", owner: "ann@example.com" });
    const theirs = page({ id: "00000000-0000-4000-8000-000000000009", title: "ACME", owner: "eve@example.com" });
    const eveNote = page({
      id: "00000000-0000-4000-8000-00000000000a",
      key: "concept:x",
      drawer: "concepts",
      title: "Note",
      owner: "eve@example.com",
      body: "See [[acme.com]].",
    });
    const out = renderVault({ pages: [mine, theirs, eveNote], log: [], now: NOW, labels: {} });
    expect(out.has("organisations/Acme.md")).toBe(true);
    expect(out.has("organisations/ACME (eve).md")).toBe(true);
    expect(out.get("concepts/Note.md")).toContain("See [[ACME (eve)]].");
  });

  it("writes log.md from the history, newest first, without page text", () => {
    const log: LogEntry[] = [
      { saved_at: "2026-11-18T09:30:00Z", key: "acme.com", title: "Acme", drawer: "organisations", by: "ann@example.com", first: false, deleted: false },
      { saved_at: "2026-11-17T08:00:00Z", key: "gone", title: "Old page", drawer: "concepts", by: null, first: true, deleted: true },
    ];
    const out = renderVault({ pages: [acme], log, now: NOW, labels: {} });
    const text = out.get("log.md") ?? "";
    expect(text).toContain("## 2026-11-18\n\n- 09:30 updated [[Acme]] by ann@example.com");
    expect(text).toContain("## 2026-11-17\n\n- 08:00 created Old page (since removed)");
    expect(text.indexOf("2026-11-18")).toBeLessThan(text.indexOf("2026-11-17"));
  });

  it("never lets a field overwrite a header line", () => {
    const p = page({ fields: { title: "Hijack", key: "other", next_step: "Call" } });
    const fm = frontmatter(renderVault({ pages: [p], log: [], now: NOW, labels: {} }).get("organisations/Acme.md") ?? "");
    expect(fm["title"]).toBe("Acme");
    expect(fm["key"]).toBe("acme.com");
    expect(fm["field_title"]).toBe("Hijack");
    expect(fm["next_step"]).toBe("Call");
  });

  it("writes the identity a page's key stands for, so a restore keeps it", () => {
    const person = page({ key: "ann@example.com", drawer: "people", title: "Ann", fields: { emails: ["ann@work.example"] } });
    const org = page({ id: "00000000-0000-4000-8000-00000000000b", key: "acme.com", title: "Acme" });
    const meeting = page({
      id: "00000000-0000-4000-8000-00000000000c",
      key: "meeting:ff-1",
      drawer: "meetings",
      title: "Sync",
      sources: [{ source: "fireflies", source_id: "FF-1" }],
    });
    const slugKey = page({ id: "00000000-0000-4000-8000-00000000000d", key: "concept:x", drawer: "concepts", title: "X" });
    const out = renderVault({ pages: [person, org, meeting, slugKey], log: [], now: NOW, labels: {} });
    const fm = (path: string) => frontmatter(out.get(path) ?? "");
    expect(fm("people/Ann.md")).toMatchObject({ email: "ann@example.com", emails: ["ann@work.example"] });
    expect(fm("organisations/Acme.md")).toMatchObject({ domain: "acme.com" });
    expect(fm("meetings/Sync.md")).toMatchObject({ fireflies_id: "FF-1" });
    const x = fm("concepts/X.md");
    expect(x["email"]).toBeUndefined();
    expect(x["domain"]).toBeUndefined();
    expect(x["fireflies_id"]).toBeUndefined();
  });

  it("never lets an identity hint overwrite a field of the same name", () => {
    const p = page({ key: "ann@example.com", drawer: "people", title: "Ann", fields: { email: "other@example.com" } });
    const fm = frontmatter(renderVault({ pages: [p], log: [], now: NOW, labels: {} }).get("people/Ann.md") ?? "");
    expect(fm["email"]).toBe("other@example.com");
  });

  it("lists only related links under related, not tags", () => {
    const tagged = page({ tags: ["acme"], links: [{ target_key: "acme", reason: "tag" }] });
    const other = page({ id: "00000000-0000-4000-8000-00000000000e", key: "acme", drawer: "concepts", title: "Tag page" });
    const fm = frontmatter(renderVault({ pages: [tagged, other], log: [], now: NOW, labels: {} }).get("organisations/Acme.md") ?? "");
    expect(fm["related"]).toEqual([]);
  });

  it("ends every body with one added newline, so a restore can take exactly that one off", () => {
    const out = renderVault({
      pages: [
        page({ body: "no newline" }),
        page({ id: "00000000-0000-4000-8000-00000000000f", key: "b.com", title: "B", body: "two newlines\n\n" }),
      ],
      log: [],
      now: NOW,
      labels: {},
    });
    expect(out.get("organisations/Acme.md")?.endsWith("\n\nno newline\n")).toBe(true);
    expect(out.get("organisations/B.md")?.endsWith("\n\ntwo newlines\n\n\n")).toBe(true);
  });

  it("keeps a body that starts with --- out of the header", () => {
    const p = page({ body: "---\ntitle: fake\n---\ntext" });
    const text = renderVault({ pages: [p], log: [], now: NOW, labels: {} }).get("organisations/Acme.md") ?? "";
    expect(frontmatter(text)["title"]).toBe("Acme");
    expect(text).toContain("\n\n---\ntitle: fake");
  });
});
