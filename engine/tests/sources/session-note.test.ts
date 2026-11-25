import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NOTE_LABELS, NOTE_MAX_CHARS, NOTE_SOURCES, evidenceText, isNoteSource, noteTitle, renderNote, sessionNoteSchema,
} from "../../src/sources/session-note.js";
import { NOTE } from "./note-fixture.js";

describe("session note schema", () => {
  it("accepts a well-formed note", () => {
    expect(sessionNoteSchema.parse(NOTE).items).toHaveLength(2);
    expect(NOTE_LABELS).toEqual(["decided", "fact", "status", "how-to", "idea"]);
    expect(NOTE_SOURCES).toEqual(["claude-code"]);
    expect(isNoteSource("claude-code")).toBe(true);
    expect(isNoteSource("gmail")).toBe(false);
  });

  it.each([
    ["an unknown label", { ...NOTE, items: [{ ...NOTE.items[0], label: "maybe" }] }],
    ["no items", { ...NOTE, items: [] }],
    ["an item with no quote", { ...NOTE, items: [{ ...NOTE.items[0], quotes: [] }] }],
    ["four quotes", { ...NOTE, items: [{ ...NOTE.items[0], quotes: Array(4).fill({ who: "owner", text: "x" }) }] }],
    ["a long quote", { ...NOTE, items: [{ ...NOTE.items[0], quotes: [{ who: "owner", text: "q".repeat(401) }] }] }],
    ["an item backed only by tool output", { ...NOTE, items: [{ ...NOTE.items[0], quotes: [{ who: "tool", text: "3 passed" }] }] }],
    ["a quote by someone else", { ...NOTE, items: [{ ...NOTE.items[0], quotes: [{ who: "bob", text: "x" }] }] }],
    ["page text in a hint", { ...NOTE, items: [{ ...NOTE.items[0], pages: [{ key: "k", title: "t", whats_new: "w", patches: [] }] }] }],
    ["a key with spaces", { ...NOTE, items: [{ ...NOTE.items[0], pages: [{ key: "a b", title: "t", whats_new: "w" }] }] }],
    ["a bad drawer", { ...NOTE, items: [{ ...NOTE.items[1], new_pages: [{ drawer: "Bad Drawer", title: "t", why: "w" }] }] }],
    ["a topic claim", { ...NOTE, topics: ["clients"] }],
    ["too many items", { ...NOTE, items: Array(31).fill(NOTE.items[0]) }],
  ])("refuses %s", (_what, bad) => {
    expect(sessionNoteSchema.safeParse(bad).success).toBe(false);
  });
});

describe("rendering", () => {
  it("is readable markdown with labels, exact quotes and page hints", () => {
    const md = renderNote(sessionNoteSchema.parse(NOTE));
    expect(md).toMatch(/^# Session note: demo-project\n/);
    expect(md).toContain("Session 0b5c6c1e-1111-4222-8333-944455556666, 2026-11-24 09:00 to 2026-11-24 11:30 UTC");
    expect(md).toContain("## 1. [decided] Release 2.0 ships on 2026-12-01, not in November.");
    expect(md).toContain('> Owner: "ok, let\'s ship 2.0 on Dec 1 instead"');
    expect(md).toContain('> Assistant: "One option is a nightly export to the shared drive."');
    expect(md).toContain("- project:northwind-route-pilot (Northwind pilot): new ship date 2026-12-01");
    expect(md).toContain("- decisions: Nightly export (key decision:nightly-export): may become a decision");
    expect(md).toContain("## 2. [idea]");
  });

  it("stays small even at the most items", () => {
    const big = { ...NOTE, items: Array(30).fill({ ...NOTE.items[0], text: "t".repeat(600), quotes: Array(3).fill({ who: "owner", text: "q".repeat(400) }) }) };
    const parsed = sessionNoteSchema.safeParse(big);
    expect(parsed.success).toBe(false);
    expect(NOTE_MAX_CHARS).toBeLessThanOrEqual(30_000);
  });

  it("titles the note from its own title, else from the project and the end date", () => {
    expect(noteTitle(sessionNoteSchema.parse(NOTE))).toBe("Session note: demo-project, 2026-11-24");
    expect(noteTitle(sessionNoteSchema.parse({ ...NOTE, title: "Release date" }))).toBe("Release date");
    expect(sessionNoteSchema.safeParse({ ...NOTE, title: "t".repeat(121) }).success).toBe(false);
  });
});

describe("evidence for the Fact-checker", () => {
  it("is the quotes and labels only, never the summary prose", () => {
    const ev = evidenceText(sessionNoteSchema.parse(NOTE));
    expect(ev).toContain("ok, let's ship 2.0 on Dec 1 instead");
    expect(ev).toContain("Item 2 (idea: floated, not decided)");
    expect(ev).not.toContain("Release 2.0 ships on 2026-12-01, not in November.");
    expect(ev).not.toContain("whats_new");
    expect(ev).not.toContain("new ship date");
    const withTool = sessionNoteSchema.parse({ ...NOTE, items: [{ ...NOTE.items[0], quotes: [...NOTE.items[0].quotes, { who: "tool", text: "3 passed" }] }] });
    expect(evidenceText(withTool)).not.toContain("3 passed");
  });
});

describe("the same text as the plugin's preview", () => {
  it("renders the shared fixture exactly as the plugin's note_check.py does", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
    const note = sessionNoteSchema.parse(JSON.parse(readFileSync(join(dir, "session-note.json"), "utf8")));
    expect(renderNote(note)).toBe(readFileSync(join(dir, "session-note.md"), "utf8"));
  });
});
