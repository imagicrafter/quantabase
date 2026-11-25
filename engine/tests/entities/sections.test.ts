import { describe, it, expect } from "vitest";
import { applyPatches } from "../../src/entities/sections.js";
import { McpAppError } from "../../src/mcp/errors.js";

const BODY = [
  "# Acme",
  "",
  "## Summary",
  "A client since 2024.",
  "",
  "## Notes",
  "- First call went well.",
  "",
  "### Older",
  "- Met at a fair.",
  "",
  "## Timeline",
  "- 2024-01 signed",
  "",
].join("\n");

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof McpAppError ? err.code : "other";
  }
  return "none";
}

describe("applyPatches", () => {
  it("append-bullet adds the bullet at the end of the section, including its subsections", () => {
    const out = applyPatches(BODY, [
      { op: "append-bullet", section: "notes", text: "Asked for a quote." },
    ]);
    const lines = out.split("\n");
    const at = lines.indexOf("- Asked for a quote.");
    expect(at).toBeGreaterThan(lines.indexOf("- Met at a fair."));
    expect(at).toBeLessThan(lines.indexOf("## Timeline"));
    expect(lines[at + 1]).toBe("");
  });

  it("append-paragraph adds a paragraph separated by a blank line", () => {
    const out = applyPatches(BODY, [
      { op: "append-paragraph", section: "Summary", text: "Pays on time." },
    ]);
    expect(out).toContain("A client since 2024.\n\nPays on time.\n\n## Notes");
  });

  it("replace-line swaps exactly one matching line", () => {
    const out = applyPatches(BODY, [
      { op: "replace-line", old: "- 2024-01 signed", new: "- 2024-01 signed (two years)" },
    ]);
    expect(out).toContain("- 2024-01 signed (two years)");
    expect(out).not.toContain("- 2024-01 signed\n");
  });

  it("replace-line refuses a line that is missing or appears twice", () => {
    expect(code(() => applyPatches(BODY, [{ op: "replace-line", old: "nope", new: "x" }]))).toBe(
      "invalid_argument",
    );
    const twice = `${BODY}\n- 2024-01 signed\n`;
    expect(code(() => applyPatches(twice, [{ op: "replace-line", old: "- 2024-01 signed", new: "x" }]))).toBe(
      "invalid_argument",
    );
  });

  it("replace-line can be limited to a section", () => {
    const twice = BODY.replace("- Met at a fair.", "- 2024-01 signed");
    const out = applyPatches(twice, [
      { op: "replace-line", section: "Timeline", old: "- 2024-01 signed", new: "- signed" },
    ]);
    expect(out).toContain("### Older\n- 2024-01 signed");
    expect(out).toContain("## Timeline\n- signed");
  });

  it("new-section-after inserts a heading at the same level after the whole section", () => {
    const out = applyPatches(BODY, [
      { op: "new-section-after", after: "Notes", heading: "Scope", text: "Audit only." },
    ]);
    expect(out).toContain("- Met at a fair.\n\n## Scope\nAudit only.\n\n## Timeline");
  });

  it("new-section-after refuses a heading that already exists", () => {
    expect(
      code(() => applyPatches(BODY, [{ op: "new-section-after", after: "Notes", heading: "timeline" }])),
    ).toBe("invalid_argument");
  });

  it("refuses an unknown section and a multi-line bullet", () => {
    expect(code(() => applyPatches(BODY, [{ op: "append-bullet", section: "Nope", text: "x" }]))).toBe(
      "invalid_argument",
    );
    expect(
      code(() => applyPatches(BODY, [{ op: "append-bullet", section: "Notes", text: "a\nb" }])),
    ).toBe("invalid_argument");
  });

  it("applies patches in order and leaves the input untouched", () => {
    const input = BODY;
    const out = applyPatches(input, [
      { op: "new-section-after", after: "Summary", heading: "Contacts" },
      { op: "append-bullet", section: "Contacts", text: "Bob" },
    ]);
    expect(input).toBe(BODY);
    expect(out).toContain("## Contacts\n- Bob\n\n## Notes");
  });
});
