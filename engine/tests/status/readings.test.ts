import { describe, it, expect } from "vitest";
import { ago, worst } from "../../src/status/readings.js";

describe("helpers", () => {
  it("worst light wins; grey only alone", () => {
    expect(worst(["green", "amber", "grey"])).toBe("amber");
    expect(worst(["green", "red", "amber"])).toBe("red");
    expect(worst([])).toBe("grey");
    expect(worst(["grey", "grey"])).toBe("grey");
  });

  it("ago", () => {
    const now = new Date("2026-11-06T20:00:00Z");
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-11-06T19:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-06T19:00:00Z", now)).toBe("60m ago");
    expect(ago("2026-11-06T14:00:00Z", now)).toBe("6h ago");
    expect(ago("2026-11-03T20:00:00Z", now)).toBe("3d ago");
  });
});
