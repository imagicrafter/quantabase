import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateEngineConfig } from "../../src/config/engine-config.js";
import { buildInstructions } from "../../src/mcp/instructions.js";

const example = () =>
  parse(
    readFileSync(
      new URL("../../../config/engine.example.yaml", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;

describe("MCP instructions", () => {
  it("names the Engine from the config", () => {
    const text = buildInstructions(validateEngineConfig(example()));
    expect(text).toContain("the knowledge base of Acme's Knowledge Base Engine");
  });

  it("uses a different name when the config changes", () => {
    const raw = example();
    const cfg = validateEngineConfig({
      ...raw,
      engine: { ...(raw["engine"] as object), name: "Birch Lane Engine" },
    });
    const text = buildInstructions(cfg);
    expect(text).toContain("Birch Lane Engine");
    expect(text).not.toContain("Acme");
  });

  it("lists open topics by label and only counts restricted ones", () => {
    const text = buildInstructions(validateEngineConfig(example()));
    expect(text).toContain(
      "Topics include: Consulting, Rental Properties, plus 1 restricted topic that needs an explicit grant.",
    );
    expect(text).not.toContain("Private");
  });

  it("leaves out sources that are turned off", () => {
    const raw = example();
    const sources = raw["sources"] as Record<string, Record<string, unknown>>;
    const cfg = validateEngineConfig({
      ...raw,
      sources: {
        ...sources,
        drive: { ...sources["drive"], enabled: false },
        gmail: { ...sources["gmail"], enabled: true },
      },
    });
    const text = buildInstructions(cfg);
    expect(text).not.toContain("**drive**");
    expect(text).toContain("**gmail**");
    expect(text).toContain("**wiki**");
  });

  it("still describes the tools when no config has been applied", () => {
    const text = buildInstructions(null);
    expect(text).toContain("the knowledge base of this Quantabase");
    expect(text).toContain("**search(query");
    expect(text).toContain("Topics are set by the Engine's owner.");
  });
});
