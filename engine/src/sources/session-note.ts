import { z } from "zod";

/**
 * A session note: what the owner's own Claude (Claude Code now, a Claude.ai
 * chat later) found worth keeping in one session, sent by hand with the
 * plugin's send-session skill. Not page edits: short labelled items, each
 * with exact quotes from the session as evidence and hints about which pages
 * it concerns. The Engine stores the note rendered as markdown (the item's
 * body) and the parsed note in metadata.note; the curator reads both
 * (curator/session-note.ts). See docs/plugin.md.
 */

/** Sources whose items are session notes. A saved Claude.ai chat joins later. */
export const NOTE_SOURCES: readonly string[] = ["claude-code"];

export function isNoteSource(source: string): boolean {
  return NOTE_SOURCES.includes(source);
}

/** What kind of thing an item is. "idea" is floated, never decided. */
export const NOTE_LABELS = ["decided", "fact", "status", "how-to", "idea"] as const;
export type NoteLabel = (typeof NOTE_LABELS)[number];

/** The rendered note's ceiling: small, far under the per-item limit. */
export const NOTE_MAX_CHARS = 20_000;
export const NOTE_MAX_ITEMS = 30;

const Key = z.string().trim().min(1).max(200).refine((s) => !/\s/.test(s), "no spaces");
const Line = (max: number) => z.string().trim().min(1).max(max);
const Stamp = z.string().datetime({ offset: true });

const quoteSchema = z.object({ who: z.enum(["owner", "assistant", "tool"]), text: Line(400) }).strict();

const pageHintSchema = z.object({ key: Key, title: Line(200), whats_new: Line(300) }).strict();

const newPageHintSchema = z
  .object({ drawer: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), title: Line(120), key: Key.optional(), why: Line(300) })
  .strict();

const noteItemSchema = z
  .object({
    label: z.enum(NOTE_LABELS),
    text: Line(600),
    // At least one quote must be the owner's or the assistant's: the plugin
    // checks those word for word against the session; tool output it cannot.
    quotes: z
      .array(quoteSchema)
      .min(1)
      .max(3)
      .refine((qs) => qs.some((q) => q.who !== "tool"), "needs a quote from the owner or assistant (tool output alone is not evidence)"),
    pages: z.array(pageHintSchema).max(4).optional(),
    new_pages: z.array(newPageHintSchema).max(2).optional(),
  })
  .strict();

const baseNoteSchema = z
  .object({
    session_id: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    project: Line(100),
    // A few words naming what the session was about (the item's title).
    title: Line(120).optional(),
    started_at: Stamp.optional(),
    ended_at: Stamp.optional(),
    items: z.array(noteItemSchema).min(1).max(NOTE_MAX_ITEMS),
  })
  .strict();

export type SessionNote = z.infer<typeof baseNoteSchema>;
export type NoteItem = SessionNote["items"][number];

const WHO: Readonly<Record<string, string>> = { owner: "Owner", assistant: "Assistant", tool: "Tool output" };

function stamp(ts: string | undefined): string {
  return ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "unknown";
}

function itemMarkdown(item: NoteItem, n: number): string {
  const lines = [`## ${n}. [${item.label}] ${item.text}`, "Evidence (exact words from the session):"];
  lines.push(...item.quotes.map((q) => `> ${WHO[q.who]}: "${q.text}"`));
  if (item.pages?.length) {
    lines.push("Pages to consider:", ...item.pages.map((p) => `- ${p.key} (${p.title}): ${p.whats_new}`));
  }
  if (item.new_pages?.length) {
    lines.push("New page suggested:", ...item.new_pages.map((p) => `- ${p.drawer}: ${p.title}${p.key ? ` (key ${p.key})` : ""}: ${p.why}`));
  }
  return lines.join("\n");
}

/** The note as the item's body: readable by a person and by the curator. */
export function renderNote(note: SessionNote): string {
  const head = [
    `# Session note: ${note.project}`,
    `Session ${note.session_id}, ${stamp(note.started_at)} to ${stamp(note.ended_at)} UTC.`,
    "Written by the owner's own Claude at the end of a working session and sent by the owner. " +
      "Each item is labelled decided, fact, status, how-to or idea; an idea was only floated. " +
      "Quotes are exact words from the session.",
  ].join("\n");
  return [head, ...note.items.map((it, i) => itemMarkdown(it, i + 1))].join("\n\n") + "\n";
}

export const sessionNoteSchema = baseNoteSchema.superRefine((note, ctx) => {
  const size = renderNote(note).length;
  if (size > NOTE_MAX_CHARS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the note is too long (${size} characters, at most ${NOTE_MAX_CHARS}): keep fewer, shorter items` });
  }
});

/** The item's title when the run gives none. */
export function noteTitle(note: SessionNote): string {
  if (note.title) return note.title;
  const day = (note.ended_at ?? note.started_at)?.slice(0, 10);
  return `Session note: ${note.project}${day ? `, ${day}` : ""}`;
}

const LABEL_MEANS: Readonly<Record<NoteLabel, string>> = {
  decided: "decided", fact: "fact", status: "status", "how-to": "how-to", idea: "idea: floated, not decided",
};

/**
 * What the Fact-checker reads for a session note: each item's label and its
 * exact quotes from the owner and the assistant, never the summary prose and
 * never tool output (the plugin cannot check that against the session), so a
 * page sentence stands only on the session's own words.
 */
export function evidenceText(note: SessionNote): string {
  const head = `Session ${note.session_id} in project ${note.project}, ${stamp(note.started_at)} to ${stamp(note.ended_at)} UTC. "Owner" is the person this wiki belongs to.`;
  const items = note.items.map((it, i) =>
    [`Item ${i + 1} (${LABEL_MEANS[it.label]}):`, ...it.quotes.filter((q) => q.who !== "tool").map((q) => `${WHO[q.who]}: "${q.text}"`)].join("\n"));
  return [head, ...items].join("\n\n");
}
