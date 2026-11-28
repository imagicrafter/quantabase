import { describe, it, expect } from "vitest";
import { joinParts, ITEM_LIMIT, meetingBody, meetingItems, splitBody, joinChunks } from "../../src/fireflies/body.js";
import { parseHookEvent } from "../../src/fireflies/event.js";
import { newHookId, newSigningSecret, parseSignature, sign, verifySignature, HOOK_ID } from "../../src/fireflies/signature.js";
import { transcript } from "./fakes.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("signatures", () => {
  const body = bytes('{"event":"meeting.summarized","meeting_id":"M1"}');
  const secret = "s".repeat(32);
  const hex = sign(body, secret);

  it("accepts sha256=<hex> and bare hex, in any case", () => {
    expect(verifySignature(body, `sha256=${hex}`, secret)).toBe(true);
    expect(verifySignature(body, hex, secret)).toBe(true);
    expect(verifySignature(body, `SHA256=${hex.toUpperCase()}`, secret)).toBe(true);
  });

  it("refuses missing, short, other-algorithm, wrong-secret and changed-body signatures", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
    expect(verifySignature(body, hex.slice(2), secret)).toBe(false);
    expect(verifySignature(body, `sha1=${hex}`, secret)).toBe(false);
    expect(verifySignature(body, hex, "t".repeat(32))).toBe(false);
    expect(verifySignature(bytes('{"event":"meeting.summarized","meeting_id":"M2"}'), hex, secret)).toBe(false);
    expect(verifySignature(body, hex, "")).toBe(false);
    expect(parseSignature("sha256=xyz")).toBeNull();
  });

  it("makes unguessable ids and 32-character secrets", () => {
    const ids = new Set(Array.from({ length: 50 }, newHookId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(HOOK_ID.test(id)).toBe(true);
    expect(newSigningSecret()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("delivery payloads", () => {
  it("reads V2 and V1 deliveries", () => {
    expect(parseHookEvent('{"event":"meeting.summarized","timestamp":1,"meeting_id":"ABC"}')).toEqual({
      event: "meeting.summarized", meetingId: "ABC", reprocessedAt: null, fetch: true,
    });
    expect(parseHookEvent('{"event":"meeting.transcribed","meeting_id":"ABC","reprocessed_at":1795000000000}')?.reprocessedAt).toBe(1795000000000);
    expect(parseHookEvent('{"meetingId":"ABC","eventType":"Transcription completed"}')?.fetch).toBe(true);
  });

  it("fetches nothing for a bot join, an unknown event or a bad id", () => {
    expect(parseHookEvent('{"event":"meeting.bot_joined","meeting_id":"ABC"}')?.fetch).toBe(false);
    expect(parseHookEvent('{"event":"something.new","meeting_id":"ABC"}')?.fetch).toBe(false);
    expect(parseHookEvent('{"event":"meeting.summarized","meeting_id":"../../x y"}')).toMatchObject({ meetingId: null, fetch: false });
    expect(parseHookEvent("not json")).toBeNull();
    expect(parseHookEvent("[]")).toBeNull();
  });
});

describe("the meeting body", () => {
  it("is the participants line, then the summary, then the full transcript", () => {
    const body = meetingBody(transcript("M1"));
    expect(body).toBe(
      "Participants: pat@acme.example, ann@meet.example\n\n" +
        "Summary:\nA short sync.\n\nAction items:\nPat sends the plan.\n\n" +
        "Transcript:\nPat: Hello.\nAnn: The budget is 40 units.",
    );
  });

  it("goes with its summary only when Fireflies has no transcript yet", () => {
    expect(meetingBody(transcript("M1", { sentences: [] }))).toMatch(/Transcript: none yet/);
  });

  it("is one item with the meeting id, date and provider metadata", () => {
    const [item, ...rest] = meetingItems(transcript("M1"));
    expect(rest).toHaveLength(0);
    expect(item).toMatchObject({
      source_id: "M1", title: "Weekly sync", source_created_at: "2026-11-20T10:00:00.000Z", cursor: "2026-11-20T10:00:00.000Z",
      provider: { meeting_id: "M1", organizer_email: "ann@meet.example", channel_ids: ["chan-1"], date: "2026-11-20T10:00:00.000Z" },
    });
  });
});

describe("a large transcript is never cut", () => {
  const big = (lines: number, width: number) =>
    transcript("BIG1", {
      sentences: Array.from({ length: lines }, (_, i) => ({ speaker_name: `Speaker ${i % 3}`, text: `${i} `.padEnd(width, "x") })),
    });

  it("splits a body over the item limit into linked parts that join back exactly", () => {
    const t = big(12_000, 120);
    const whole = meetingBody(t);
    expect(whole.length).toBeGreaterThan(ITEM_LIMIT * 2);
    const items = meetingItems(t);
    expect(items.length).toBe(Math.ceil(whole.length / (ITEM_LIMIT - 400)));
    for (const it of items) expect(it.body.length).toBeLessThanOrEqual(ITEM_LIMIT);
    expect(joinParts(items)).toBe(whole);
    expect(items.map((i) => i.source_id)).toEqual(["BIG1", ...items.slice(1).map((_, k) => `BIG1#part${k + 2}`)]);
    expect(items[1]?.metadata).toMatchObject({ meeting_id: "BIG1", part: 2, parts: items.length });
    expect(items[1]?.body.startsWith(`(Part 2 of ${items.length} of this meeting; Fireflies meeting BIG1.)\n`)).toBe(true);
    // Every part carries the meeting's provider metadata, so the rules decide each the same way.
    expect(new Set(items.map((i) => JSON.stringify(i.provider))).size).toBe(1);
  });

  it("cuts a single line longer than a part inside it, without losing or adding a character", () => {
    const line = "a😀".repeat(400_000); // surrogate pairs must not be split
    const chunks = splitBody(`start\n${line}\nend`, 300_000);
    expect(chunks.length).toBeGreaterThan(2);
    expect(joinChunks(chunks)).toBe(`start\n${line}\nend`);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(300_000);
      const last = c.text.charCodeAt(c.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("leaves a body at the limit as one item", () => {
    expect(splitBody("x".repeat(10), 10)).toEqual([{ text: "x".repeat(10), continues: false }]);
  });
});
