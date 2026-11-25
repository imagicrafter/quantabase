import { z } from "zod";
import { McpAppError } from "../mcp/errors.js";

/**
 * Section patches for update_page: small, exact edits to a page body so a
 * writer never has to resend (and risk dropping) the whole page.
 *
 * A section is a markdown heading and everything under it up to the next
 * heading of the same or a higher level, so it includes its subsections.
 * Headings match by text, ignoring case and surrounding space.
 */

const OneLine = z
  .string()
  .min(1)
  .max(2000)
  .refine((s) => !/[\r\n]/.test(s), "must be one line");

export const patchSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append-bullet"), section: z.string().min(1).max(200), text: OneLine }).strict(),
  z
    .object({ op: z.literal("append-paragraph"), section: z.string().min(1).max(200), text: z.string().min(1).max(20000) })
    .strict(),
  z
    .object({
      op: z.literal("replace-line"),
      section: z.string().min(1).max(200).optional(),
      old: OneLine,
      new: z.string().max(2000).refine((s) => !/[\r\n]/.test(s), "must be one line"),
    })
    .strict(),
  z
    .object({
      op: z.literal("new-section-after"),
      after: z.string().min(1).max(200),
      heading: OneLine,
      text: z.string().max(20000).optional(),
    })
    .strict(),
]);

export type Patch = z.infer<typeof patchSchema>;

type Span = { readonly start: number; readonly end: number; readonly level: number };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function bad(message: string): McpAppError {
  return new McpAppError("invalid_argument", message);
}

function norm(text: string): string {
  return text.trim().toLowerCase();
}

/** [start, end) line span of the one section with this heading. */
function findSection(lines: readonly string[], name: string): Span {
  const hits: Span[] = [];
  lines.forEach((line, i) => {
    const m = HEADING.exec(line);
    if (m && norm(m[2] ?? "") === norm(name)) {
      const level = (m[1] ?? "").length;
      const next = lines.findIndex((l, j) => {
        if (j <= i) return false;
        const h = HEADING.exec(l);
        return h !== null && (h[1] ?? "").length <= level;
      });
      hits.push({ start: i, end: next === -1 ? lines.length : next, level });
    }
  });
  if (hits.length === 0) throw bad(`No section named "${name}"`);
  if (hits.length > 1) throw bad(`More than one section named "${name}"`);
  return hits[0]!;
}

/** Index just after the last non-blank line of the span. */
function contentEnd(lines: readonly string[], span: Span): number {
  let at = span.end;
  while (at > span.start + 1 && (lines[at - 1] ?? "").trim() === "") at -= 1;
  return at;
}

function splice(
  lines: readonly string[],
  at: number,
  removeUntil: number,
  insert: readonly string[],
): string[] {
  return [...lines.slice(0, at), ...insert, ...lines.slice(removeUntil)];
}

/** One blank line after an edited section: a gap before the next heading, or the final newline. */
const GAP: readonly string[] = [""];

function appendTo(lines: readonly string[], section: string, block: readonly string[], gap: boolean): string[] {
  const span = findSection(lines, section);
  const at = contentEnd(lines, span);
  const lead = gap && at > span.start + 1 ? [""] : [];
  return splice(lines, at, span.end, [...lead, ...block, ...GAP]);
}

function replaceLine(lines: readonly string[], p: Extract<Patch, { op: "replace-line" }>): string[] {
  const span = p.section ? findSection(lines, p.section) : { start: 0, end: lines.length, level: 0 };
  const target = p.old.trimEnd();
  const hits = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i >= span.start && i < span.end && l.trimEnd() === target);
  if (hits.length === 0) throw bad("The line to replace was not found");
  if (hits.length > 1) throw bad("The line to replace appears more than once; name its section");
  const at = hits[0]!.i;
  return splice(lines, at, at + 1, [p.new]);
}

function newSectionAfter(lines: readonly string[], p: Extract<Patch, { op: "new-section-after" }>): string[] {
  const exists = lines.some((l) => {
    const m = HEADING.exec(l);
    return m !== null && norm(m[2] ?? "") === norm(p.heading);
  });
  if (exists) throw bad(`A section named "${p.heading}" already exists`);
  const span = findSection(lines, p.after);
  const at = contentEnd(lines, span);
  const heading = `${"#".repeat(Math.max(span.level, 1))} ${p.heading.trim()}`;
  const text = p.text && p.text.trim().length > 0 ? p.text.trimEnd().split("\n") : [];
  return splice(lines, at, span.end, ["", heading, ...text, ...GAP]);
}

function applyOne(lines: readonly string[], p: Patch): string[] {
  switch (p.op) {
    case "append-bullet":
      if (/[\r\n]/.test(p.text)) throw bad("A bullet must be one line");
      return appendTo(lines, p.section, [`- ${p.text.trim()}`], false);
    case "append-paragraph":
      return appendTo(lines, p.section, p.text.trimEnd().split("\n"), true);
    case "replace-line":
      return replaceLine(lines, p);
    case "new-section-after":
      return newSectionAfter(lines, p);
  }
}

/** Apply patches in order. Returns a new body; the input is not changed. */
export function applyPatches(body: string, patches: readonly Patch[]): string {
  const lines = patches.reduce<readonly string[]>(
    (acc, p) => applyOne(acc, p),
    body.split("\n"),
  );
  return lines.join("\n");
}
