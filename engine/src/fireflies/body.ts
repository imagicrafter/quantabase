import type { Transcript } from "./client.js";

/**
 * One Fireflies meeting as the items record_source_item stores, built the way
 * the plugin's ingest skill describes a Fireflies body: the participants line,
 * then the Fireflies summary when there is one (overview, notes, action
 * items), then the full transcript (speaker: text, one line each). Never cut.
 *
 * A body over the database's per-item limit (500,000 characters, migrations
 * 0052-0076) is stored in linked parts instead of being truncated: part 1
 * keeps the meeting id as its source id, part k is "<id>#part<k>", each says
 * which part it is and carries {meeting_id, part, parts} in its metadata.
 * Joining the parts' text (without their one-line part header) gives back
 * the whole body, character for character.
 */

export const ITEM_LIMIT = 500_000;
/** Room kept in each part for its one-line part header. */
const HEADER_ROOM = 400;
export const MAX_PARTS = 100;

export type MeetingItem = {
  readonly source_id: string;
  readonly title: string;
  readonly body: string;
  readonly source_created_at?: string;
  readonly cursor?: string;
  readonly provider: {
    readonly meeting_id: string;
    readonly channel_ids: readonly string[];
    readonly participants: readonly string[];
    readonly organizer_email?: string;
    readonly date?: string;
  };
  readonly metadata: Readonly<Record<string, unknown>>;
};

export class TooLargeError extends Error {
  constructor() {
    super("the meeting is too large to store");
    this.name = "TooLargeError";
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const text = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean).join("\n");
  return "";
};

function isoDate(value: unknown): string | undefined {
  const ms = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Date.parse(String(value ?? ""));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** Participant addresses: Fireflies' own list, then attendee emails, lower-cased, once each. */
function participantEmails(t: Transcript): readonly string[] {
  const raw = [
    ...(t.participants ?? []).flatMap((p) => String(p ?? "").split(",")),
    ...(t.meeting_attendees ?? []).map((a) => String(a.email ?? "")),
  ];
  return [...new Set(raw.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e) && e.length <= 254))];
}

/** The people line: addresses, or names when Fireflies has no address for someone. */
function participantsLine(t: Transcript, emails: readonly string[]): string {
  const named = (t.meeting_attendees ?? [])
    .filter((a) => !EMAIL.test(String(a.email ?? "").trim()))
    .map((a) => String(a.displayName ?? a.name ?? "").trim())
    .filter(Boolean);
  const all = [...emails, ...named];
  return `Participants: ${all.length > 0 ? all.join(", ") : "(none listed)"}`;
}

function summaryBlock(t: Transcript): string {
  const s = t.summary ?? {};
  const sections: Array<[string, string]> = [
    ["Summary", text(s["overview"]) || text(s["short_summary"])],
    ["Notes", text(s["shorthand_bullet"])],
    ["Action items", text(s["action_items"])],
    ["Keywords", Array.isArray(s["keywords"]) ? (s["keywords"] as unknown[]).map(String).join(", ") : text(s["keywords"])],
  ];
  return sections
    .filter(([, body]) => body !== "")
    .map(([head, body]) => `${head}:\n${body}`)
    .join("\n\n");
}

/** The whole body, exactly as read. */
export function meetingBody(t: Transcript): string {
  const emails = participantEmails(t);
  const sentences = t.sentences ?? [];
  const summary = summaryBlock(t);
  const transcript = sentences.length > 0
    ? `Transcript:\n${sentences.map((s) => `${String(s.speaker_name ?? "").trim() || "Unknown"}: ${String(s.text ?? "")}`).join("\n")}`
    : "Transcript: none yet (Fireflies has no transcript for this meeting).";
  return [participantsLine(t, emails), summary, transcript].filter((b) => b !== "").join("\n\n");
}

/** Cut at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
function safeCut(s: string, max: number): number {
  if (s.length <= max) return s.length;
  const code = s.charCodeAt(max);
  return code >= 0xdc00 && code <= 0xdfff ? max - 1 : max;
}

export type Chunk = {
  readonly text: string;
  /** True when this chunk carries on the previous chunk's line (no newline between them). */
  readonly continues: boolean;
};

/**
 * The body in chunks of at most `budget` characters, cut at line ends where
 * possible; a line longer than a whole chunk is cut inside it. Joining the
 * chunks with "\n" (or nothing, before a chunk that continues a line) gives
 * back the body exactly.
 */
export function splitBody(body: string, budget: number): readonly Chunk[] {
  const chunks: Chunk[] = [];
  let rest = body;
  let continues = false;
  while (rest.length > budget) {
    const nl = rest.lastIndexOf("\n", budget);
    if (nl > 0) {
      chunks.push({ text: rest.slice(0, nl), continues });
      rest = rest.slice(nl + 1);
      continues = false;
    } else {
      const cut = safeCut(rest, budget);
      chunks.push({ text: rest.slice(0, cut), continues });
      rest = rest.slice(cut);
      continues = true;
    }
  }
  chunks.push({ text: rest, continues });
  return chunks;
}

export function joinChunks(chunks: readonly Chunk[]): string {
  return chunks.map((c, i) => (i === 0 || c.continues ? c.text : `\n${c.text}`)).join("");
}

const partHeader = (k: number, n: number, id: string) =>
  `(Part ${k} of ${n} of this meeting; Fireflies meeting ${id}.)\n`;

/** The items for one meeting: one, or linked parts when it is over the item limit. */
export function meetingItems(t: Transcript): readonly MeetingItem[] {
  const body = meetingBody(t);
  const emails = participantEmails(t);
  const date = isoDate(t.date);
  const title = String(t.title ?? "").trim() || "Fireflies meeting";
  const organizer = String(t.organizer_email ?? "").trim().toLowerCase();
  const provider = {
    meeting_id: t.id,
    channel_ids: [...new Set((t.channels ?? []).map((c) => String(c.id ?? "").trim()).filter(Boolean))],
    participants: emails,
    ...(EMAIL.test(organizer) ? { organizer_email: organizer } : {}),
    ...(date ? { date } : {}),
  };
  const when = date ? { source_created_at: date, cursor: date } : {};
  const base = { metadata: { via: "webhook" } };

  if (body.length <= ITEM_LIMIT) {
    return [{ source_id: t.id, title, body, ...when, provider, ...base }];
  }
  const chunks = splitBody(body, ITEM_LIMIT - HEADER_ROOM);
  if (chunks.length > MAX_PARTS) throw new TooLargeError();
  const n = chunks.length;
  return chunks.map((chunk, i) => {
    const k = i + 1;
    const continues = chunk.continues;
    const textPart = chunk.text;
    return {
      source_id: k === 1 ? t.id : `${t.id}#part${k}`,
      title: `${title} (part ${k} of ${n})`,
      body: partHeader(k, n, t.id) + textPart,
      ...when,
      provider,
      metadata: { via: "webhook", meeting_id: t.id, part: k, parts: n, ...(continues ? { continues_line: true } : {}) },
    };
  });
}

/** The whole body again from stored parts (each part's one-line header dropped). */
export function joinParts(items: readonly MeetingItem[]): string {
  if (items.length === 1 && items[0]) return items[0].body;
  return joinChunks(
    items.map((it) => ({ text: it.body.slice(it.body.indexOf("\n") + 1), continues: it.metadata["continues_line"] === true })),
  );
}
