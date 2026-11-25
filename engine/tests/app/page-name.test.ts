import { describe, expect, it } from "vitest";
import { cleanDisplayName, cleanPageName, defaultPageName, PAGE_NAME_MAX } from "../../src/app/page-name.js";

describe("the name used on pages", () => {
  it("is trimmed", () => {
    expect(cleanPageName("  Ann  ")).toEqual({ ok: true, value: "Ann" });
  });

  it("is 1 to 60 characters", () => {
    expect(cleanPageName("a".repeat(PAGE_NAME_MAX))).toEqual({ ok: true, value: "a".repeat(60) });
    expect(cleanPageName("a".repeat(61)).ok).toBe(false);
  });

  it("empty means none (the default), unless a name is required", () => {
    expect(cleanPageName("   ")).toEqual({ ok: true, value: null });
    expect(cleanPageName(undefined)).toEqual({ ok: true, value: null });
    expect(cleanPageName("", { required: true }).ok).toBe(false);
  });

  it("refuses line breaks and control characters", () => {
    for (const bad of ["Ann\nB", "Ann\rB", "Ann\tB", "Ann\u0007", "Ann\u2028B", "Ann\u0085B"]) {
      expect(cleanPageName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses something that is not text", () => {
    expect(cleanPageName(["Ann"]).ok).toBe(false);
  });

  it("says what is wrong in plain words", () => {
    const r = cleanPageName("a".repeat(61));
    expect(r.ok ? "" : r.error).toMatch(/1 to 60 characters/);
  });
});

describe("the display name", () => {
  it("is 1 to 120 characters on one line", () => {
    expect(cleanDisplayName(" Ann Example ")).toEqual({ ok: true, value: "Ann Example" });
    expect(cleanDisplayName("").ok).toBe(false);
    expect(cleanDisplayName("a".repeat(121)).ok).toBe(false);
    expect(cleanDisplayName("Ann\nExample").ok).toBe(false);
  });
});

describe("the default page name", () => {
  it("is the display name unless that is an email", () => {
    expect(defaultPageName("Ann Example")).toBe("Ann Example");
    expect(defaultPageName("ann@example.com")).toBeNull();
    expect(defaultPageName("  ")).toBeNull();
    expect(defaultPageName(null)).toBeNull();
  });
});
