import { esc } from "../status/page.js";

/**
 * A plain line diff (longest common subsequence) for the review and history
 * screens. Pages are at most 200,000 characters; past MAX_LINES on either side
 * the diff falls back to "everything removed, everything added" rather than
 * spending memory.
 */

export type DiffLine = { readonly kind: "same" | "add" | "del"; readonly text: string };

const MAX_LINES = 1000;

export function lineDiff(before: string, after: string): readonly DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i] as Uint32Array;
    const next = table[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i += 1;
      j += 1;
    } else if (((table[i + 1] as Uint32Array)[j] as number) >= ((table[i] as Uint32Array)[j + 1] as number)) {
      out.push({ kind: "del", text: a[i] as string });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] as string });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] as string });
  while (j < m) out.push({ kind: "add", text: b[j++] as string });
  return out;
}

/** The diff as escaped HTML: "+ " and "- " prefixes, no colour needed. */
export function diffHtml(lines: readonly DiffLine[]): string {
  if (!lines.some((l) => l.kind !== "same")) return "<p>No change to the text.</p>";
  const mark = { same: "  ", add: "+ ", del: "- " } as const;
  const body = lines.map((l) => esc(`${mark[l.kind]}${l.text}`)).join("\n");
  return `<pre class="diff">${body}</pre>`;
}
