import { evidenceText, isNoteSource, sessionNoteSchema, type SessionNote } from "../sources/session-note.js";
import { normKey } from "./resolve.js";
import type { ClaimedItem } from "./store.js";
import { MAX_TARGETS, type Triage } from "./triage.js";

/**
 * How the curator treats a session note (sources/session-note.ts):
 *   Desk editor  keeps it (the owner chose to send it; the schema has no empty note)
 *   Archivist    the note's page hints come first among the pages the Author
 *                reads; suggested new pages join triage's, under the normal bar
 *   Fact-checker reads the items' labels and exact quotes, not the summary
 * A note the Engine cannot read is curated like any other item.
 */

/** The parsed note of a session-note item, or null. */
export function noteOf(item: ClaimedItem): SessionNote | null {
  if (!isNoteSource(item.source)) return null;
  const parsed = sessionNoteSchema.safeParse(item.metadata["note"]);
  return parsed.success ? parsed.data : null;
}

const MAX_NEW_PAGES = 4;

/** Triage's verdict with the note's hints folded in. Works without a verdict too. */
export function withNoteHints(note: SessionNote, triage: Triage | null, drawers: readonly string[]): Triage {
  const hinted = note.items.flatMap((it) => (it.pages ?? []).map((p) => normKey(p.key)));
  const targets = [...new Set([...hinted, ...(triage?.targets ?? [])])].slice(0, MAX_TARGETS);
  const proposed = note.items
    .flatMap((it) => it.new_pages ?? [])
    .filter((p) => drawers.includes(p.drawer))
    .map((p) => ({ drawer: p.drawer, title: p.title }));
  const seen = new Set<string>();
  const newPages = [...proposed, ...(triage?.newPages ?? [])]
    .filter((p) => {
      const k = `${p.drawer}\u0000${p.title.toLowerCase()}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .slice(0, MAX_NEW_PAGES);
  return {
    durable: true,
    reason: triage?.durable ? triage.reason : "session note: sent by its owner",
    summary: triage?.summary ?? "",
    targets,
    newPages,
    ranges: triage?.ranges ?? [],
  };
}

/** What the Fact-checker checks new sentences against. */
export function factSource(item: ClaimedItem): string {
  const note = noteOf(item);
  return note ? evidenceText(note) : `${item.title ?? ""}\n${item.body}`;
}
