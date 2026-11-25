import { describe, it, expect } from "vitest";
import { PROVIDERS, providerFor, sourceTags, MAX_TAGS } from "../../src/sources/index.js";
import { chatProvider } from "../../src/sources/providers/chat.js";

describe("tag providers", () => {
  it("has one provider per MVP source, each with how-to-read text", () => {
    expect([...PROVIDERS.keys()].sort()).toEqual(["calendar", "claude-code", "drive", "fireflies", "gmail"]);
    for (const p of PROVIDERS.values()) {
      expect(p.howToRead.length).toBeGreaterThan(10);
      expect(p.source).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });

  it("an unknown source has no provider and keeps no tags", () => {
    expect(providerFor("slack")).toBeNull();
    expect(sourceTags("slack", [{ id: "C1", name: "general", kind: "channel" }])).toEqual([]);
  });

  it("gmail keeps labels a person made and drops system labels", () => {
    const tags = sourceTags("gmail", [
      { id: "INBOX", name: "INBOX", kind: "label" },
      { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS" },
      { id: "UNREAD" },
      { name: "Starred" },
      { id: "Label_12", name: "Clients/Acme", kind: "label" },
      { id: "Label_12", name: "Clients/Acme" },
    ]);
    expect(tags).toEqual([{ kind: "label", id: "Label_12", name: "Clients/Acme" }]);
  });

  it("gmail uses the name as the id when the connector gives names only", () => {
    expect(sourceTags("gmail", [{ name: "Board" }])).toEqual([{ kind: "label", id: "Board", name: "Board" }]);
  });

  it("drive keeps parent folders and reads kx/ tags out of a description", () => {
    const tags = sourceTags("drive", [
      { kind: "folder", id: "fold-1", name: "Clients" },
      { kind: "description", name: "Signed copies. kx/consulting and KX/Board" },
      { kind: "owner", id: "x", name: "someone" },
    ]);
    expect(tags).toEqual([
      { kind: "folder", id: "fold-1", name: "Clients" },
      { kind: "description_tag", id: "kx/consulting", name: "kx/consulting" },
      { kind: "description_tag", id: "kx/board", name: "kx/board" },
    ]);
  });

  it("drive needs a folder id", () => {
    expect(sourceTags("drive", [{ kind: "folder", name: "No id" }])).toEqual([]);
  });

  it("fireflies keeps channels", () => {
    expect(sourceTags("fireflies", [{ id: "ch-1", name: "Sales Calls" }, { name: "" }])).toEqual([
      { kind: "channel", id: "ch-1", name: "Sales Calls" },
    ]);
  });

  it("calendar has no tags: its items stay with their owner", () => {
    expect(sourceTags("calendar", [{ id: "x", name: "Work" }])).toEqual([]);
  });

  it("claude-code keeps one project tag per session, named by its folder", () => {
    expect(sourceTags("claude-code", [
      { kind: "project", id: "Demo-Project", name: "Demo-Project" },
      { kind: "project", name: "demo-project" },
      { kind: "folder", id: "x", name: "Not a project" },
      { kind: "project", name: "  " },
    ])).toEqual([{ kind: "project", id: "demo-project", name: "Demo-Project" }]);
    expect(providerFor("claude-code")?.kinds).toEqual(["project"]);
  });

  it("the chat provider is shared, so a later Claude.ai source reuses it", () => {
    const later = chatProvider("claude-ai");
    expect(later.source).toBe("claude-ai");
    expect(later.normalize([{ kind: "project", name: "Board prep" }])).toEqual([{ kind: "project", id: "board prep", name: "Board prep" }]);
  });

  it("trims, cuts long names and caps the count", () => {
    const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => ({ id: `ch-${i}`, name: ` Channel ${i} ` }));
    const tags = sourceTags("fireflies", many);
    expect(tags).toHaveLength(MAX_TAGS);
    expect(tags[0]).toEqual({ kind: "channel", id: "ch-0", name: "Channel 0" });
    const long = sourceTags("fireflies", [{ id: "c", name: "n".repeat(500) }]);
    expect(long[0]?.name).toHaveLength(200);
  });

  it("is deterministic: the same input gives the same tags", () => {
    const raw = [{ id: "Label_1", name: "A" }, { id: "Label_2", name: "B" }];
    expect(sourceTags("gmail", raw)).toEqual(sourceTags("gmail", raw));
  });
});
