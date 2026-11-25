import { describe, expect, it } from "vitest";
import { inline, renderMarkdown, wikiKeys } from "../../src/app/markdown.js";

describe("safe markdown", () => {
  it("renders headings, lists, emphasis and code", () => {
    const html = renderMarkdown("# Title\n\n## Timeline\n- **2026-11-20**: pilot *agreed*\n- `code`\n\n1. one\n2. two\n\nPara one\nline two");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<h3>Timeline</h3>");
    expect(html).toContain("<ul><li><strong>2026-11-20</strong>: pilot <em>agreed</em></li><li><code>code</code></li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain("<p>Para one<br>line two</p>");
  });

  it("escapes raw HTML, scripts and handlers", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror="a()">\n```\n<b>x</b>\n```');
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>");
  });

  it("links only http(s) and mailto; javascript: stays text", () => {
    expect(inline("[ok](https://example.com/a)")).toBe('<a href="https://example.com/a" rel="noopener noreferrer nofollow">ok</a>');
    const bad = inline("[x](javascript:alert(1))");
    expect(bad).not.toContain("<a");
    expect(inline('[x](https://e.com/"onmouseover=a)')).not.toContain('"onmouseover');
  });

  it("turns [[key]] and [[key|label]] into page links", () => {
    expect(inline("see [[Pat.Rivera@northwind-test.com]]")).toBe(
      'see <a class="wikilink" href="/app/open?key=pat.rivera%40northwind-test.com">Pat.Rivera@northwind-test.com</a>',
    );
    expect(inline("[[project:pilot|the pilot]]")).toContain(">the pilot</a>");
    expect(inline('[["><script>]]')).not.toContain("<script>");
    expect(wikiKeys("[[A]] and [[b|B]] and [[a]]")).toEqual(["a", "b"]);
  });
});
