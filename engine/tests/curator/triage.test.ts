import { describe, expect, it } from "vitest";
import { entitySchema } from "../../src/entities/templates.js";
import {
  EXCERPT_MAX_CHARS, LINE_CHARS, TRIAGE_MAX_CHARS, buildTriagePrompt, itemLines, mergeRanges, parseTriage, writerSource,
} from "../../src/curator/triage.js";
import { item } from "./fixtures.js";

const schema = entitySchema(["consulting"]);
const ctx = { keys: ["project:northwind-route-pilot", "dana@example.com"], drawers: schema.drawers.map((d) => d.id), lines: 40 };

/** A synthetic 90-minute meeting: 1,200 speaker lines, one decision in the middle. */
function longMeeting(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 1200; i += 1) {
    lines.push(i === 700 ? "Dana Whitlock: we agreed the pilot extends to the Bayside depot from 2026-12-15." : `Speaker ${i % 3}: small talk line ${i} about the weather and the traffic.`);
  }
  return lines.join("\n");
}

describe("triage reply", () => {
  it("reads a durable verdict, keeps only known keys and drawers, and clamps line ranges", () => {
    const t = parseTriage(JSON.stringify({
      durable: true, reason: "a decision", summary: "Pilot extends.",
      targets: ["project:northwind-route-pilot", "made-up:key"],
      new_pages: [{ drawer: "decisions", title: "Bayside extension" }, { drawer: "spaceships", title: "x" }],
      excerpts: [[12, 10], [35, 99], [80, 90]],
    }), ctx);
    expect(t).toEqual({
      durable: true, reason: "a decision", summary: "Pilot extends.", targets: ["project:northwind-route-pilot"],
      newPages: [{ drawer: "decisions", title: "Bayside extension" }], ranges: [[10, 12], [35, 40]],
    });
  });

  it("reads a not-durable verdict, and refuses what is not a triage reply", () => {
    expect(parseTriage('{"durable": false, "reason": "scheduling only"}', ctx)).toMatchObject({ durable: false, reason: "scheduling only", targets: [] });
    expect(parseTriage("not json", ctx)).toBeNull();
    expect(parseTriage('{"targets": []}', ctx)).toBeNull();
  });
});

describe("triage prompt", () => {
  it("numbers the item's lines, splits long ones and carries the index and durability rule", () => {
    const body = `first\n${"x".repeat(LINE_CHARS * 2 + 10)}\nlast`;
    const p = buildTriagePrompt(item({ body }), [{
      key: "project:northwind-route-pilot", drawer: "projects", title: "Northwind pilot", aliases: [], description: null, identities: [], score: 1, matched_on: "key",
    }], schema, "abcdef12");
    expect(p).toContain("1| first");
    expect(p).toContain("5| last");
    expect(p).toContain("- project:northwind-route-pilot | projects | Northwind pilot");
    expect(p).toContain("DURABLE FACTS ONLY");
    expect(p).toContain('"excerpts"');
  });

  it("reads far more of a long item than the writer ever did (no 24k cut)", () => {
    const lines = itemLines(longMeeting());
    expect(lines).toHaveLength(1200);
    expect(TRIAGE_MAX_CHARS).toBeGreaterThan(200_000);
    expect(itemLines("y".repeat(TRIAGE_MAX_CHARS + 50_000)).join("").length).toBeLessThanOrEqual(TRIAGE_MAX_CHARS);
  });
});

describe("what the writer reads", () => {
  it("gets a short item whole", () => {
    expect(writerSource("short mail", [])).toEqual({ text: "short mail", excerpted: false });
  });

  it("gets a long meeting as numbered excerpts around the lines triage named, not the whole transcript", () => {
    const body = longMeeting();
    const s = writerSource(body, [[700, 700]]);
    expect(s.excerpted).toBe(true);
    expect(s.text).toContain("700| Dana Whitlock: we agreed the pilot extends to the Bayside depot");
    expect(s.text).toContain("698| ");
    expect(s.text).not.toContain("small talk line 5 ");
    expect(s.text.length).toBeLessThan(2000);
  });

  it("falls back to the start, within the excerpt budget, when triage named no lines", () => {
    const s = writerSource(longMeeting(), []);
    expect(s.excerpted).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 10);
  });

  it("merges overlapping ranges with a little context", () => {
    expect(mergeRanges([[10, 12], [13, 20], [50, 50]], 100)).toEqual([[8, 22], [48, 52]]);
  });
});
