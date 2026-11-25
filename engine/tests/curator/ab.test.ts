import { describe, expect, it, vi } from "vitest";
import { blindPair, runAb, snapshotStore, type SnapshotPage } from "../../src/eval/ab.js";
import type { ModelBackend } from "../../src/curator/model.js";
import { entitySchema } from "../../src/entities/templates.js";

/** The blind A/B harness, with a mocked model (no live calls). */

const schema = entitySchema(["consulting"]);
const PAGES: SnapshotPage[] = [
  { key: "pat@northwind.example", drawer: "people", title: "Pat Rivera", fields: { organisation: "northwind.example" },
    body: "# Pat Rivera\n\n## Summary\nCOO.\n\n## Timeline\n- 2026-11-01: first call.\n" },
];

function backend(...replies: unknown[]): ModelBackend & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce({ text: JSON.stringify(r), finish: "stop", inputTokens: 1, outputTokens: 1 });
  return { complete };
}

describe("A/B harness", () => {
  it("curates each item against the same snapshot and writes the proposed lines as Markdown", async () => {
    const model = backend(
      { updates: [{ key: "pat@northwind.example", patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: Pat confirmed the pilot." }] }], new_pages: [] },
      { updates: [], new_pages: [], notes: "nothing durable: a thank-you" },
    );
    const out = await runAb([
      { id: "one", title: "Pilot", body: "From: pat@northwind.example\n\nConfirmed the pilot." },
      { id: "two", title: "Thanks", body: "From: pat@northwind.example\n\nThanks!" },
    ], PAGES, { schema, model, modelName: "mock" });
    expect(out.get("one")).toContain("### Update: people/pat@northwind.example (Pat Rivera)");
    expect(out.get("one")).toContain("+ - 2026-11-19: Pat confirmed the pilot.");
    expect(out.get("two")).toContain("Outcome: no_change (nothing durable: a thank-you)");
    expect(out.get("two")).toContain("No change.");
  });

  it("the snapshot store never changes the snapshot", async () => {
    const s = snapshotStore(PAGES);
    await s.store.savePage("i", { key: "pat@northwind.example", body: "changed" }, "snap-pat@northwind.example");
    expect(PAGES[0]!.body).toContain("first call");
    expect(s.proposals[0]!.kind).toBe("update");
  });

  it("pairs two versions blind; the key is separate", () => {
    const p = blindPair("one", "Outcome: applied\ncurator text", "update-docs text", false);
    expect(p.text).not.toContain("Outcome:");
    expect(p.text).toContain("## Version A\n\nupdate-docs text");
    expect(p.text.indexOf("update-docs text")).toBeLessThan(p.text.indexOf("curator text"));
    expect(p.text).not.toMatch(/Version (curator|other)/);
    expect(p.key).toBe("A=other B=curator");
  });
});
