import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fullStatusConfig } from "./fixtures/config.js";
import { buildModel } from "../../src/status/model.js";
import { esc, renderPage, safeJson } from "../../src/status/page.js";
import { StatusDataSchema } from "../../src/status/readings.js";

const NOW = new Date("2026-11-07T18:00:00Z");
const raw = JSON.parse(
  readFileSync(new URL("./fixtures/readings.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const build = (over: Record<string, unknown> = {}) =>
  buildModel(
    fullStatusConfig(),
    StatusDataSchema.parse({ ...raw, ...over }),
    NOW,
  );

describe("signed-in email on the dashboard", () => {
  it("reads as the real address and gives the edge's obfuscator nothing to match", () => {
    const html = renderPage(build(), "v", "owner@example.com");
    const foot = /<span>Signed in as [\s\S]*?<\/span>\s*<\/div>/.exec(html)![0];
    expect(foot).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(foot.replace(/<[^>]*>/g, "").replace(/&#64;/g, "@")).toContain("Signed in as owner@example.com");
  });
});

describe("page shell", () => {
  it("links only same-origin assets and carries no inline script or style", () => {
    const html = renderPage(build(), "abc123", "owner@example.com");
    const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(links).toEqual([
      "/status/assets/dashboard.css?v=abc123",
      "/status/assets/dashboard.js?v=abc123",
    ]);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toMatch(/<script type="application\/json" id="engine-data">/);
  });

  it("sets the title and signed-in line, escaped", () => {
    const html = renderPage(build(), "v", `a"<b>@x.com`);
    expect(html).toMatch(/<title>Acme&#39;s Knowledge Base Engine<\/title>/);
    expect(html).toContain("Signed in as a&quot;&lt;b&gt;@x.com");
  });

  it("data that tries to close the script tag stays inert", () => {
    const evil = "</script><img src=x onerror=alert(1)>";
    const html = renderPage(
      build({
        review_waiting: [{ title: evil, source: "wiki", domains: [] }],
      }),
      "v",
      "j@x.com",
    );
    expect(html).not.toContain("</script><img");
    const block =
      html.split('id="engine-data">')[1]?.split("</script>")[0] ?? "";
    const parsed = JSON.parse(block) as {
      knowledge: { review: { rows: { title: string }[] } };
    };
    expect(parsed.knowledge.review.rows[0]?.title).toBe(evil);
  });

  it("escapes line separators and ampersands in embedded data", () => {
    const sep = String.fromCharCode(0x2028, 0x2029);
    const out = safeJson({ a: `x${sep}y & <` });
    expect(out).not.toContain(String.fromCharCode(0x2028));
    expect(out).not.toContain(String.fromCharCode(0x2029));
    expect(out).not.toMatch(/[<&]/);
    expect(JSON.parse(out)).toEqual({ a: `x${sep}y & <` });
  });

  it("embeds the new readings and none of the setup secrets", () => {
    const html = renderPage(
      build({
        setup: {
          setup_state: "complete",
          level: "owner",
          host: "engine.example.com",
          setup_code_hash: "ab".repeat(32),
          setup_failed_at: ["2026-11-07T17:00:00Z"],
        },
      }),
      "v",
      "owner@example.com",
    );
    const block =
      html.split('id="engine-data">')[1]?.split("</script>")[0] ?? "";
    const parsed = JSON.parse(block) as {
      support: { open: unknown[] };
      security: { access: { value: string }[] };
      knowledge: { unknownTags: { count: number } | null };
    };
    expect(parsed.support.open).toHaveLength(2);
    expect(parsed.security.access[0]?.value).toBe("Owner only");
    expect(parsed.knowledge.unknownTags?.count).toBe(3);
    expect(html).not.toContain("ab".repeat(32));
    expect(html).not.toMatch(/setup_code_hash|setup_failed_at/);
  });

  it("esc covers all five characters", () => {
    expect(esc(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("the shipped stylesheet and script contain no inline-style output", () => {
    const js = readFileSync(
      new URL("../../public/status/dashboard.js", import.meta.url),
      "utf8",
    );
    // style="..." in generated HTML would be blocked by the CSP.
    expect(js).not.toMatch(/style="/);
    expect(js).not.toMatch(/innerHTML\s*=\s*[^;]*\$\{[^}]*\bURL\b/);
  });
});
