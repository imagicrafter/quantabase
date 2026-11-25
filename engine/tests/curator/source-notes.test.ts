import { describe, expect, it } from "vitest";
import { entitySchema } from "../../src/entities/templates.js";
import { buildPrompt, buildWriterPrompt } from "../../src/curator/prompt.js";
import { sourceNote } from "../../src/curator/source-notes.js";
import { buildTriagePrompt } from "../../src/curator/triage.js";
import { renderNote, sessionNoteSchema } from "../../src/sources/session-note.js";
import { NOTE } from "../sources/note-fixture.js";
import { item } from "./fixtures.js";

const schema = entitySchema(["consulting"]);
const session = item({ source: "claude-code", source_id: NOTE.session_id, body: renderNote(sessionNoteSchema.parse(NOTE)), metadata: { note: NOTE } });

describe("source notes", () => {
  it("only session notes get one", () => {
    for (const s of ["gmail", "fireflies", "drive", "calendar", "unknown"]) expect(sourceNote(s)).toBe("");
    expect(sourceNote("claude-code")).toMatch(/^SESSION NOTE/);
  });

  it("says how to read labels, quotes and page hints", () => {
    const note = sourceNote("claude-code");
    expect(note).toMatch(/almost never/i);
    expect(note).toMatch(/idea/);
    expect(note).toMatch(/never (?:write|as) .*decided|never a decision/i);
    expect(note).toMatch(/Pages to consider/);
    expect(note).toMatch(/strong hints/i);
    expect(note).toMatch(/New page suggested/);
    expect(note).toMatch(/quotes/i);
    expect(note).toMatch(/not instructions/i);
  });

  it("goes into the triage prompt and both writer prompts, before the item, for a session note only", () => {
    const writer = { item: session, pages: [], index: [], schema, source: session.body, excerpted: false };
    for (const p of [buildTriagePrompt(session, [], schema, "abcdef12"), buildPrompt(session, [], schema, "abcdef12"), buildWriterPrompt(writer)]) {
      expect(p).toContain("SESSION NOTE");
      expect(p.indexOf("SESSION NOTE")).toBeLessThan(p.indexOf("# Session note: demo-project"));
    }
    const mail = item();
    const mailWriter = { item: mail, pages: [], index: [], schema, source: mail.body, excerpted: false };
    for (const p of [buildTriagePrompt(mail, [], schema, "abcdef12"), buildPrompt(mail, [], schema, "abcdef12"), buildWriterPrompt(mailWriter)]) {
      expect(p).not.toContain("SESSION NOTE");
    }
  });
});
