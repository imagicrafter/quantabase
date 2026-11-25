import { describe, expect, it, vi } from "vitest";
import { curateItem, type CurateDeps } from "../../src/curator/curate.js";
import type { ModelBackend } from "../../src/curator/model.js";
import { factSource, noteOf, withNoteHints } from "../../src/curator/session-note.js";
import type { Triage } from "../../src/curator/triage.js";
import { entitySchema } from "../../src/entities/templates.js";
import { renderNote, sessionNoteSchema } from "../../src/sources/session-note.js";
import { NOTE } from "../sources/note-fixture.js";
import { PILOT, fakeStore, item } from "./fixtures.js";

const schema = entitySchema(["consulting"]);
const drawers = schema.drawers.map((d) => d.id);
const note = sessionNoteSchema.parse(NOTE);
const session = item({
  source: "claude-code", source_id: NOTE.session_id, title: "Session note: demo-project, 2026-11-24",
  body: renderNote(note), metadata: { note: NOTE }, source_created_at: "2026-11-24T11:30:00Z", topics: [],
});

function replying(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 100, outputTokens: 20 });
  return { complete };
}

const UPDATE = {
  updates: [{
    key: PILOT.key,
    patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-24: Release 2.0 moves to 2026-12-01." }],
    update_line: "Release 2.0 moves to 2026-12-01.",
  }],
  new_pages: [],
  notes: "",
};

function deps(writer: ModelBackend, triage: ModelBackend, store: ReturnType<typeof fakeStore>["store"]): CurateDeps {
  return { store, model: writer, modelName: "writer", schema, now: () => new Date("2026-11-24T12:00:00Z"), writer: { triage: { model: triage, name: "triage" } } };
}

describe("reading the note off an item", () => {
  it("parses metadata.note for a session note only", () => {
    expect(noteOf(session)?.items).toHaveLength(2);
    expect(noteOf(item())).toBeNull();
    expect(noteOf({ ...session, metadata: { note: { ...NOTE, items: [] } } })).toBeNull();
    expect(noteOf({ ...session, source: "gmail" })).toBeNull();
  });

  it("the Fact-checker's source is the quotes, not the summary; other items keep their text", () => {
    expect(factSource(session)).toContain("ok, let's ship 2.0 on Dec 1 instead");
    expect(factSource(session)).not.toContain("not in November");
    expect(factSource(item())).toContain("offline map pack is installed");
  });
});

describe("page hints (Archivist)", () => {
  const verdict: Triage = { durable: false, reason: "chatter", summary: "s", targets: ["dana@example.com"], newPages: [], ranges: [[1, 3]] };

  it("keeps a session note even when triage would set it aside, hint pages first", () => {
    const t = withNoteHints(note, verdict, drawers);
    expect(t.durable).toBe(true);
    expect(t.targets).toEqual(["project:northwind-route-pilot", "dana@example.com"]);
    expect(t.newPages).toEqual([{ drawer: "decisions", title: "Nightly export" }]);
    expect(t.ranges).toEqual([[1, 3]]);
  });

  it("builds a verdict when triage failed, and drops new-page hints for drawers that do not exist", () => {
    const odd = sessionNoteSchema.parse({ ...NOTE, items: [{ ...NOTE.items[1], new_pages: [{ drawer: "spaceships", title: "x", why: "y" }] }] });
    const t = withNoteHints(odd, null, drawers);
    expect(t).toMatchObject({ durable: true, targets: [], newPages: [], ranges: [] });
  });
});

describe("curating a session note", () => {
  it("is not set aside, the hinted page reaches the Author, and the Fact-checker reads the quotes", async () => {
    const f = fakeStore();
    f.store.candidates.mockImplementation(async (_i: string, keys: readonly string[]) =>
      (keys.length === 1 && keys[0] === PILOT.key ? [PILOT] : []));
    const triage = replying({ durable: false, reason: "just chatter" }, { unsupported: [] });
    const writer = replying(UPDATE);
    const r = await curateItem(session, deps(writer, triage, f.store));
    expect(writer.complete).toHaveBeenCalledTimes(1);
    const user = writer.complete.mock.calls[0]![1] as string;
    expect(user).toContain(`=== PAGE key=${PILOT.key}`);
    expect(user).toContain("SESSION NOTE");
    expect(r.outcome).toBe("applied");
    const fact = triage.complete.mock.calls[1]![1] as string;
    const sourcePart = fact.slice(fact.indexOf("SOURCE"));
    expect(sourcePart).toContain("ok, let's ship 2.0 on Dec 1 instead");
    expect(sourcePart).toContain("idea: floated, not decided");
    expect(sourcePart).not.toContain("not in November");
  });

  it("a note the Engine cannot read is curated like any other item", async () => {
    const f = fakeStore();
    const triage = replying({ durable: false, reason: "nothing" });
    const writer = replying(UPDATE);
    const r = await curateItem({ ...session, metadata: { note: "broken" } }, deps(writer, triage, f.store));
    expect(writer.complete).not.toHaveBeenCalled();
    expect(r.outcome).toBe("no_change");
  });
});
