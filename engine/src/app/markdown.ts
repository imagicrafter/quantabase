import { esc } from "../status/page.js";

/**
 * A small, safe Markdown renderer for page bodies, done on the server.
 *
 * Safe by construction: every piece of text is escaped first and only a fixed
 * set of tags is ever produced (h2-h4, p, ul/ol/li, pre/code, strong, em,
 * blockquote, hr, a). Raw HTML in a page is shown as text. Links are only
 * http(s) or mailto; [[key]] and [[key|label]] become links to the page with
 * that key (/app/open?key=...), so a page body can never carry a script, an
 * event handler, a style or a javascript: address.
 */

const SAFE_URL = /^(?:https?:\/\/|mailto:)[^\s"'<>]+$/i;

export function wikiHref(key: string): string {
  return `/app/open?key=${encodeURIComponent(key.trim().toLowerCase())}`;
}

/** Inline marks on ONE line of raw text. Returns HTML. */
export function inline(raw: string): string {
  const parts: string[] = [];
  // Tokenise: code spans, wikilinks, markdown links; the rest is plain text.
  const re = /`([^`]+)`|\[\[([^\]|\n]{1,200})(?:\|([^\]\n]{1,200}))?\]\]|\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g;
  let last = 0;
  for (const m of raw.matchAll(re)) {
    parts.push(emphasis(esc(raw.slice(last, m.index))));
    if (m[1] !== undefined) parts.push(`<code>${esc(m[1])}</code>`);
    else if (m[2] !== undefined) {
      const key = m[2].trim();
      parts.push(`<a class="wikilink" href="${esc(wikiHref(key))}">${esc((m[3] ?? key).trim())}</a>`);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      parts.push(
        SAFE_URL.test(m[5])
          ? `<a href="${esc(m[5])}" rel="noopener noreferrer nofollow">${emphasis(esc(m[4]))}</a>`
          : emphasis(esc(m[0])),
      );
    }
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(emphasis(esc(raw.slice(last))));
  return parts.join("");
}

/** Bold and italic on already-escaped text (the markers survive escaping). */
function emphasis(html: string): string {
  return html
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
}

type Block = { readonly kind: "p" | "ul" | "ol" | "quote"; readonly lines: string[] };

export function renderMarkdown(body: string): string {
  const out: string[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let block: Block | null = null;
  const flush = () => {
    if (!block) return;
    if (block.kind === "p") out.push(`<p>${block.lines.map(inline).join("<br>")}</p>`);
    else if (block.kind === "quote") out.push(`<blockquote>${block.lines.map(inline).join("<br>")}</blockquote>`);
    else out.push(`<${block.kind}>${block.lines.map((l) => `<li>${inline(l)}</li>`).join("")}</${block.kind}>`);
    block = null;
  };
  const add = (kind: Block["kind"], text: string) => {
    if (!block || block.kind !== kind) {
      flush();
      block = { kind, lines: [] };
    }
    block.lines.push(text);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i] ?? ""); i++) code.push(lines[i] ?? "");
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      // A page's "# Title" is shown by the screen already: render h1 as h2.
      const level = Math.min(4, Math.max(2, (h[1] ?? "#").length + 1));
      out.push(`<h${level}>${inline((h[2] ?? "").trim())}</h${level}>`);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      add("ul", ul[1] ?? "");
      continue;
    }
    const ol = /^\s*\d{1,4}[.)]\s+(.*)$/.exec(line);
    if (ol) {
      add("ol", ol[1] ?? "");
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      add("quote", q[1] ?? "");
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    add("p", line.trim());
  }
  flush();
  return out.join("\n");
}

/** Every [[key]] in a body, lower case, deduplicated. */
export function wikiKeys(body: string): string[] {
  return [...new Set([...body.matchAll(/\[\[([^\]|\n]{1,200})(?:\|[^\]\n]*)?\]\]/g)].map((m) => (m[1] ?? "").trim().toLowerCase()))];
}
